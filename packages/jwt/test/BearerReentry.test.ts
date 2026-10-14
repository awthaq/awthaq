// MAPS-001/NAM-001 (wayfinder ticket 33): a JWT this plugin minted re-entering
// the issuing API as `Authorization: Bearer`, opt-in via `JwtConfig.acceptAsBearer`,
// verified statelessly through `Authentication`'s bearer-credential registry.
// `POST /jwt/token` is the authenticated endpoint used as the probe: it answers
// 200 only when `Authentication` resolved a principal.
import { Api } from "@awthaq/api";
import { AuditLog, Auth, AuthEvents, Hooks, Persistence, Sessions, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Jwt from "../src/Jwt.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import { SigningKeyRecordsLive } from "./support.ts";

const ORIGIN = "http://localhost:3000";

/**
 * The stateless deployment recipe (NAM-001) through `TestAuth.layer(Auth.make([Jwt]))`: in-memory stores, the
 * derived `Authentication` and the credential-resolver registry the `acceptAsBearer` contribution registers into.
 */
const appLayer = (config: Parameters<typeof JwtConfig.config>[0]) =>
  TestAuth.layer(Auth.make([Jwt.Jwt]), { services: JwtConfig.config(config) });

const harness = (config: Parameters<typeof JwtConfig.config>[0]) => {
  const app = TestAuth.app(appLayer(config), { baseUrl: ORIGIN });
  const { handler } = app;
  const withContext = app.run;
  const userId = Users.UserId("55555555-5555-5555-5555-555555555555");
  const issueSession = () =>
    withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId });
        return { sessionId: issued.session.id, token: Redacted.value(issued.token) };
      }),
    );
  /** A real principal JWT for that session, as `POST /jwt/token` would mint it. */
  const mintFor = (sessionId: string) =>
    withContext(
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        return yield* jwt.sign(
          new Api.UserPrincipal({
            ref: new Api.PrincipalRef({ type: "user", id: userId }),
            sessionId,
          }),
        );
      }),
    );
  const probe = (headers: Record<string, string>) =>
    handler(new Request(`${ORIGIN}/jwt/token`, { method: "POST", headers }));
  return { handler, withContext, issueSession, mintFor, probe, userId };
};

describe("JWT bearer re-entry (MAPS-001/NAM-001)", () => {
  it("acceptAsBearer: true — a minted JWT authenticates as a bearer, statelessly", async () => {
    const { issueSession, mintFor, probe } = harness({
      issuer: "https://issuer.test",
      acceptAsBearer: true,
    });
    const { sessionId } = await issueSession();
    const jwt = await mintFor(sessionId);
    const response = await probe({ authorization: `Bearer ${jwt}` });
    assert.strictEqual(response.status, 200);
  });

  it("acceptAsBearer: true — the JWT needs no session row (no session-store round trip)", async () => {
    const { mintFor, probe } = harness({ issuer: "https://issuer.test", acceptAsBearer: true });
    // `sid` names a session that never existed: only a stateless check can accept this.
    const jwt = await mintFor("00000000-0000-7000-8000-000000000000");
    const response = await probe({ authorization: `Bearer ${jwt}` });
    assert.strictEqual(response.status, 200);
  });

  it("acceptAsBearer: true — a revoked session's JWT keeps working until exp (the documented lag)", async () => {
    const { issueSession, mintFor, probe, withContext } = harness({
      issuer: "https://issuer.test",
      acceptAsBearer: true,
    });
    const { sessionId } = await issueSession();
    const jwt = await mintFor(sessionId);
    await withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        yield* sessions.revoke(Sessions.SessionId(sessionId), "admin");
      }),
    );
    const response = await probe({ authorization: `Bearer ${jwt}` });
    assert.strictEqual(response.status, 200);
  });

  it("default (acceptAsBearer off) — the same JWT answers 401", async () => {
    const { issueSession, mintFor, probe } = harness({ issuer: "https://issuer.test" });
    const { sessionId } = await issueSession();
    const jwt = await mintFor(sessionId);
    const response = await probe({ authorization: `Bearer ${jwt}` });
    assert.strictEqual(response.status, 401);
  });

  it("acceptAsBearer: true — a token minted for another audience never re-enters", async () => {
    const { issueSession, withContext, probe } = harness({
      issuer: "https://issuer.test",
      acceptAsBearer: true,
    });
    const { sessionId } = await issueSession();
    const downstream = await withContext(
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        // Same claims a principal token carries, but for `inventory-service`.
        return yield* jwt.signJWT(
          { sub: "someone", sid: sessionId },
          { audience: "inventory-service", typ: "at+jwt" },
        );
      }),
    );
    const response = await probe({ authorization: `Bearer ${downstream}` });
    assert.strictEqual(response.status, 401);
  });

  it("acceptAsBearer: true — an expired JWT answers 401", async () => {
    const { issueSession, withContext, probe } = harness({
      issuer: "https://issuer.test",
      acceptAsBearer: true,
    });
    const { sessionId } = await issueSession();
    const expired = await withContext(
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        return yield* jwt.sign(
          new Api.UserPrincipal({
            ref: new Api.PrincipalRef({ type: "user", id: "someone" }),
            sessionId,
          }),
          { ttl: Duration.seconds(-30) },
        );
      }),
    );
    const response = await probe({ authorization: `Bearer ${expired}` });
    assert.strictEqual(response.status, 401);
  });

  it("acceptAsBearer: true — an opaque session bearer still resolves through Sessions", async () => {
    const { issueSession, probe } = harness({
      issuer: "https://issuer.test",
      acceptAsBearer: true,
    });
    const { token } = await issueSession();
    const response = await probe({ authorization: `Bearer ${token}` });
    assert.strictEqual(response.status, 200);
  });

  // Hand-wired on purpose: the registry's ABSENCE is the wiring under test, and `TestAuth.layer` always derives it
  // (plan 08 exemption). The principal resolver is a stub: nothing here resolves a principal.
  it.effect(
    "acceptAsBearer without the credential registry in the composition fails the build",
    () =>
      Effect.gen(function* () {
        const NoResolver = Layer.succeed(
          Authentication.PrincipalResolver,
          Authentication.PrincipalResolver.of({ resolve: () => Effect.die("not used") }),
        );
        const withoutRegistry = Jwt.Jwt.layer.pipe(
          Layer.provideMerge(Authentication.AuthenticationLive.pipe(Layer.provide(NoResolver))),
          Layer.provideMerge(KeyRing.KeyRing.layer),
          Layer.provideMerge(SigningKeyRecordsLive),
          Layer.provideMerge(SqlTransaction.layerNoop),
          Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provideMerge(AuthEvents.layer),
          Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provideMerge(Hooks.HooksLive),
          Layer.provideMerge(RevocationStore.layerMemory),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(
            JwtConfig.config({ issuer: "https://issuer.test", acceptAsBearer: true }),
          ),
        );
        const exit = yield* Effect.exit(Layer.build(withoutRegistry));
        assert.isTrue(exit._tag === "Failure");
      }).pipe(Effect.scoped),
  );
});
