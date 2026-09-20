// BE-002 (.issues/high): `OAuthTokenAccess.withAccessToken` — a live token
// reaches `use` untouched; an expiring-or-expired one is refreshed first
// (persisting the result) when a refresh token is on record, or fails
// `OAuthTokenUnavailable` when it isn't. Real, domain-level tests (no HTTP
// layer): a real in-memory `Accounts`, a fake `HttpClient` only for the
// provider's own token endpoint — the same shape `OAuth.test.ts` already
// establishes for the provider transport.
import { Accounts, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import * as OAuthTokenAccess from "../src/OAuthTokenAccess.ts";

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
      const body = typeof match[1] === "function" ? (match[1] as () => unknown)() : match[1];
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })),
      );
    }),
  );

const acme = (): OAuthProvider.OAuthProviderConfig =>
  OAuthProvider.oauth2({
    id: "acme",
    clientId: Config.succeed("acme-client-id"),
    clientSecret: Config.succeed(Redacted.make("acme-secret")),
    scopes: ["read"],
    endpoints: {
      authorizationEndpoint: "https://acme.example.com/authorize",
      tokenEndpoint: "https://acme.example.com/token",
      userinfoEndpoint: "https://acme.example.com/userinfo",
    },
    mapProfile: (claims) => ({ subject: claims["id"] as string }),
  });

const buildLayer = (httpRoutes: FakeRoutes) =>
  OAuthTokenAccess.layer.pipe(
    Layer.provideMerge(Accounts.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provide(fakeHttpClient(httpRoutes)),
    Layer.provide(OAuth.config({ providers: [acme()], baseUrl: "https://app.example.com" })),
  );

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

describe("OAuthTokenAccess", () => {
  it.effect("a live (not-yet-expiring) access token reaches use without any refresh call", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const now = yield* DateTime.now;
      const account = yield* accounts.link({
        userId,
        providerId: "acme",
        subject: "sub-live",
        tokens: {
          accessToken: Redacted.make("at-live"),
          refreshToken: Option.some(Redacted.make("rt-1")),
          accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.hours(1))),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        },
      });
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      const seen = yield* tokenAccess.withAccessToken(account.id, (token) =>
        Effect.succeed(Redacted.value(token)),
      );
      assert.strictEqual(seen, "at-live");
      // No `/token` route provided at all: a stray refresh call would hit
      // `fakeHttpClient`'s own unmatched-fragment 404, fail `response.json`
      // on that plain-text body, and this whole `withAccessToken` call
      // would fail instead of returning "at-live" above — proof enough
      // that a live token skips the refresh path entirely.
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect(
    "an access token expiring within the skew window is refreshed first, and the refreshed token is persisted",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const now = yield* DateTime.now;
        const account = yield* accounts.link({
          userId,
          providerId: "acme",
          subject: "sub-refresh",
          tokens: {
            accessToken: Redacted.make("at-old"),
            refreshToken: Option.some(Redacted.make("rt-old")),
            // 10s out — inside the port's own 30s skew window, so this
            // must trigger a refresh even though it has not, strictly,
            // expired yet.
            accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(10))),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          },
        });
        const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
        const seen = yield* tokenAccess.withAccessToken(account.id, (token) =>
          Effect.succeed(Redacted.value(token)),
        );
        assert.strictEqual(seen, "at-new");

        const stored = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
        assert.strictEqual(Redacted.value(stored.accessToken), "at-new");
        assert.strictEqual(Redacted.value(Option.getOrThrow(stored.refreshToken)), "rt-new");
        assert.isTrue(Option.isSome(stored.accessTokenExpiresAt));
      }).pipe(
        Effect.provide(
          buildLayer({
            "/token": { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 },
          }),
        ),
      ),
  );

  it.effect(
    "a refresh response omitting refresh_token keeps the previously stored refresh token (RFC 6749 §6)",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const now = yield* DateTime.now;
        const account = yield* accounts.link({
          userId,
          providerId: "acme",
          subject: "sub-keep-refresh",
          tokens: {
            accessToken: Redacted.make("at-old"),
            refreshToken: Option.some(Redacted.make("rt-keep")),
            accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(-1))),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          },
        });
        const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
        yield* tokenAccess.withAccessToken(account.id, () => Effect.void);

        const stored = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
        assert.strictEqual(Redacted.value(stored.accessToken), "at-new");
        assert.strictEqual(Redacted.value(Option.getOrThrow(stored.refreshToken)), "rt-keep");
      }).pipe(Effect.provide(buildLayer({ "/token": { access_token: "at-new" } }))),
  );

  it.effect("an expired access token with no refresh token fails OAuthTokenUnavailable", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const now = yield* DateTime.now;
      const account = yield* accounts.link({
        userId,
        providerId: "acme",
        subject: "sub-no-refresh",
        tokens: {
          accessToken: Redacted.make("at-expired"),
          refreshToken: Option.none(),
          accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(-1))),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        },
      });
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      const failure = yield* tokenAccess
        .withAccessToken(account.id, () => Effect.void)
        .pipe(Effect.flip);
      // No refresh token stored → `OAuthTokenUnavailable`, not a refresh
      // attempt: a stray call would hit the unmatched-fragment 404 below
      // and surface as `OAuthRefreshFailed` instead, failing this
      // assertion.
      assert.strictEqual(failure._tag, "OAuthTokenUnavailable");
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect("an account with no stored provider tokens at all fails OAuthTokenUnavailable", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const account = yield* accounts.link({ userId, providerId: "acme", subject: "sub-bare" });
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      const failure = yield* tokenAccess
        .withAccessToken(account.id, () => Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OAuthTokenUnavailable");
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect("an unknown account id fails OAuthTokenUnavailable", () =>
    Effect.gen(function* () {
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      const unknown = Accounts.AccountId("00000000-0000-0000-0000-000000000000");
      const failure = yield* tokenAccess
        .withAccessToken(unknown, () => Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OAuthTokenUnavailable");
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect(
    "a refresh response with no access_token fails OAuthRefreshFailed and leaves the stored tokens untouched",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const now = yield* DateTime.now;
        const account = yield* accounts.link({
          userId,
          providerId: "acme",
          subject: "sub-refresh-fails",
          tokens: {
            accessToken: Redacted.make("at-old"),
            refreshToken: Option.some(Redacted.make("rt-old")),
            accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(-1))),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          },
        });
        const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
        const failure = yield* tokenAccess
          .withAccessToken(account.id, () => Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthRefreshFailed");

        const stored = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
        assert.strictEqual(Redacted.value(stored.accessToken), "at-old");
        assert.strictEqual(Redacted.value(Option.getOrThrow(stored.refreshToken)), "rt-old");
      }).pipe(Effect.provide(buildLayer({ "/token": {} }))),
  );
});
