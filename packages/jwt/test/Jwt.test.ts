// .scratch/jwt/issues/08-sign-and-verify.md — sign a principal, verify the
// result succeeds with every claim correct; a tampered signature fails;
// an expired token fails (`TestClock`-driven).
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import { SqlTransaction } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Jwt from "../src/Jwt.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

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
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(AuthenticationLive),
    // `provideMerge`, not `provide`: `verifyLive` (ticket 12) requires
    // `Sessions` at its own call site, not captured in `make` — the test
    // body needs the same `Sessions` instance exposed too, both to issue/
    // revoke a real session and to satisfy `jwt.verifyLive`'s own `R`.
    Layer.provideMerge(Sessions.layerMemory),
    // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    // TIR-001: `RevocationStore` is captured once in `make` now (not a
    // per-call `R` the way `Sessions` is), so this discharges it for the
    // whole plugin rather than merely exposing it to the test body.
    Layer.provideMerge(RevocationStore.layerMemory),
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

      // JR-005: RFC 8693 §4.1 — the actor is identified by `sub`; its principal
      // type is a private member.
      assert.deepStrictEqual(claims["act"], { sub: "target-1", awthaq_actor_type: "user" });
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

      yield* sessions.revoke(issued.session.id, "admin");

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

  // TIR-002: `verifyLive` used to compare only `SessionListItem.expiresAt`
  // (`Sessions.list`'s own single deadline, always `absoluteExpiresAt`),
  // so an idle-expired-but-absolute-live session kept passing. The
  // session's default config (`absolute: 30d`/`idle: 7d`) means 8 elapsed
  // days is idle-expired but nowhere near absolute-expired — a JWT `ttl`
  // override is needed too, since the default 15-minute `ttl` would
  // already fail plain `verify` at 8 days, masking which check actually
  // fired. Asserting the specific `reason` (not just the error's `_tag`)
  // is what proves this is the live-check branch, not e.g. a signature or
  // basic-expiry failure.
  it.effect(
    "verifyLive fails for an idle-expired session even though absolute expiry is far off",
    () =>
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId("user-2") });
        const caller = asCaller({ id: "user-2", sessionId: issued.session.id });
        const token = yield* jwt.sign(caller);

        yield* TestClock.adjust(Duration.days(8));

        const liveCheckFails = yield* jwt.verifyLive(token).pipe(Effect.flip);
        if (liveCheckFails._tag !== "JwtInvalidError") return assert.fail(liveCheckFails._tag);
        assert.strictEqual(liveCheckFails.reason, "session no longer live");
      }).pipe(Effect.provide(buildLayer({ ttl: Duration.days(30) }))),
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

// TIR-001/TRBS-001/MAPS-002 — .scratch/resolve-ready-for-human-findings/
// issues/11-token-lifecycle-store.md. `verify`/`verifyJWT` stay unchanged
// (still revocation-lagging by design, still `R = never`); `introspect`/
// `introspectLive` are the new, opt-in denylist-aware path.
describe("Jwt introspect/introspectLive", () => {
  it.effect("every minted token carries a jti claim", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const caller = asCaller({ id: "user-1", sessionId: "session-1" });
      const token = yield* jwt.sign(caller);
      const claims = yield* jwt.verify(token);
      assert.isString(claims["jti"]);
      assert.isAbove((claims["jti"] as string).length, 0);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("introspect reports active:true with claims for a fresh, unrevoked token", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "service-a" });
      const result = yield* jwt.introspect(token);
      assert.isTrue(result.active);
      if (result.active) assert.strictEqual(result.claims["sub"], "service-a");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("introspect reports active:false for a revoked token's jti", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const revocationStore = yield* RevocationStore.RevocationStore;
      const token = yield* jwt.signJWT({ sub: "service-a" });
      const claims = yield* jwt.verifyJWT(token);
      const jti = claims["jti"] as string;

      const beforeRevoke = yield* jwt.introspect(token);
      assert.isTrue(beforeRevoke.active);

      const exp = claims["exp"] as number;
      yield* revocationStore.revoke(jti, DateTime.fromEpochSeconds(exp));

      const afterRevoke = yield* jwt.introspect(token);
      assert.isFalse(afterRevoke.active);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("introspect reports active:false for a bad signature or expired token", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;

      const token = yield* jwt.signJWT({ sub: "service-a" });
      const segments = token.split(".");
      const tampered = `${segments[0]}.${segments[1]}.${segments[2]?.slice(0, -2)}aa`;
      const tamperedResult = yield* jwt.introspect(tampered);
      assert.isFalse(tamperedResult.active);

      const expiring = yield* jwt.signJWT({ sub: "service-a" }, { ttl: Duration.minutes(1) });
      yield* TestClock.adjust(Duration.minutes(2));
      const expiredResult = yield* jwt.introspect(expiring);
      assert.isFalse(expiredResult.active);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("introspectLive reports active:true for a token whose session is still live", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const sessions = yield* Sessions.Sessions;
      const issued = yield* sessions.issue({ userId: Users.UserId("user-1") });
      const caller = asCaller({ id: "user-1", sessionId: issued.session.id });
      const token = yield* jwt.sign(caller);

      const result = yield* jwt.introspectLive(token);
      assert.isTrue(result.active);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("introspectLive reports active:false once the underlying session is revoked", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const sessions = yield* Sessions.Sessions;
      const issued = yield* sessions.issue({ userId: Users.UserId("user-1") });
      const caller = asCaller({ id: "user-1", sessionId: issued.session.id });
      const token = yield* jwt.sign(caller);

      yield* sessions.revoke(issued.session.id, "admin");

      // `introspect` alone (no session-liveness check) still sees it
      // active — the same deliberate distinction `verify`/`verifyLive`
      // already draw.
      const introspectOnly = yield* jwt.introspect(token);
      assert.isTrue(introspectOnly.active);

      const live = yield* jwt.introspectLive(token);
      assert.isFalse(live.active);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "introspectLive reports active:true for a token with no sid to check (signJWT-minted)",
    () =>
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        const token = yield* jwt.signJWT({ sub: "service-a" });
        const result = yield* jwt.introspectLive(token);
        assert.isTrue(result.active);
      }).pipe(Effect.provide(buildLayer())),
  );
});
