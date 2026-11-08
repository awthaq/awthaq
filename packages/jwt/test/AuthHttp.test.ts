// .scratch/jwt/issues/09-jwks-endpoint.md, 10-explicit-mint-endpoint.md —
// the `jwt`/`jwt.token` groups exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler`, real HTTP request/response, mirroring every
// other plugin's own `AuthHttp.test.ts`. `jwks` needs no `Authentication`
// middleware/session at all — it is public by definition; `token` does,
// and a signed-in agent (`TestAuth.app(...).signIn`) holds the session
// cookie that authenticates it.
import { Auth, SessionCookie, Sessions, type Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as Jwt from "../src/Jwt.ts";
import * as JwtCodec from "../src/JwtCodec.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as RevocationStore from "../src/RevocationStore.ts";

/**
 * `Jwt`'s own `jwt`/`jwt.token` groups are deliberately NOT given `Api.CsrfProtection`: minting and introspection
 * sign or read a token and change no server state, and the response is unreadable cross-origin (no CORS by
 * default). `Auth.make([Jwt])` also carries core's session and account groups (both CSRF-protected), which the
 * cross-plugin mirroring tests below hit, so the one composition serves every test in this file.
 */
const built = Auth.make([Jwt.Jwt]);

const appLayer = (
  config: Partial<Parameters<typeof JwtConfig.config>[0]> = {},
  extra: { readonly docs?: boolean } = {},
) =>
  TestAuth.layer(built, {
    services: JwtConfig.config({ issuer: "https://issuer.test", ...config }),
    ...(extra.docs === true ? { openapiPath: "/openapi.json", docsPath: "/docs" } : {}),
  });

const ORIGIN = "http://localhost:3000";

const buildHandler = () => {
  const app = TestAuth.app(appLayer({}, { docs: true }), { baseUrl: ORIGIN });
  const { handler } = app;
  const withAppContext = app.run;

  /** A browser holding a real session against the same running `Sessions` instance. */
  const signIn = (email: string) => app.signIn(email);

  /**
   * TIR-007: a second, separate session for the same user (an agent holding it, seeded with the session's
   * cookie), plus its id so one can be revoked.
   */
  const issueSession = (userId: Users.UserId) =>
    withAppContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId });
        // The `Set-Cookie` the server would answer, rendered under the composition's cookie config.
        const rendered = yield* SessionCookie.render(issued.session, issued.token);
        const setCookie = Cookies.serializeCookie(
          Cookies.makeCookieUnsafe(rendered.name, rendered.value, rendered.options),
        );
        return { setCookie, sessionId: issued.session.id };
      }),
    ).then(async ({ setCookie, sessionId }) => {
      const browser = await app.agent();
      browser.cookies.receive(setCookie);
      return { browser, sessionId };
    });

  const revokeSession = (sessionId: Sessions.SessionId): Promise<void> =>
    withAppContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        yield* sessions.revoke(sessionId, "admin");
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

  return { handler, signIn, issueSession, revokeSession, revokeJti, verifyToken };
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

  it("POST /jwt/token requires authentication", async () => {
    const { handler } = buildHandler();
    const response = await handler(new Request(`${ORIGIN}/jwt/token`, { method: "POST" }));
    assert.strictEqual(response.status, 401);
  });

  // AVS-007: minting a credential is an action, so it is POST-only — a GET must not reach it.
  it("GET /jwt/token is not served (minting is POST-only)", async () => {
    const { signIn } = buildHandler();
    const alice = await signIn("alice@example.com");
    const response = await alice.request("GET", "/jwt/token");
    assert.strictEqual(response.status, 404);
  });

  it("POST /jwt/token mints a token verifiable against /jwt/jwks", async () => {
    const { signIn, verifyToken } = buildHandler();
    const alice = await signIn("alice@example.com");

    const minted = await alice.request("POST", "/jwt/token");
    assert.strictEqual(minted.status, 200);
    // PDR-003: response mirroring is opt-in now (`mirrorResponses`, default
    // "off"), so this endpoint's token arrives in the body only.
    assert.isNull(minted.headers.get("x-jwt-token"));
    const body = (await minted.json()) as { token: string };
    assert.isString(body.token);

    const claims = await verifyToken(body.token);
    assert.strictEqual(claims["sub"], alice.userId);
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
    const { signIn, revokeJti, verifyToken } = buildHandler();
    const alice = await signIn("alice@example.com");

    const mintedResponse = await alice.request("POST", "/jwt/token");
    const { token } = (await mintedResponse.json()) as { token: string };

    const introspect = (): Promise<Response> =>
      alice.request("POST", "/jwt/introspect", { json: { token } });

    const active = await introspect();
    assert.strictEqual(active.status, 200);
    const activeBody = (await active.json()) as { active: boolean; claims?: { sub: string } };
    assert.isTrue(activeBody.active);
    assert.strictEqual(activeBody.claims?.sub, alice.userId);

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
    const { signIn, issueSession, revokeSession } = buildHandler();
    const { userId } = await signIn("user-1@example.com");
    const minting = await issueSession(userId);
    const caller = await issueSession(userId);
    const mintedResponse = await minting.browser.request("POST", "/jwt/token");
    const { token } = (await mintedResponse.json()) as { token: string };
    const introspect = async (): Promise<boolean> => {
      const response = await caller.browser.request("POST", "/jwt/introspect", {
        json: { token },
      });
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
  // A live app for one `mirrorResponses` setting, plus a way to run effects against its context (to issue a real
  // session). `Jwt` and core's `session` group share the one composition, so the mirroring is proven across plugins.
  const buildApp = (
    mirrorResponses?: JwtConfig.JwtConfigShape["mirrorResponses"],
    sessionCookie?: Parameters<typeof JwtConfig.config>[0]["sessionCookie"],
  ) => {
    const app = TestAuth.app(
      appLayer({
        ...(mirrorResponses === undefined ? {} : { mirrorResponses }),
        ...(sessionCookie === undefined ? {} : { sessionCookie }),
      }),
      { baseUrl: ORIGIN },
    );
    return {
      handler: app.handler,
      signIn: (email: string) => app.signIn(email),
      signInBearer: (email: string) => app.signIn(email, { delivery: "bearer" }),
    };
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
    const { signIn } = buildApp();
    const alice = await signIn("alice@example.com");
    const response = await alice.request("GET", "/session");
    assert.strictEqual(response.status, 200);
    assert.isNull(response.headers.get("x-jwt-token"));
  });

  it('mirrorResponses: "always": GET /session (not a Jwt endpoint) carries a mirrored, verifiable x-jwt-token header', async () => {
    const { handler, signIn } = buildApp("always");
    const alice = await signIn("alice@example.com");
    const response = await alice.request("GET", "/session");
    assert.strictEqual(response.status, 200);
    const mirrored = response.headers.get("x-jwt-token");
    assert.isString(mirrored);
    if (mirrored === null) {
      throw new Error("expected x-jwt-token header");
    }
    const claims = await verifyMirrored(handler, mirrored);
    assert.strictEqual(claims["sub"], alice.userId);
  });

  it('mirrorResponses: "bearer": a cookie-authenticated request gets no header, a bearer-authenticated one does', async () => {
    const { handler, signIn, signInBearer } = buildApp("bearer");
    const browser = await signIn("browser@example.com");
    const viaCookie = await browser.request("GET", "/session");
    assert.strictEqual(viaCookie.status, 200);
    assert.isNull(viaCookie.headers.get("x-jwt-token"));

    const native = await signInBearer("native@example.com");
    const viaBearer = await native.request("GET", "/session");
    assert.strictEqual(viaBearer.status, 200);
    const mirrored = viaBearer.headers.get("x-jwt-token");
    assert.isString(mirrored);
    if (mirrored === null) {
      throw new Error("expected x-jwt-token header");
    }
    assert.strictEqual((await verifyMirrored(handler, mirrored))["sub"], native.userId);
  });

  // BO-006 (ADR D1 option C): the opt-in, short-lived JWT session-mirror
  // cookie an edge proxy can verify statelessly (`@awthaq/next/edge`).
  describe("session-mirror cookie (BO-006)", () => {
    const MIRROR = "__Host-session-jwt";

    /** A signed-in browser's `GET /session`, and the agent (it keeps the mirror cookie it is answered). */
    const sessionRequest = async (signIn: (email: string) => Promise<TestAuth.SignedInAgent>) => {
      const alice = await signIn("alice@example.com");
      return { alice, response: await alice.request("GET", "/session") };
    };

    it("default config mints no mirror cookie", async () => {
      const { response } = await sessionRequest(buildApp().signIn);
      assert.strictEqual(response.status, 200);
      assert.notInclude(response.headers.getSetCookie().join("\n"), MIRROR);
    });

    it("sessionCookie: true sets an HttpOnly/Secure/SameSite=Strict __Host- cookie holding a verifiable JWT that expires with the cookie", async () => {
      const { handler, signIn } = buildApp(undefined, true);
      const { alice, response } = await sessionRequest(signIn);
      assert.strictEqual(response.status, 200);
      const cookie = response.headers
        .getSetCookie()
        .find((header) => header.startsWith(`${MIRROR}=`));
      assert.isDefined(cookie);
      if (cookie === undefined) return;
      assert.include(cookie, "HttpOnly");
      assert.include(cookie, "Secure");
      assert.include(cookie, "SameSite=Strict");
      assert.include(cookie, "Path=/");
      assert.include(cookie, "Max-Age=300");
      const token = decodeURIComponent(cookie.slice(MIRROR.length + 1).split(";")[0] ?? "");
      const claims = await verifyMirrored(handler, token);
      assert.strictEqual(claims["sub"], alice.userId);
      assert.strictEqual(Number(claims["exp"]) - Number(claims["iat"]), 300);
      // A browser stores it: it is a conforming `__Host-` cookie.
      assert.strictEqual(alice.cookies.get(MIRROR)?.httpOnly, true);
    });

    it("honours a custom name and ttl", async () => {
      const { signIn } = buildApp(undefined, {
        name: "__Host-edge",
        ttl: Duration.minutes(1),
      });
      const { response } = await sessionRequest(signIn);
      const cookie = response.headers
        .getSetCookie()
        .find((header) => header.startsWith("__Host-edge="));
      assert.isDefined(cookie);
      assert.include(cookie ?? "", "Max-Age=60");
    });

    it("a bearer-authenticated request gets no mirror cookie", async () => {
      const native = await buildApp(undefined, true).signInBearer("native@example.com");
      const response = await native.request("GET", "/session");
      assert.strictEqual(response.status, 200);
      assert.notInclude(response.headers.getSetCookie().join("\n"), MIRROR);
    });

    it("a name without the __Host- prefix fails the layer build", async () => {
      const exit = await Effect.runPromiseExit(
        Layer.build(
          JwtConfig.config({
            issuer: "https://issuer.test",
            sessionCookie: { name: "session-jwt" },
          }),
        ).pipe(Effect.scoped),
      );
      assert.isTrue(Exit.isFailure(exit));
    });
  });
});
