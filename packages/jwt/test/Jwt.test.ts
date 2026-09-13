// .scratch/jwt/issues/08-sign-and-verify.md — sign a principal, verify the
// result succeeds with every claim correct; a tampered signature fails;
// an expired token fails (`TestClock`-driven).
import { Api } from "@effect-auth/api";
import { Sessions, Users } from "@effect-auth/core";
import { Authentication } from "@effect-auth/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { Jwt, JwtConfig, KeyRing, SigningKeyRecords } from "../src/index.ts";

/**
 * `Jwt.layer` now bundles the `jwt.token` mint endpoint's handlers
 * (ticket 10), which require `Api.Authentication` to discharge — even for
 * these service-level tests, which never go over HTTP and never actually
 * invoke that middleware. Mirrors `packages/organization/test/Organization.test.ts`'s
 * own identical fix for the identical reason.
 */
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const asCaller = (input: {
  readonly id: string;
  readonly sessionId: string;
  readonly actingAs?: { readonly type: string; readonly id: string };
}): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: input.id }),
    sessionId: input.sessionId,
    ...(input.actingAs === undefined ? {} : { actingAs: new Api.PrincipalRef(input.actingAs) }),
  });

const buildLayer = (overrides?: Partial<JwtConfig.JwtConfigShape>) =>
  Jwt.Jwt.layer.pipe(
    Layer.provide(KeyRing.KeyRing.layer),
    Layer.provide(SigningKeyRecords.layerMemory),
    Layer.provide(AuthenticationLive),
    // `provideMerge`, not `provide`: `verifyLive` (ticket 12) requires
    // `Sessions` at its own call site, not captured in `make` — the test
    // body needs the same `Sessions` instance exposed too, both to issue/
    // revoke a real session and to satisfy `jwt.verifyLive`'s own `R`.
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provide(NodeCrypto.layer),
    // last: both `Jwt.layer` and `KeyRing.layer` independently need
    // `JwtConfig` — `Layer.provide` folds each step's own open
    // requirement forward, so one final provide here discharges both.
    Layer.provide(JwtConfig.config({ issuer: "https://issuer.test", ...overrides })),
  );

describe("Jwt sign/verify", () => {
  it.effect("signs a caller and verifies every claim", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const caller = asCaller({ id: "user-1", sessionId: "session-1" });

      const token = yield* jwt.sign(caller);
      const claims = yield* jwt.verify(token);

      assert.strictEqual(claims["sub"], "user-1");
      assert.strictEqual(claims["sid"], "session-1");
      assert.strictEqual(claims["iss"], "https://issuer.test");
      assert.strictEqual(claims["aud"], "https://issuer.test");
      assert.isUndefined(claims["act"]);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("populates act when the caller is impersonating", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const caller = asCaller({
        id: "admin-1",
        sessionId: "session-1",
        actingAs: { type: "user", id: "target-1" },
      });

      const token = yield* jwt.sign(caller);
      const claims = yield* jwt.verify(token);

      assert.deepStrictEqual(claims["act"], { type: "user", id: "target-1" });
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a tampered signature fails verification", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const caller = asCaller({ id: "user-1", sessionId: "session-1" });

      const token = yield* jwt.sign(caller);
      const segments = token.split(".");
      const tampered = `${segments[0]}.${segments[1]}.${segments[2]?.slice(0, -2)}aa`;

      const result = yield* jwt.verify(tampered).pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("verification fails once the token's ttl has elapsed", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const caller = asCaller({ id: "user-1", sessionId: "session-1" });

      const token = yield* jwt.sign(caller);
      yield* TestClock.adjust(Duration.minutes(16));

      const result = yield* jwt.verify(token).pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildLayer({ ttl: Duration.minutes(15) }))),
  );

  it.effect("extra claims from definePayload never override registered claims", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const caller = asCaller({ id: "user-1", sessionId: "session-1" });

      const token = yield* jwt.sign(caller);
      const claims = yield* jwt.verify(token);

      assert.strictEqual(claims["sub"], "user-1");
      assert.strictEqual(claims["tenant"], "acme");
    }).pipe(
      Effect.provide(
        buildLayer({
          definePayload: () => Effect.succeed({ tenant: "acme", sub: "should-be-ignored" }),
        }),
      ),
    ),
  );
});

// .scratch/jwt/issues/12-live-revocation-check.md — `verify` keeps
// accepting a token whose underlying session has since been revoked (the
// documented, deliberate weakening); `verifyLive` re-anchors to the live
// session store and stops accepting it.
describe("Jwt verifyLive", () => {
  it.effect("verify still succeeds after revocation; verifyLive does not", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const sessions = yield* Sessions.Sessions;
      const issued = yield* sessions.issue({ userId: Users.UserId("user-1") });

      const caller = asCaller({ id: "user-1", sessionId: issued.session.id });
      const token = yield* jwt.sign(caller);

      const beforeRevoke = yield* jwt.verifyLive(token);
      assert.strictEqual(beforeRevoke["sub"], "user-1");

      yield* sessions.revoke(issued.session.id);

      const stillVerifies = yield* jwt.verify(token);
      assert.strictEqual(stillVerifies["sub"], "user-1");

      const liveCheckFails = yield* jwt.verifyLive(token).pipe(Effect.flip);
      assert.strictEqual(liveCheckFails._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("verifyLive fails for a token with no sid to check (signJWT-minted)", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "service-a" });

      const result = yield* jwt.verifyLive(token).pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildLayer())),
  );
});

// .scratch/jwt/issues/14-general-purpose-primitives.md — arbitrary-payload
// signing/verification, not tied to any `Principal`, reusing `sign`'s own
// key/rotation machinery via the shared `signClaims` helper.
describe("Jwt signJWT/verifyJWT", () => {
  it.effect("signs and verifies an arbitrary payload unrelated to any session", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "service-a", scope: "read:things" });
      const claims = yield* jwt.verifyJWT(token);

      assert.strictEqual(claims["sub"], "service-a");
      assert.strictEqual(claims["scope"], "read:things");
    }).pipe(Effect.provide(buildLayer())),
  );

  // `definePayload` is principal-scoped and `signJWT` has no principal, so
  // it is not consulted for `signJWT` (documented deviation from ticket
  // 14's literal wording — see this ticket's own `## Result`). What does
  // still hold, exactly as it does for `sign`, is that registered claims
  // always win over anything the caller supplies.
  it.effect("registered claims always win over the caller's own payload", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "service-a", iss: "attacker-supplied" });
      const claims = yield* jwt.verifyJWT(token);

      assert.strictEqual(claims["iss"], "https://issuer.test");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("options.ttl overrides the configured default for one call", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "service-a" }, { ttl: Duration.minutes(1) });
      yield* TestClock.adjust(Duration.minutes(2));

      const result = yield* jwt.verifyJWT(token).pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildLayer())),
  );
});
