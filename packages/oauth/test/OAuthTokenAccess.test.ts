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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import * as OAuthTokenAccess from "../src/OAuthTokenAccess.ts";
import { fakeHttpClient, hangingRoute, type FakeRoutes } from "./FakeProvider.ts";

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

const buildLayer = (httpRoutes: FakeRoutes, config?: Partial<OAuth.OAuthConfigInput>) =>
  OAuthTokenAccess.layer.pipe(
    Layer.provideMerge(Accounts.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provide(fakeHttpClient(httpRoutes)),
    Layer.provide(
      OAuth.config({ providers: [acme()], baseUrl: "https://app.example.com", ...config }),
    ),
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
          idToken: Option.none(),
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
            idToken: Option.none(),
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
            idToken: Option.none(),
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
          idToken: Option.none(),
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
            idToken: Option.none(),
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

  it.effect("ESS-003: a refresh response with a non-string access_token fails OAuthRefreshFailed", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const now = yield* DateTime.now;
      const account = yield* accounts.link({
        userId,
        providerId: "acme",
        subject: "sub-refresh-number",
        tokens: {
          accessToken: Redacted.make("at-old"),
          refreshToken: Option.some(Redacted.make("rt-old")),
          idToken: Option.none(),
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
    }).pipe(Effect.provide(buildLayer({ "/token": { access_token: 12345 } }))),
  );

  it.effect("ESS-003: a refresh response whose expires_in is a numeric string still sets the expiry", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const now = yield* DateTime.now;
      const account = yield* accounts.link({
        userId,
        providerId: "acme",
        subject: "sub-refresh-string-expiry",
        tokens: {
          accessToken: Redacted.make("at-old"),
          refreshToken: Option.some(Redacted.make("rt-old")),
          idToken: Option.none(),
          accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(-1))),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        },
      });
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      yield* tokenAccess.withAccessToken(account.id, () => Effect.void);
      const stored = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
      assert.isTrue(Option.isSome(stored.accessTokenExpiresAt));
      assert.isTrue(
        DateTime.isGreaterThan(Option.getOrThrow(stored.accessTokenExpiresAt), now),
      );
    }).pipe(
      Effect.provide(buildLayer({ "/token": { access_token: "at-new", expires_in: "3600" } })),
    ),
  );

  it.effect("ECF-001: a hung refresh call fails OAuthRefreshFailed after the deadline", () => {
    const hang = hangingRoute();
    return Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const now = yield* DateTime.now;
      const account = yield* accounts.link({
        userId,
        providerId: "acme",
        subject: "sub-refresh-hangs",
        tokens: {
          accessToken: Redacted.make("at-old"),
          refreshToken: Option.some(Redacted.make("rt-old")),
          idToken: Option.none(),
          accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(-1))),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        },
      });
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      const fiber = yield* Effect.forkChild(
        tokenAccess.withAccessToken(account.id, () => Effect.void).pipe(Effect.flip),
      );
      yield* hang.reached;
      yield* TestClock.adjust(Duration.seconds(3));
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure._tag, "OAuthRefreshFailed");
    }).pipe(
      Effect.provide(
        buildLayer(
          { "/token": hang.route },
          { httpTimeouts: { tokenExchange: Duration.seconds(3) } },
        ),
      ),
    );
  });

  it.effect("AP-006: the refresh grant authenticates with the provider's resolved method (basic by default)", () => {
    const seen: Array<{ authorization: string | undefined; hasSecretInBody: boolean }> = [];
    return Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const now = yield* DateTime.now;
      const account = yield* accounts.link({
        userId,
        providerId: "acme",
        subject: "sub-refresh-basic",
        tokens: {
          accessToken: Redacted.make("at-old"),
          refreshToken: Option.some(Redacted.make("rt-old")),
          idToken: Option.none(),
          accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(-1))),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        },
      });
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      yield* tokenAccess.withAccessToken(account.id, () => Effect.void);
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0]?.authorization, `Basic ${btoa("acme-client-id:acme-secret")}`);
      assert.isFalse(seen[0]?.hasSecretInBody);
    }).pipe(
      Effect.provide(
        buildLayer({
          "/token": (request: HttpClientRequest.HttpClientRequest) => {
            const body = request.body;
            seen.push({
              authorization: request.headers["authorization"],
              hasSecretInBody:
                body._tag === "Uint8Array" &&
                new URLSearchParams(new TextDecoder().decode(body.body)).has("client_secret"),
            });
            return { access_token: "at-new", expires_in: 3600 };
          },
        }),
      ),
    );
  });

  const refreshWithStoredIdToken = (routes: FakeRoutes, subject: string) =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const now = yield* DateTime.now;
      const account = yield* accounts.link({
        userId,
        providerId: "acme",
        subject,
        tokens: {
          accessToken: Redacted.make("at-old"),
          refreshToken: Option.some(Redacted.make("rt-old")),
          idToken: Option.some(Redacted.make("stored.id.token")),
          accessTokenExpiresAt: Option.some(DateTime.addDuration(now, Duration.seconds(-1))),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        },
      });
      const tokenAccess = yield* OAuthTokenAccess.OAuthTokenAccess;
      yield* tokenAccess.withAccessToken(account.id, () => Effect.void);
      const stored = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
      return Option.map(stored.idToken, Redacted.value);
    }).pipe(Effect.provide(buildLayer(routes)));

  it.effect("BAM-008: a refresh response without an id_token keeps the stored one", () =>
    Effect.gen(function* () {
      const idToken = yield* refreshWithStoredIdToken(
        { "/token": { access_token: "at-new" } },
        "sub-idt-keep",
      );
      assert.deepStrictEqual(idToken, Option.some("stored.id.token"));
    }),
  );

  it.effect("BAM-008: a refresh response carrying an id_token replaces the stored one", () =>
    Effect.gen(function* () {
      const idToken = yield* refreshWithStoredIdToken(
        { "/token": { access_token: "at-new", id_token: "fresh.id.token" } },
        "sub-idt-replace",
      );
      assert.deepStrictEqual(idToken, Option.some("fresh.id.token"));
    }),
  );
});
