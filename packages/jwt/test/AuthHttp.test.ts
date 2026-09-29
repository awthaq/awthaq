// .scratch/jwt/issues/09-jwks-endpoint.md, 10-explicit-mint-endpoint.md —
// the `jwt`/`jwt.token` groups exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler`, real HTTP request/response, mirroring every
// other plugin's own `AuthHttp.test.ts`. `jwks` needs no `Authentication`
// middleware/session at all — it is public by definition; `token` does,
// mirroring `packages/organization/test/AuthHttp.test.ts`'s own
// `issueSessionCookieHeader` pattern for setting one up.
import { AuthCore } from "@awthaq/api";
import { Accounts, AuditLog, Hooks, AuthEvents, Sessions, Users, Verification } from "@awthaq/core";
import { Account, Authentication, AuthHttp, Csrf, Session } from "@awthaq/server";
import { SqlTransaction } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { TestAuth } from "@awthaq/test";
import * as Jwt from "../src/Jwt.ts";
import * as JwtApi from "../src/JwtApi.ts";
import * as JwtCodec from "../src/JwtCodec.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

/**
 * `Jwt`'s own `jwt`/`jwt.token` groups are GET-only and were deliberately
 * NOT given `Api.CsrfProtection` (CSRF only ever rejects unsafe methods,
 * BEH-EA-077), so the plain `AppLayer` below (JwtApi alone) never needs
 * this. `CrossPluginAppLayer` further down composes `AuthCore.AuthCoreApi`
 * (`SessionGroup`/`AccountGroup`, both now CSRF-protected) alongside it, so
 * only that layer needs it.
 */
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("jwt-authhttp-test-csrf-secret"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const AppLayer = Layer.mergeAll(
  AuthHttp.routes(JwtApi.JwtApi, { openapiPath: "/openapi.json" }),
  AuthHttp.docs(JwtApi.JwtApi),
).pipe(
  // `Jwt.Jwt.layer` and `AuthenticationLive` are merged in here, at the
  // shared outer level, via `provideMerge` (not `provide` locally inside
  // the branch above) — `provide` discards `Jwt.Jwt.layer`'s own output
  // once it's used to satisfy `AuthHttp.routes`'s requirement, which would
  // silently drop its `PostAuthResponseHook` override (ticket 16) from
  // ever reaching the final built context, even though `Authentication.ts`
  // now resolves that hook per request precisely so it CAN be reached this
  // way.
  Layer.provideMerge(Jwt.Jwt.layer),
  Layer.provideMerge(AuthenticationLive),
  Layer.provideMerge(KeyRing.KeyRing.layer),
  Layer.provideMerge(SigningKeyRecords.layerMemory),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(Sessions.layerMemory),
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  // TIR-001: `RevocationStore` is captured once in `Jwt`'s own `make`
  // now, so it must be provided for the plugin to build at all.
  Layer.provideMerge(RevocationStore.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
  // last: `Jwt.layer` and `KeyRing.layer` both independently need
  // `JwtConfig` — one provideMerge here, after both are already folded in,
  // discharges it for the whole tree at once.
  Layer.provideMerge(JwtConfig.config({ issuer: "https://issuer.test" })),
);

const ORIGIN = "http://localhost:3000";

const buildHandler = () => {
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

  // Reused by both helpers below so they resolve services from the exact
  // same built layer instance `handler` itself runs against — a second,
  // independently-built `AppLayer` would mint a *different* `KeyRing`'s
  // keys, unable to verify a token `handler` actually signed.
  const withAppContext = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof AppLayer>>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ),
    );

  /** Mirrors `@awthaq/organization`'s own `AuthHttp.test.ts`: a real session cookie against the same running `Sessions` instance. */
  const issueSessionCookieHeader = (userId: string): Promise<string> =>
    withAppContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
      }),
    );

  /** TIR-007: a second, separate session for the same user, plus a way to revoke one by its id. */
  const issueSession = (userId: string) =>
    withAppContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return {
          cookie: `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`,
          sessionId: issued.session.id,
        };
      }),
    );

  const revokeSession = (sessionId: Sessions.SessionId): Promise<void> =>
    withAppContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        yield* sessions.revoke(sessionId);
      }),
    );

  /** TIR-001: denylists `jti` directly against the same `RevocationStore` instance `/jwt/introspect`'s handler reads. */
  const revokeJti = (jti: string, expiresAt: DateTime.Utc): Promise<void> =>
    withAppContext(
      Effect.gen(function* () {
        const revocationStore = yield* RevocationStore.RevocationStore;
        yield* revocationStore.revoke(jti, expiresAt);
      }),
    );

  /**
   * `Jwt.Jwt` itself is a dependency `AuthHttp.routes` discharges, not an
   * output `AppLayer` exposes, so it can't be `yield*`-ed back out of
   * `withAppContext` the way `Sessions` can — fetching real JWKS over the
   * same `handler` and verifying with `JwtCodec` directly (the exact
   * module `Jwt.verify` itself wraps, per ticket 08) is genuinely
   * wire-level rather than a workaround.
   */
  const verifyToken = (token: string): Promise<Record<string, unknown>> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const jwksResponse = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/jwt/jwks`)),
        );
        const jwks = (yield* Effect.promise(() => jwksResponse.json())) as {
          keys: ReadonlyArray<{ readonly kid: string; readonly alg: JwtCodec.Algorithm }>;
        };
        return yield* JwtCodec.verify({
          token,
          keys: jwks.keys.map((key) => ({ kid: key.kid, alg: key.alg, publicKeyJwk: key })),
          algorithms: ["EdDSA"],
          expectedTyp: "at+jwt",
          issuer: "https://issuer.test",
          audience: "https://issuer.test",
        });
      }),
    );

  return { handler, issueSessionCookieHeader, issueSession, revokeSession, revokeJti, verifyToken };
};

describe("AuthHttp + Jwt (real HTTP)", () => {
  it.effect("GET /jwt/jwks returns the current public key, no private material", () =>
    Effect.gen(function* () {
      const { handler } = buildHandler();
      const response = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/jwt/jwks`)));
      assert.strictEqual(response.status, 200);

      const body = (yield* Effect.promise(() => response.json())) as {
        keys: ReadonlyArray<Record<string, unknown>>;
      };
      assert.strictEqual(body.keys.length, 1);
      const [key] = body.keys;
      assert.isDefined(key);
      assert.isString(key?.["kid"]);
      assert.isUndefined(key?.["d"]);
      assert.isUndefined(key?.["privateKeyJwk"]);
    }),
  );

  // ECF-002/KRS-010: the served JWKS tells verifiers how long they may cache it.
  it.effect(
    "GET /jwt/jwks carries Cache-Control max-age (JwtConfig.jwksMaxAge, default 10 minutes)",
    () =>
      Effect.gen(function* () {
        const { handler } = buildHandler();
        const response = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/jwt/jwks`)));
        assert.strictEqual(response.headers.get("cache-control"), "public, max-age=600");
      }),
  );

  it("GET /jwt/token requires authentication", async () => {
    const { handler } = buildHandler();
    const response = await handler(new Request(`${ORIGIN}/jwt/token`));
    assert.strictEqual(response.status, 401);
  });

  it("GET /jwt/token mints a token verifiable against /jwt/jwks", async () => {
    const { handler, issueSessionCookieHeader, verifyToken } = buildHandler();
    const cookie = await issueSessionCookieHeader("user-1");

    const minted = await handler(new Request(`${ORIGIN}/jwt/token`, { headers: { cookie } }));
    assert.strictEqual(minted.status, 200);
    // PDR-003: response mirroring is opt-in now (`mirrorResponses`, default
    // "off"), so this endpoint's token arrives in the body only.
    assert.isNull(minted.headers.get("x-jwt-token"));
    const body = (await minted.json()) as { token: string };
    assert.isString(body.token);

    const claims = await verifyToken(body.token);
    assert.strictEqual(claims["sub"], "user-1");
  });

  it("POST /jwt/introspect requires authentication", async () => {
    const { handler } = buildHandler();
    const response = await handler(
      new Request(`${ORIGIN}/jwt/introspect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "whatever" }),
      }),
    );
    assert.strictEqual(response.status, 401);
  });

  it("POST /jwt/introspect reports active:true for a freshly minted token, active:false once its jti is revoked", async () => {
    const { handler, issueSessionCookieHeader, revokeJti, verifyToken } = buildHandler();
    const cookie = await issueSessionCookieHeader("user-1");

    const mintedResponse = await handler(
      new Request(`${ORIGIN}/jwt/token`, { headers: { cookie } }),
    );
    const { token } = (await mintedResponse.json()) as { token: string };

    const introspect = (): Promise<Response> =>
      handler(
        new Request(`${ORIGIN}/jwt/introspect`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
      );

    const active = await introspect();
    assert.strictEqual(active.status, 200);
    const activeBody = (await active.json()) as { active: boolean; claims?: { sub: string } };
    assert.isTrue(activeBody.active);
    assert.strictEqual(activeBody.claims?.sub, "user-1");

    const claims = await verifyToken(token);
    const jti = claims["jti"] as string;
    const exp = claims["exp"] as number;
    await revokeJti(jti, DateTime.fromEpochSeconds(exp));

    const inactive = await introspect();
    assert.strictEqual(inactive.status, 200);
    const inactiveBody = (await inactive.json()) as { active: boolean };
    assert.isFalse(inactiveBody.active);
  });
});

// TIR-007: the HTTP introspection endpoint applies session liveness whenever
// `Sessions` is composed (it always is here — `Authentication` needs it).
describe("POST /jwt/introspect session liveness (TIR-007)", () => {
  it("reports active:false once the minting session is revoked", async () => {
    const { handler, issueSession, revokeSession } = buildHandler();
    const minting = await issueSession("user-1");
    const caller = await issueSession("user-1");
    const mintedResponse = await handler(
      new Request(`${ORIGIN}/jwt/token`, { headers: { cookie: minting.cookie } }),
    );
    const { token } = (await mintedResponse.json()) as { token: string };
    const introspect = async (): Promise<boolean> => {
      const response = await handler(
        new Request(`${ORIGIN}/jwt/introspect`, {
          method: "POST",
          headers: { cookie: caller.cookie, "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
      );
      return ((await response.json()) as { active: boolean }).active;
    };

    assert.isTrue(await introspect());
    await revokeSession(minting.sessionId);
    assert.isFalse(await introspect());
  });
});

// .scratch/jwt/issues/16-automatic-response-mirroring.md — the one test
// proving the mechanism is genuinely generic: `Jwt` installed alongside
// the core `session` group (a group `Jwt` owns nothing about — the same
// group `packages/server/test/AuthHttp.test.ts` exercises on its own,
// with no `Jwt` in the picture there at all), hitting `GET /session` (not
// one of `Jwt`'s own `/jwt/...` endpoints) and confirming the mirrored
// `x-jwt-token` response header is present and verifies.
describe("AuthHttp + Jwt + Session (cross-plugin response mirroring)", () => {
  // `Jwt.Jwt.layer` and `AuthenticationLive` are both merged in at this one
  // shared, outer level — not scoped locally inside either
  // `AuthHttp.routes(...)` branch below — so both branches' groups resolve
  // their `Api.Authentication` middleware against the exact same built
  // instance, and that instance's `PostAuthResponseHook` resolution (now
  // per request, inside `Authentication.ts`'s own `handle` closures — see
  // that file's comment) sees `Jwt`'s override regardless of which
  // branch's endpoint is actually being called.
  const crossPluginAppLayer = (mirrorResponses?: JwtConfig.JwtConfigShape["mirrorResponses"]) =>
    Layer.mergeAll(
      AuthHttp.routes(AuthCore.AuthCoreApi, {}).pipe(
        Layer.provide(Session.SessionHandlers),
        Layer.provide(Account.AccountHandlers),
      ),
      AuthHttp.routes(JwtApi.JwtApi, {}),
    ).pipe(
      Layer.provide(CsrfProtectionLive),
      // CSG-001/DRS-002: `Account.deleteUser` now runs inside a
      // `SqlTransaction` — a no-op wrapper for this in-memory composition.
      Layer.provide(SqlTransaction.layerNoop),
      Layer.provideMerge(Jwt.Jwt.layer),
      Layer.provideMerge(AuthenticationLive),
      Layer.provideMerge(KeyRing.KeyRing.layer),
      Layer.provideMerge(SigningKeyRecords.layerMemory),
      Layer.provideMerge(SqlTransaction.layerNoop),
      Layer.provideMerge(Sessions.layerMemory),
      Layer.provideMerge(Verification.layerMemory),
      // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
      Layer.provideMerge(AuthEvents.layer),
      Layer.provideMerge(AuditLog.layerMemory),
      Layer.provideMerge(RevocationStore.layerMemory),
      Layer.provideMerge(Users.layerMemory),
      Layer.provideMerge(Accounts.layerMemory),
      Layer.provideMerge(Hooks.HooksLive),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(TestServices),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provideMerge(
        JwtConfig.config({
          issuer: "https://issuer.test",
          ...(mirrorResponses === undefined ? {} : { mirrorResponses }),
        }),
      ),
    );

  // A live app for one `mirrorResponses` setting, plus a way to run effects
  // against its context (to issue a real session).
  const buildApp = (mirrorResponses?: JwtConfig.JwtConfigShape["mirrorResponses"]) => {
    const layer = crossPluginAppLayer(mirrorResponses);
    const memoMap = Layer.makeMemoMapUnsafe();
    const { handler } = HttpRouter.toWebHandler(layer, { memoMap });
    const withAppContext = <A, E>(
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
    const issueSessionToken = () =>
      withAppContext(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const issued = yield* sessions.issue({ userId: Users.UserId("user-1") });
          return Redacted.value(issued.token);
        }),
      );
    return { handler, issueSessionToken };
  };

  const verifyMirrored = async (
    handler: (request: Request) => Promise<Response>,
    mirrored: string,
  ) => {
    const jwksResponse = await handler(new Request(`${ORIGIN}/jwt/jwks`));
    const jwks = (await jwksResponse.json()) as {
      keys: ReadonlyArray<{ readonly kid: string; readonly alg: JwtCodec.Algorithm }>;
    };
    return Effect.runPromise(
      JwtCodec.verify({
        token: mirrored,
        keys: jwks.keys.map((key) => ({ kid: key.kid, alg: key.alg, publicKeyJwk: key })),
        algorithms: ["EdDSA"],
        expectedTyp: "at+jwt",
        issuer: "https://issuer.test",
        audience: "https://issuer.test",
      }),
    );
  };

  // PDR-003 (decision: adopted recommended option B, default off): a response
  // header is a log/proxy/APM capture surface, so nothing is mirrored unless
  // the deployment opts in.
  it("default config: GET /session carries no x-jwt-token header", async () => {
    const { handler, issueSessionToken } = buildApp();
    const token = await issueSessionToken();
    const response = await handler(
      new Request(`${ORIGIN}/session`, {
        headers: { cookie: `__Host-session=${encodeURIComponent(token)}` },
      }),
    );
    assert.strictEqual(response.status, 200);
    assert.isNull(response.headers.get("x-jwt-token"));
  });

  it('mirrorResponses: "always": GET /session (not a Jwt endpoint) carries a mirrored, verifiable x-jwt-token header', async () => {
    const { handler, issueSessionToken } = buildApp("always");
    const token = await issueSessionToken();
    const response = await handler(
      new Request(`${ORIGIN}/session`, {
        headers: { cookie: `__Host-session=${encodeURIComponent(token)}` },
      }),
    );
    assert.strictEqual(response.status, 200);
    const mirrored = response.headers.get("x-jwt-token");
    assert.isString(mirrored);
    if (mirrored === null) {
      throw new Error("expected x-jwt-token header");
    }
    const claims = await verifyMirrored(handler, mirrored);
    assert.strictEqual(claims["sub"], "user-1");
  });

  it('mirrorResponses: "bearer": a cookie-authenticated request gets no header, a bearer-authenticated one does', async () => {
    const { handler, issueSessionToken } = buildApp("bearer");
    const token = await issueSessionToken();
    const viaCookie = await handler(
      new Request(`${ORIGIN}/session`, {
        headers: { cookie: `__Host-session=${encodeURIComponent(token)}` },
      }),
    );
    assert.strictEqual(viaCookie.status, 200);
    assert.isNull(viaCookie.headers.get("x-jwt-token"));

    const viaBearer = await handler(
      new Request(`${ORIGIN}/session`, { headers: { authorization: `Bearer ${token}` } }),
    );
    assert.strictEqual(viaBearer.status, 200);
    const mirrored = viaBearer.headers.get("x-jwt-token");
    assert.isString(mirrored);
    if (mirrored === null) {
      throw new Error("expected x-jwt-token header");
    }
    assert.strictEqual((await verifyMirrored(handler, mirrored))["sub"], "user-1");
  });
});

/**
 * .scratch/jwt/issues/17-composition-and-contract-tests.md — the same
 * mechanically-verifiable contract suite every other plugin's own
 * `AuthHttp.test.ts` runs against itself (table prefixes, no host-id
 * collision, deterministic migrations, contract stability across every
 * documented `JwtConfig` option value). `Jwt` has no per-instance option
 * surface of its own (its behavior varies only via `JwtConfig`, a separate
 * `Context.Service` this suite never builds/runs — it only inspects the
 * plugin's static manifest and composes it, never executes `make`), so a
 * single `{}` entry is correct, not an omission — mirroring
 * `packages/admin/test/AuthHttp.test.ts`'s own identical reasoning for
 * `Admin`.
 */
const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => {
    throw new Error(message);
  },
};

TestAuth.runPluginContractTests(vitestFramework, () => Jwt.Jwt, { options: [{}] });
