// MAPS-001/NAM-001 (wayfinder ticket 33): a JWT this plugin minted re-entering
// the issuing API as `Authorization: Bearer`, opt-in via `JwtConfig.acceptAsBearer`,
// verified statelessly through `Authentication`'s bearer-credential registry.
// `GET /jwt/token` is the authenticated endpoint used as the probe: it answers
// 200 only when `Authentication` resolved a principal.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Jwt from "../src/Jwt.ts";
import * as JwtApi from "../src/JwtApi.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

const ORIGIN = "http://localhost:3000";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

/**
 * The stateless deployment recipe (NAM-001): only in-memory stores, no SQL. The
 * registry sits below `Jwt.layer` so the `acceptAsBearer` contribution can find it.
 */
const appLayer = (config: Parameters<typeof JwtConfig.config>[0], withRegistry = true) =>
  AuthHttp.routes(JwtApi.JwtApi).pipe(
    Layer.provideMerge(Jwt.Jwt.layer),
    Layer.provideMerge(AuthenticationLive),
    Layer.provideMerge(withRegistry ? Authentication.CredentialResolversLive : Layer.empty),
    Layer.provideMerge(KeyRing.KeyRing.layer),
    Layer.provideMerge(SigningKeyRecords.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(RevocationStore.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(JwtConfig.config(config)),
  );

const harness = (config: Parameters<typeof JwtConfig.config>[0]) => {
  const layer = appLayer(config);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(layer, { memoMap });
  const withContext = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(layer, memoMap, scope);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ),
    );
  const userId = Users.UserId("55555555-5555-5555-5555-555555555555");
  const issueSession = () =>
    withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId });
        return { sessionId: issued.session.id, token: Redacted.value(issued.token) };
      }),
    );
  /** A real principal JWT for that session, as `GET /jwt/token` would mint it. */
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
    handler(new Request(`${ORIGIN}/jwt/token`, { headers }));
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

  it.effect(
    "acceptAsBearer without the credential registry in the composition fails the build",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Layer.build(appLayer({ issuer: "https://issuer.test", acceptAsBearer: true }, false)),
        );
        assert.isTrue(exit._tag === "Failure");
      }).pipe(Effect.scoped),
  );
});
