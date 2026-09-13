// spec/behaviors/16-oauth.md, BEH-EA-121 through BEH-EA-128.
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-088.
//
// The wire-level counterpart `OAuth.test.ts`'s own header comment points
// at: real `HttpRouter`/`HttpRouter.toWebHandler` requests, `authorize`
// actually answering a `302` with a `Location` header and the correlation
// cookie set, `callback` actually setting the session cookie on success,
// and `httpApiStatus` landing on the real response status for each
// declared error. `@effect-auth/password`'s own `AuthHttp.test.ts` caught a
// real bug (`Schema.Union` collapsing per-member `httpApiStatus`) that its
// domain-level tests could not — this file exists for the same reason,
// against `OAuthApi.ts`'s own array-form `error` declarations.
import { AuthEvents, Accounts, Sessions, Users, Verification } from "@effect-auth/core";
import { Authentication, AuthHttp } from "@effect-auth/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { OAuth, OAuthApi, OAuthProvider } from "../src/index.ts";

interface FakeRoutes {
  readonly [urlFragment: string]: unknown;
}

const fakeHttpClient = (routes: FakeRoutes): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const match = Object.entries(routes).find(([fragment]) => request.url.includes(fragment));
      if (match === undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(match[1]), { status: 200 }),
        ),
      );
    }),
  );

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(NodeCrypto.layer));

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

const AppLayer = AuthHttp.routes(OAuthApi.OAuthApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(OAuth.OAuth.layer),
  Layer.provide(Authentication.OptionalAuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(CoreLive),
  Layer.provide(
    fakeHttpClient({
      "/token": { access_token: "at-1" },
      "/userinfo": { id: "acme-sub-1", email: "acme-user@example.com" },
    }),
  ),
  Layer.provide(
    OAuth.config({ providers: [acme], linking: "explicit", trustedOrigins: [], baseUrl }),
  ),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

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
