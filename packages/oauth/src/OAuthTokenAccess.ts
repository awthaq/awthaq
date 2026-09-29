// @awthaq/oauth — OAuthTokenAccess
//
// BE-002 (.issues/high): the second half of this finding's recommended
// fix — "expose a token-refresh port so downstream apps never handle raw
// provider credentials." A separate `Context.Service`, not folded into
// `OAuth`/`OAuthShape` itself: nothing about calling a provider's API on
// an already-linked user's behalf belongs to the authorize/callback HTTP
// flow `OAuth`'s own contract serves, and an application that never needs
// this capability shouldn't have to provide anything for it.
//
// Lives here rather than `@awthaq/ports` (`OAuth.ts`'s own module header):
// a refresh call needs the provider registry — `tokenEndpoint`/`clientId`/
// `clientSecret` per provider — which only this plugin's own `OAuthConfig`
// resolves, and a port in `@awthaq/ports` cannot depend on a plugin
// package.

import { Accounts } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as OAuthConfig from "./OAuthConfig.ts";
import type * as OAuthProvider from "./OAuthProvider.ts";
import * as OAuthProviders from "./OAuthProviders.ts";
import * as ProviderHttp from "./ProviderHttp.ts";
import * as ProviderResponses from "./ProviderResponses.ts";
import * as TokenEndpoint from "./TokenEndpoint.ts";

/** No account, no stored tokens for it, or a stored access token expired with no refresh token to recover it. */
export class OAuthTokenUnavailable extends Data.TaggedError("OAuthTokenUnavailable")<{
  readonly accountId: Accounts.AccountId;
  readonly message: string;
}> {}

/** The provider's own `grant_type=refresh_token` exchange failed or returned no `access_token`. */
export class OAuthRefreshFailed extends Data.TaggedError("OAuthRefreshFailed")<{
  readonly accountId: Accounts.AccountId;
  readonly message: string;
}> {}

export interface OAuthTokenAccessShape {
  /**
   * Reads this account's stored token set, refreshes it first if the
   * access token is expired (or within `REFRESH_SKEW` of expiring) and a
   * refresh token is on record, then hands the (possibly just-refreshed)
   * raw token to `use` — never returning it to the caller, so "downstream
   * apps never handle raw provider credentials" holds structurally, not
   * by convention. A provider whose response carried no `refresh_token`
   * simply can't refresh: this fails `OAuthTokenUnavailable` once the
   * stored access token expires, rather than silently handing `use` a
   * token already rejected by the provider.
   */
  readonly withAccessToken: <A, E, R>(
    accountId: Accounts.AccountId,
    use: (token: Redacted.Redacted<string>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OAuthTokenUnavailable | OAuthRefreshFailed, R>;
}

export class OAuthTokenAccess extends Context.Service<OAuthTokenAccess, OAuthTokenAccessShape>()(
  "awthaq/oauth/OAuthTokenAccess",
) {}

/**
 * A small skew window, not just `now >= accessTokenExpiresAt`: without it,
 * a token that expires between this check and the moment `use`'s own
 * request actually reaches the provider is handed out already-stale,
 * turning a should-have-refreshed case into a provider-side 401 this port
 * exists to prevent.
 */
const REFRESH_SKEW = Duration.seconds(30);

const refresh = (
  httpClient: HttpClient.HttpClient,
  accounts: Accounts.AccountsShape,
  accountId: Accounts.AccountId,
  provider: OAuthProvider.ResolvedProvider,
  refreshToken: Redacted.Redacted<string>,
  previousIdToken: Option.Option<Redacted.Redacted<string>>,
  timeout: Duration.Duration,
): Effect.Effect<Redacted.Redacted<string>, OAuthRefreshFailed> =>
  Effect.gen(function* () {
    const grant: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: Redacted.value(refreshToken),
    };
    // ESS-003: the same schema the code exchange uses — a body without a
    // string `access_token` fails the decode and normalizes to
    // `OAuthRefreshFailed` below.
    // ECF-001: bounded by the token-exchange deadline, request plus decode.
    // Not retried: a refresh token may rotate on use, so a replay after an
    // ambiguous failure could strand the account.
    // AP-006: the same client authentication the code exchange uses.
    const body = yield* httpClient
      .post(provider.tokenEndpoint, TokenEndpoint.clientAuthentication(provider, grant))
      .pipe(
        Effect.flatMap(ProviderHttp.decodeBody(ProviderResponses.TokenResponseSchema)),
        Effect.timeout(timeout),
      );
    const now = yield* DateTime.now;
    const accessToken = Redacted.make(body.access_token);
    // RFC 6749 §6: a provider MAY omit `refresh_token` to mean "keep using
    // the one you already have" — never treated as "the refresh token is
    // gone now," which would strand this account unable to refresh again.
    const nextRefreshToken =
      body.refresh_token === undefined
        ? Option.some(refreshToken)
        : Option.some(Redacted.make(body.refresh_token));
    const nextTokens: Accounts.ProviderTokenSet = {
      accessToken,
      refreshToken: nextRefreshToken,
      // BAM-008: a refresh response usually carries no `id_token` — keep the
      // stored one then, replace it when the provider sends a fresh one.
      idToken:
        body.id_token === undefined ? previousIdToken : Option.some(Redacted.make(body.id_token)),
      accessTokenExpiresAt:
        body.expires_in === undefined
          ? Option.none()
          : Option.some(DateTime.addDuration(now, Duration.seconds(body.expires_in))),
      refreshTokenExpiresAt: Option.none(),
      scope: body.scope === undefined ? Option.none() : Option.some(body.scope),
      tokenType: body.token_type === undefined ? Option.none() : Option.some(body.token_type),
    };
    yield* accounts.updateProviderTokens(accountId, nextTokens).pipe(Effect.orDie);
    return accessToken;
  }).pipe(
    // Mirrors `OAuth.ts`'s own `exchangeCode`: every failure this block can
    // produce — a network error, or a body that doesn't decode as a token
    // response — normalizes to the one typed failure this function promises.
    Effect.catch(
      () =>
        new OAuthRefreshFailed({
          accountId,
          message: `awthaq: token refresh failed for account ${accountId}`,
        }),
    ),
  );

export const layer: Layer.Layer<
  OAuthTokenAccess,
  never,
  Accounts.Accounts | HttpClient.HttpClient | OAuthConfig.OAuthConfig
> = Layer.effect(
  OAuthTokenAccess,
  Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    const httpClient = yield* HttpClient.HttpClient;
    const config_ = yield* OAuthConfig.OAuthConfig;
    // NAM-004: the one shared, already-resolved registry — the same instance
    // `OAuth.layer` reads, so discovery is fetched once per process.
    const providers = yield* OAuthProviders.OAuthProviders;

    const withAccessToken: OAuthTokenAccessShape["withAccessToken"] = (accountId, use) =>
      Effect.gen(function* () {
        const account = yield* accounts.findById(accountId).pipe(
          Effect.catchTag(
            "AccountNotFound",
            () =>
              new OAuthTokenUnavailable({
                accountId,
                message: `awthaq: no such account: ${accountId}`,
              }),
          ),
        );
        const stored = yield* accounts.findProviderTokens(accountId).pipe(
          Effect.catchTags({
            AccountNotFound: () =>
              new OAuthTokenUnavailable({
                accountId,
                message: `awthaq: no such account: ${accountId}`,
              }),
            // SMS-002: an undecryptable stored token means re-consent, not a defect.
            ProviderTokensUnreadable: (error) =>
              new OAuthTokenUnavailable({
                accountId,
                message: `awthaq: stored provider tokens for account ${accountId} are unreadable (${error.reason}); the user must re-authorize`,
              }),
          }),
        );
        if (!(yield* providers.has(account.providerId)) || Option.isNone(stored)) {
          return yield* Effect.fail(
            new OAuthTokenUnavailable({
              accountId,
              message: `awthaq: no stored provider tokens for account ${accountId}`,
            }),
          );
        }
        const tokens = stored.value;
        const now = yield* DateTime.now;
        const expiringSoon =
          Option.isSome(tokens.accessTokenExpiresAt) &&
          DateTime.toEpochMillis(tokens.accessTokenExpiresAt.value) <=
            DateTime.toEpochMillis(DateTime.addDuration(now, REFRESH_SKEW));
        if (!expiringSoon) {
          return yield* use(tokens.accessToken);
        }
        if (Option.isNone(tokens.refreshToken)) {
          return yield* Effect.fail(
            new OAuthTokenUnavailable({
              accountId,
              message: `awthaq: access token expired and no refresh token stored for account ${accountId}`,
            }),
          );
        }
        // Resolved only now that a refresh is actually needed: a lazily
        // discovered provider that is down must not break a still-live token.
        const provider = yield* providers.get(account.providerId).pipe(
          Effect.mapError(
            () =>
              new OAuthRefreshFailed({
                accountId,
                message: `awthaq: provider ${account.providerId} is unavailable for account ${accountId}`,
              }),
          ),
        );
        const refreshed = yield* refresh(
          httpClient,
          accounts,
          accountId,
          provider,
          tokens.refreshToken.value,
          tokens.idToken,
          config_.httpTimeouts.tokenExchange,
        );
        return yield* use(refreshed);
      });

    return OAuthTokenAccess.of({ withAccessToken });
  }),
  // Layers memoize by reference, so a composition that also builds
  // `OAuth.layer` shares this exact registry instance (NAM-004).
).pipe(Layer.provide(OAuthProviders.layer));
