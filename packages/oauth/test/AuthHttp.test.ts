// spec/behaviors/16-oauth.md, BEH-EA-121 through BEH-EA-128.
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-088.
//
// The wire-level counterpart `OAuth.test.ts`'s own header comment points
// at: real `HttpRouter`/`HttpRouter.toWebHandler` requests, `authorize`
// actually answering a `302` with a `Location` header and the correlation
// cookie set, `callback` actually setting the session cookie on success,
// and `httpApiStatus` landing on the real response status for each
// declared error. `@awthaq/password`'s own `AuthHttp.test.ts` caught a
// real bug (`Schema.Union` collapsing per-member `httpApiStatus`) that its
// domain-level tests could not — this file exists for the same reason,
// against `OAuthApi.ts`'s own array-form `error` declarations.
import { Accounts, RateLimits, SessionCookie, Sessions, Users, Verification } from "@awthaq/core";
import { ClientAddress, Encryption, KeyProvider, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp } from "@awthaq/server";
import { CookieAssertions, TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthApi from "../src/OAuthApi.ts";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import { FakeReply, fakeHttpClient, type FakeRoutes } from "./FakeProvider.ts";

// Shipping-gap map (.scratch/shipping-gaps), ticket 19: `OAuth.layer` now
// requires `Encryption` — a fixed test key, isolated from the real
// `process.env`.
const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(TestAuth.memoryFoundation));

const baseUrl = "https://app.example.com";

const acme = OAuthProvider.oauth2({
  id: "acme",
  clientId: Config.succeed("acme-client-id"),
  clientSecret: Config.succeed(Redacted.make("acme-secret")),
  scopes: ["read"],
  endpoints: {
    authorizationEndpoint: "https://acme.example.com/authorize",
    tokenEndpoint: "https://acme.example.com/token",
    userinfoEndpoint: "https://acme.example.com/userinfo",
  },
  mapProfile: (claims) => ({
    subject: claims["id"] as string,
    email: claims["email"] as string,
  }),
});

const defaultRoutes = {
  "/token": { access_token: "at-1" },
  "/userinfo": { id: "acme-sub-1", email: "acme-user@example.com" },
};

const buildAppLayer = (options: {
  readonly routes?: FakeRoutes;
  /** A real, enforcing limiter instead of the permissive one every other test uses. */
  readonly enforcing?: boolean;
  readonly config?: OAuth.OAuthConfigInput;
}) =>
  AuthHttp.routes(OAuthApi.OAuthApi, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(OAuth.OAuth.layer),
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      options.enforcing === true
        ? RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))
        : RateLimiter.layerPermissive,
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(EncryptionLive),
    Layer.provide(fakeHttpClient(options.routes ?? defaultRoutes)),
    Layer.provide(
      OAuth.config({
        providers: [acme],
        linking: "explicit",
        trustedOrigins: [],
        baseUrl,
        retry: { base: Duration.zero },
        ...options.config,
      }),
    ),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const AppLayer = buildAppLayer({});

/**
 * A real, enforcing limiter — every other test in this file uses
 * `RateLimiter.layerPermissive` via `AppLayer`, deliberately, so this is
 * the one dedicated layer that opts back into real enforcement, mirroring
 * `@awthaq/password`'s own dedicated throttle test.
 */
const ThrottledAppLayer = buildAppLayer({ enforcing: true });

/**
 * Runs authorize then callback against `layer`, returning the callback
 * response. `query` builds the callback's query string from the flow's
 * `state` (default: a normal `code` redirect); `handler` lets a test send
 * several callbacks against the one router.
 */
const runCallback = (
  layer: typeof AppLayer,
  query: (state: string) => string = (state) => `code=auth-code&state=${state}`,
) =>
  Effect.gen(function* () {
    const { handler } = HttpRouter.toWebHandler(layer);
    const authorizeResponse = yield* Effect.promise(() =>
      handler(new Request("http://localhost/oauth/acme/authorize")),
    );
    const location = authorizeResponse.headers.get("location");
    const stateCookie = authorizeResponse.headers.get("set-cookie");
    if (location === null || stateCookie === null) {
      throw new Error("expected authorize to redirect with a state cookie");
    }
    const state = new URL(location).searchParams.get("state");
    return yield* Effect.promise(() =>
      handler(
        new Request(
          `http://localhost/oauth/acme/callback?${query(encodeURIComponent(state ?? ""))}`,
          { headers: { cookie: stateCookie.split(";")[0] ?? "" } },
        ),
      ),
    );
  });

describe("AuthHttp + OAuth (real HTTP)", () => {
  it.effect(
    "BEH-EA-121/128: authorize answers a 302 with a Location and sets the correlation cookie",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost/oauth/acme/authorize")),
        );
        assert.strictEqual(response.status, 302);
        const location = response.headers.get("location");
        assert.isString(location);
        assert.include(location ?? "", "code_challenge_method=S256");
        const cookie = response.headers.get("set-cookie");
        assert.isString(cookie);
        assert.match(cookie ?? "", /^__Host-oauth-state=/);
        // CSS-001: the `__Host-` prefix requires Secure, no Domain, and
        // Path=/ exactly — a narrower path silently voids the prefix and
        // real browsers drop the cookie.
        assert.match(cookie ?? "", /;\s*Path=\/(;|$)/i);
        assert.match(cookie ?? "", /;\s*Secure/i);
        assert.notMatch(cookie ?? "", /;\s*Domain=/i);
      }),
  );

  it.effect(
    "BEH-EA-113-adjacent/083: callback answers 302 and sets the session cookie on success",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const authorizeResponse = yield* Effect.promise(() =>
          handler(new Request("http://localhost/oauth/acme/authorize")),
        );
        const location = authorizeResponse.headers.get("location");
        const stateCookie = authorizeResponse.headers.get("set-cookie");
        if (location === null || stateCookie === null) {
          throw new Error("expected authorize to redirect with a state cookie");
        }
        const state = new URL(location).searchParams.get("state");
        const cookieValue = stateCookie.split(";")[0];

        const callbackResponse = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://localhost/oauth/acme/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`,
              { headers: { cookie: cookieValue ?? "" } },
            ),
          ),
        );
        assert.strictEqual(callbackResponse.status, 302);
        const sessionCookie = callbackResponse.headers.get("set-cookie");
        assert.isString(sessionCookie);
        assert.match(sessionCookie ?? "", /^__Host-session=/);
      }),
  );

  // MNA-003/MNA-004: the native return leg over the wire — a deep-link redirect
  // carrying an exchange code, no session cookie, redeemed once at POST /oauth/token.
  const NativeLayer = buildAppLayer({
    config: { baseUrl, nativeRedirectURLs: ["myapp://oauth/callback"] },
  });

  it.effect(
    "MNA-003: a native flow redirects to the deep link with a code, sets no session cookie, and POST /oauth/token redeems it once",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(NativeLayer);
        const authorize = yield* Effect.promise(() =>
          handler(
            new Request(
              "http://localhost/oauth/acme/authorize?mode=native&callbackURL=" +
                encodeURIComponent("myapp://oauth/callback"),
            ),
          ),
        );
        assert.strictEqual(authorize.status, 302);
        const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state");
        const stateCookie = (authorize.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const callback = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://localhost/oauth/acme/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`,
              { headers: { cookie: stateCookie } },
            ),
          ),
        );
        assert.strictEqual(callback.status, 302);
        const location = callback.headers.get("location") ?? "";
        assert.match(location, /^myapp:\/\/oauth\/callback\?code=/);
        // Only the (expiry of the) state cookie: no session cookie reaches the browser jar.
        assert.isFalse((callback.headers.get("set-cookie") ?? "").includes("__Host-session"));

        const code = URL.parse(location)?.searchParams.get("code") ?? "";
        const redeem = () =>
          handler(
            new Request("http://localhost/oauth/token", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code }),
            }),
          );
        const redeemed = yield* Effect.promise(redeem);
        assert.strictEqual(redeemed.status, 200);
        assert.match(redeemed.headers.get("cache-control") ?? "", /no-store/);
        const body = (yield* Effect.promise(() => redeemed.json())) as { token?: string };
        assert.isString(body.token);
        const again = yield* Effect.promise(redeem);
        assert.strictEqual(again.status, 400);
      }),
  );

  it.effect("MNA-003: a code_challenge without native mode, or a malformed one, answers 400", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(NativeLayer);
      const challenge = "A".repeat(43);
      const browserMode = yield* Effect.promise(() =>
        handler(new Request(`http://localhost/oauth/acme/authorize?code_challenge=${challenge}`)),
      );
      assert.strictEqual(browserMode.status, 400);
      const malformed = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost/oauth/acme/authorize?mode=native&code_challenge=short"),
        ),
      );
      assert.strictEqual(malformed.status, 400);
      const fine = yield* Effect.promise(() =>
        handler(
          new Request(
            `http://localhost/oauth/acme/authorize?mode=native&code_challenge=${challenge}`,
          ),
        ),
      );
      assert.strictEqual(fine.status, 302);
    }),
  );

  it.effect("BEH-EA-004: an unknown provider answers 404 ProviderNotFound", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost/oauth/nonexistent/authorize")),
      );
      assert.strictEqual(response.status, 404);
    }),
  );

  it.effect(
    "BEH-EA-122: a callback with a mismatched state/cookie answers 400 OAuthCallbackFailed",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/oauth/acme/callback?code=c1&state=bogus.state", {
              headers: { cookie: "__Host-oauth-state=different-state" },
            }),
          ),
        );
        assert.strictEqual(response.status, 400);
      }),
  );

  it.effect("shipping-gaps/13: callback is throttled once its own rule's limit is exceeded", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(ThrottledAppLayer);
      // The limiter runs before state/cookie validation, so a garbage
      // callback is enough to exercise it — 20 requests admitted as
      // ordinary 400s, the 21st throttled.
      for (let i = 0; i < 20; i++) {
        const response = yield* Effect.promise(() =>
          handler(new Request(`http://localhost/oauth/acme/callback?code=c${i}&state=bogus`)),
        );
        assert.strictEqual(response.status, 400);
      }
      const throttled = yield* Effect.promise(() =>
        handler(new Request("http://localhost/oauth/acme/callback?code=cN&state=bogus")),
      );
      assert.strictEqual(throttled.status, 429);
    }),
  );

  it.effect("EEM-004: a token endpoint answering 503 yields HTTP 503 ProviderUnavailable", () =>
    Effect.gen(function* () {
      const response = yield* runCallback(
        buildAppLayer({ routes: { ...defaultRoutes, "/token": new FakeReply(503) } }),
      );
      assert.strictEqual(response.status, 503);
      const body = yield* Effect.promise(() => response.json());
      assert.deepStrictEqual(body, { _tag: "ProviderUnavailable" });
    }),
  );

  it.effect("EEM-004: a token endpoint answering 400 invalid_grant still yields HTTP 400", () =>
    Effect.gen(function* () {
      const response = yield* runCallback(
        buildAppLayer({
          routes: { ...defaultRoutes, "/token": new FakeReply(400, { error: "invalid_grant" }) },
        }),
      );
      assert.strictEqual(response.status, 400);
      const body = yield* Effect.promise(() => response.json());
      assert.deepStrictEqual(body, { _tag: "OAuthCallbackFailed" });
    }),
  );

  it.effect(
    "CSS-004: the authorize state cookie is a __Host- cookie, HttpOnly and SameSite=Lax",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost/oauth/acme/authorize")),
        );
        CookieAssertions.assertHostPrefixedCookie(
          CookieAssertions.findSetCookie(response, "__Host-oauth-state"),
          { httpOnly: true, sameSite: "lax" },
        );
      }),
  );

  it.effect(
    "CSS-004: the callback's session cookie is a __Host- cookie, HttpOnly and SameSite=Strict",
    () =>
      Effect.gen(function* () {
        const response = yield* runCallback(AppLayer);
        assert.strictEqual(response.status, 302);
        CookieAssertions.assertHostPrefixedCookie(
          CookieAssertions.findSetCookie(response, "__Host-session"),
          { httpOnly: true, sameSite: "strict" },
        );
      }),
  );

  // PV-016: under the default `SameSite=Strict` cookie the first landing request after the provider's
  // redirect chain may not carry the session; `HostLax` is the opt-in that fixes it (BEH-EA-055).
  it.effect(
    "PV-016: with SessionCookie.config({ mode: HostLax }) the callback's session cookie is __Host- and SameSite=Lax",
    () =>
      Effect.gen(function* () {
        const response = yield* runCallback(
          AppLayer.pipe(Layer.provideMerge(SessionCookie.config({ mode: SessionCookie.HostLax }))),
        );
        assert.strictEqual(response.status, 302);
        CookieAssertions.assertHostPrefixedCookie(
          CookieAssertions.findSetCookie(response, "__Host-session"),
          { httpOnly: true, sameSite: "lax" },
        );
      }),
  );

  it.effect(
    "CSS-006: a successful callback expires __Host-oauth-state alongside the session cookie",
    () =>
      Effect.gen(function* () {
        const response = yield* runCallback(AppLayer);
        assert.strictEqual(response.status, 302);
        const state = CookieAssertions.findSetCookie(response, "__Host-oauth-state");
        CookieAssertions.assertExpiredCookie(state);
        // Cleared with the attributes it was set with, or a browser won't match it.
        CookieAssertions.assertHostPrefixedCookie(state, { httpOnly: true, sameSite: "lax" });
        assert.isDefined(
          CookieAssertions.setCookiesOf(response).find(
            (cookie) => cookie.name === "__Host-session",
          ),
        );
      }),
  );

  it.effect("CSS-006: a failed callback (400) also expires __Host-oauth-state", () =>
    Effect.gen(function* () {
      const response = yield* runCallback(
        buildAppLayer({ routes: { ...defaultRoutes, "/token": new FakeReply(400, {}) } }),
      );
      assert.strictEqual(response.status, 400);
      CookieAssertions.assertExpiredCookie(
        CookieAssertions.findSetCookie(response, "__Host-oauth-state"),
      );
    }),
  );

  it.effect("PDR-004: authorize and callback responses carry Referrer-Policy: no-referrer", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const authorize = yield* Effect.promise(() =>
        handler(new Request("http://localhost/oauth/acme/authorize")),
      );
      assert.strictEqual(authorize.headers.get("referrer-policy"), "no-referrer");
      const callback = yield* runCallback(AppLayer);
      assert.strictEqual(callback.status, 302);
      assert.strictEqual(callback.headers.get("referrer-policy"), "no-referrer");
      const failed = yield* Effect.promise(() =>
        handler(new Request("http://localhost/oauth/acme/callback?code=c1&state=bogus.state")),
      );
      assert.strictEqual(failed.status, 400);
      assert.strictEqual(failed.headers.get("referrer-policy"), "no-referrer");
    }),
  );

  it.effect("OAP-008: authorize is throttled after its own rule's limit", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(ThrottledAppLayer);
      for (let i = 0; i < 30; i++) {
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost/oauth/acme/authorize")),
        );
        assert.strictEqual(response.status, 302);
      }
      const throttled = yield* Effect.promise(() =>
        handler(new Request("http://localhost/oauth/acme/authorize")),
      );
      assert.strictEqual(throttled.status, 429);
    }),
  );

  it.effect(
    "AP-005: a provider error redirect with a valid state answers the typed denial, not a decode error",
    () =>
      Effect.gen(function* () {
        const response = yield* runCallback(
          AppLayer,
          (state) =>
            `error=access_denied&error_description=${encodeURIComponent("user said no")}&state=${state}`,
        );
        assert.strictEqual(response.status, 400);
        // `error_description` is provider-controlled text and is never echoed.
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          _tag: "OAuthAuthorizationDenied",
          error: "access_denied",
        });
      }),
  );

  it.effect(
    "AP-005: an error redirect outside the RFC's enumerated set is the uniform OAuthCallbackFailed",
    () =>
      Effect.gen(function* () {
        const response = yield* runCallback(
          AppLayer,
          (state) => `error=made_up_code&state=${state}`,
        );
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          _tag: "OAuthCallbackFailed",
        });
      }),
  );

  it.effect(
    "AP-005: a callback with neither code nor error is the uniform OAuthCallbackFailed",
    () =>
      Effect.gen(function* () {
        const response = yield* runCallback(AppLayer, (state) => `state=${state}`);
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          _tag: "OAuthCallbackFailed",
        });
      }),
  );

  it.effect(
    "AP-005: error=access_denied with a mismatched state answers 400 OAuthCallbackFailed",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const response = yield* Effect.promise(() =>
          handler(
            new Request(
              "http://localhost/oauth/acme/callback?error=access_denied&state=bogus.state",
              {
                headers: { cookie: "__Host-oauth-state=different-state" },
              },
            ),
          ),
        );
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          _tag: "OAuthCallbackFailed",
        });
      }),
  );

  it.effect("AP-005: a denial consumes the flow, so a replay carrying a code fails", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const authorizeResponse = yield* Effect.promise(() =>
        handler(new Request("http://localhost/oauth/acme/authorize")),
      );
      const location = authorizeResponse.headers.get("location") ?? "";
      const cookie = (authorizeResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const state = encodeURIComponent(new URL(location).searchParams.get("state") ?? "");
      const call = (query: string) =>
        Effect.promise(() =>
          handler(
            new Request(`http://localhost/oauth/acme/callback?${query}`, { headers: { cookie } }),
          ),
        );
      const denied = yield* call(`error=access_denied&state=${state}`);
      assert.strictEqual(denied.status, 400);
      const replay = yield* call(`code=auth-code&state=${state}`);
      assert.strictEqual(replay.status, 400);
      assert.deepStrictEqual(yield* Effect.promise(() => replay.json()), {
        _tag: "OAuthCallbackFailed",
      });
    }),
  );

  it.effect("BEH-EA-084: serves generated OpenAPI JSON from this plugin's own api", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost/openapi.json")),
      );
      assert.strictEqual(response.status, 200);
      const spec = (yield* Effect.promise(() => response.json())) as { paths?: unknown };
      assert.isDefined(spec.paths);
    }),
  );
});
