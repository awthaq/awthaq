// @awthaq/oauth — OAuth
//
// spec/behaviors/16-oauth.md, BEH-EA-121 through BEH-EA-128.
// spec/models/02-oauth-oidc.md's plugin sketch, made runnable — the
// generic authorization-code + PKCE + (for `"oidc"` providers) `id_token`
// flow every provider shares, with the provider-specific parts
// (`OAuthProvider.ts`) and the flow-state/linking machinery kept apart the
// way `research/05-oauth-oidc.md`'s Q54 recommends ("model per-provider
// divergence as data presets over one core, not one class per provider").
//
// Scoped deliberately, documented rather than silently assumed: no
// `google()`/`github()`/`apple()` vendor presets (see `OAuthProvider.ts`'s
// own header), and `Jwt.ts`'s own header documents its RS256-only
// signature-verification scope.
//
// BE-002 (.issues/high): the exchanged access/refresh token pair is now
// persisted (`@awthaq/core`'s `Accounts.ProviderTokenSet`, via `link`/
// `updateProviderTokens` in this file's own `callback` handler) rather
// than discarded after the transient userinfo/id-token use, and
// `OAuthTokenAccess.ts` exposes a scoped refresh port so application code
// calling the provider's API on the user's behalf never handles a raw
// token directly.

import { Api } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  Accounts,
  ConstantTime,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Encryption, RateLimiter, SqlTransaction } from "@awthaq/ports";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Jwt from "./Jwt.ts";
import * as OAuthApi from "./OAuthApi.ts";
import { OAuthConfig } from "./OAuthConfig.ts";
import * as OAuthProvider from "./OAuthProvider.ts";
import * as OAuthProviders from "./OAuthProviders.ts";
import * as ProviderHttp from "./ProviderHttp.ts";
import * as ProviderResponses from "./ProviderResponses.ts";

// The policy knobs live in `OAuthConfig.ts` (so the shared provider registry
// can read them without a module cycle); re-exported so `OAuth.config(...)`
// and `OAuth.OAuthConfig` are unchanged for callers.
export { OAuthConfig, config } from "./OAuthConfig.ts";
export type {
  OAuthConfigInput,
  OAuthConfigShape,
  OAuthHttpTimeouts,
  OAuthRetryPolicy,
} from "./OAuthConfig.ts";

const OAUTH_STATE_COOKIE = "__Host-oauth-state";

/**
 * PDR-004: the authorize and callback URLs carry the provider's `code`/`state`
 * in the query string, so neither response may leak them through `Referer`
 * to a subresource or a link followed from a page the redirect lands on.
 * Registered as a pre-response handler so it covers success *and* the
 * framework-encoded typed-error responses alike.
 */
const noReferrer = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "referrer-policy", "no-referrer")),
);

/**
 * CSS-006: the correlation cookie is single-use, so every callback response
 * — success, link, and typed failure — clears it rather than leaving a
 * consumed value in the browser for its remaining ten minutes. Same
 * attributes the cookie was set with, or a conforming browser won't match it.
 */
const expireStateCookie = HttpEffect.appendPreResponseHandler((_request, response) =>
  HttpServerResponse.expireCookie(response, OAUTH_STATE_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  }).pipe(Effect.orDie),
);
const FLOW_TTL = Duration.minutes(10);
const FLOW_PREFIX = "oauth.flow:";
/**
 * JJS-001/KRS-004/OIT-002: bounds how long a provider-removed JWKS key
 * keeps verifying tokens. The kid-miss refetch (see `verifyIdToken`)
 * already converges as soon as a provider *rotates in* a new kid; a TTL
 * additionally converges the case a `kid` cache miss never catches at
 * all — a key the provider has *removed*, with no new kid ever presented
 * to force a refetch.
 */
const JWKS_CACHE_TTL = Duration.minutes(15);

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/**
 * BEH-EA-122: the same `${identifier}.${secret}` round trip
 * `@awthaq/password`'s `Password.ts` uses for its mailed tokens,
 * reproduced here rather than shared — the two callers travel through
 * different transports (a mailed link vs. an OAuth provider's own `state`
 * round trip) and duplicating six lines was judged simpler than a shared
 * abstraction two call sites don't yet justify.
 */
const encodeState = (identifier: string, value: Redacted.Redacted<string>): string =>
  `${identifier}.${Redacted.value(value)}`;

const decodeState = (
  raw: string,
): Option.Option<{ readonly identifier: string; readonly value: Redacted.Redacted<string> }> => {
  const separator = raw.lastIndexOf(".");
  if (separator === -1) return Option.none();
  return Option.some({
    identifier: raw.slice(0, separator),
    value: Redacted.make(raw.slice(separator + 1)),
  });
};

/**
 * BEH-EA-122's own payload sketch: `{ codeVerifier, nonce?, callbackURL,
 * link?, providerId }`. Shipping-gap map (.scratch/shipping-gaps), ticket
 * 19: `codeVerifier`/`nonce` are `Encryption`-produced ciphertext
 * envelopes at rest (this is what `VerificationToken.payload` actually
 * persists), not the raw PKCE material — still typed `string` either way.
 *
 * OIT-006: schema-decoded when read back (it travels through
 * attacker-reachable request state), never a cast-based guard.
 */
const FlowPayloadSchema = Schema.Struct({
  providerId: Schema.String,
  codeVerifier: Schema.String,
  nonce: Schema.optional(Schema.String),
  callbackURL: Schema.String,
  link: Schema.optional(Schema.Struct({ userId: Schema.String })),
});
type FlowPayload = typeof FlowPayloadSchema.Type;
const decodeFlowPayload = Schema.decodeUnknownOption(FlowPayloadSchema);

const generatePkce = (
  crypto: Crypto.Crypto,
): Effect.Effect<{ readonly verifier: string; readonly challenge: string }> =>
  Effect.gen(function* () {
    const verifier = toBase64Url(yield* crypto.randomBytes(32));
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: toBase64Url(digest) };
  }).pipe(Effect.orDie);

/** Only present when there is an issuer — spreading this avoids ever assigning `issuer: undefined` under `exactOptionalPropertyTypes`. */
const issuerField = (issuer: Option.Option<string>): { readonly issuer: string } | {} =>
  Option.isSome(issuer) ? { issuer: issuer.value } : {};

/**
 * BEH-EA-128: a relative (same-origin) destination is always safe; an
 * absolute one is honored only when its origin is on the configured
 * allowlist — anything else silently falls back to the safe default rather
 * than failing the whole request (REQ-EA-353: the handler simply never
 * redirects there, it does not need to error either).
 */
const resolveCallbackURL = (
  raw: string | undefined,
  trustedOrigins: ReadonlyArray<string>,
  fallback: string,
): string => {
  if (raw === undefined) return fallback;
  // OAP-001/AP-001: a bare leading slash alone isn't enough to prove
  // same-origin — a network-path reference (`//evil.com/phish`) or a
  // backslash variant (`/\evil.com/phish`) also starts with `/`, and a
  // browser still resolves either off-origin against the current scheme.
  // Only when the second character is neither `/` nor `\` is `raw`
  // genuinely a same-origin relative path.
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  const parsed = Option.fromNullOr(URL.parse(raw));
  return parsed.pipe(
    Option.filter((url) => trustedOrigins.includes(url.origin)),
    Option.match({ onNone: () => fallback, onSome: () => raw }),
  );
};

const buildAuthorizeUrl = (
  provider: OAuthProvider.ResolvedProvider,
  params: {
    readonly state: string;
    readonly redirectUri: string;
    readonly codeChallenge: string | undefined;
    readonly nonce: string | undefined;
  },
): string => {
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", params.state);
  if (params.codeChallenge !== undefined) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (params.nonce !== undefined) url.searchParams.set("nonce", params.nonce);
  return url.toString();
};

/**
 * BE-002 (.issues/high): `refreshToken`/`expiresIn`/`scope`/`tokenType`
 * carry the rest of a standard OAuth2 token response (RFC 6749 §5.1) this
 * module previously discarded after the transient userinfo/id-token use —
 * `toProviderTokenSet` below maps them onto `@awthaq/core`'s own
 * `Accounts.ProviderTokenSet` for persistence. Deliberately excludes any
 * refresh-token TTL: no standard field carries one (some providers expose
 * a non-standard `refresh_expires_in`; this module doesn't guess at
 * provider-specific extensions), so `ProviderTokenSet.refreshTokenExpiresAt`
 * is always `None` from this module's own conversion.
 */
interface TokenSet {
  readonly accessToken: string;
  readonly idToken: string | undefined;
  readonly refreshToken: string | undefined;
  readonly expiresIn: number | undefined;
  readonly scope: string | undefined;
  readonly tokenType: string | undefined;
}

const exchangeCode = (
  httpClient: HttpClient.HttpClient,
  provider: OAuthProvider.ResolvedProvider,
  input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
  timeout: Duration.Duration,
): Effect.Effect<TokenSet, OAuthApi.OAuthCallbackFailed | OAuthApi.ProviderUnavailable> =>
  Effect.gen(function* () {
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: provider.clientId,
    };
    if (!provider.skipPkce) form["code_verifier"] = input.codeVerifier;
    if (Option.isSome(provider.clientSecret)) {
      form["client_secret"] = Redacted.value(provider.clientSecret.value);
    }
    // ESS-003: decoded at the boundary — a body without a string
    // `access_token` (or with a mistyped member) fails the schema, typed.
    // ECF-001: the deadline covers the request and its body decode. ERS-003:
    // this is the one call that is never retried — the authorization code is
    // single-use (RFC 6749 §4.1.2), so `httpClient` here is the plain client.
    const body = yield* httpClient
      .post(provider.tokenEndpoint, { body: HttpBody.urlParams(form) })
      .pipe(
        Effect.flatMap(ProviderHttp.decodeBody(ProviderResponses.TokenResponseSchema)),
        Effect.timeout(timeout),
      );
    return {
      accessToken: body.access_token,
      idToken: body.id_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      scope: body.scope,
      tokenType: body.token_type,
    };
  }).pipe(Effect.catch((error) => Effect.fail(ProviderHttp.toCallbackFailure(error))));

/** BE-002: the `TokenSet` half of the `Accounts.ProviderTokenSet` conversion — see `TokenSet`'s own comment. */
const toProviderTokenSet = (tokens: TokenSet, now: DateTime.Utc): Accounts.ProviderTokenSet => ({
  accessToken: Redacted.make(tokens.accessToken),
  refreshToken:
    tokens.refreshToken === undefined
      ? Option.none()
      : Option.some(Redacted.make(tokens.refreshToken)),
  accessTokenExpiresAt:
    tokens.expiresIn === undefined
      ? Option.none()
      : Option.some(DateTime.addDuration(now, Duration.seconds(tokens.expiresIn))),
  refreshTokenExpiresAt: Option.none(),
  scope: tokens.scope === undefined ? Option.none() : Option.some(tokens.scope),
  tokenType: tokens.tokenType === undefined ? Option.none() : Option.some(tokens.tokenType),
});

/**
 * BEH-EA-127 (claims side): `iss`/`aud`/`exp`/`nonce` are checked against
 * the provider's own configured issuer/client id and the flow's stored
 * nonce; the signature itself is verified against the provider's JWKS via
 * `Jwt.ts` (RS256 only — see that module's own header comment).
 */
interface JwksCacheEntry {
  readonly jwks: Jwt.Jwks;
  readonly fetchedAt: number;
}

/**
 * OIT-001 (OIDC Core 5.3.2): identity-bearing claims come from the *signed*
 * id_token whenever it carries them; userinfo (an unsigned-by-us bearer
 * response) only enriches the profile (name, picture, …) and can never
 * re-anchor the subject or flip `email_verified`.
 */
const IDENTITY_CLAIMS: ReadonlyArray<string> = ["sub", "email", "email_verified"];

const mergeClaims = (
  idClaims: Record<string, unknown> | undefined,
  userinfoClaims: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const signedIdentity: Record<string, unknown> = {};
  if (idClaims !== undefined) {
    for (const claim of IDENTITY_CLAIMS) {
      if (claim in idClaims) signedIdentity[claim] = idClaims[claim];
    }
  }
  return { ...idClaims, ...userinfoClaims, ...signedIdentity };
};

const verifyIdToken = (
  httpClient: HttpClient.HttpClient,
  jwksCache: Ref.Ref<HashMap.HashMap<string, JwksCacheEntry>>,
  provider: OAuthProvider.ResolvedProvider,
  idToken: string,
  nonce: string | undefined,
  jwksTimeout: Duration.Duration,
): Effect.Effect<
  Record<string, unknown>,
  OAuthApi.OAuthCallbackFailed | OAuthApi.ProviderUnavailable
> =>
  Effect.gen(function* () {
    if (Option.isNone(provider.jwksUri)) {
      return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
    }
    const jwksUri = provider.jwksUri.value;
    const decoded = yield* Jwt.decode(idToken).pipe(
      Effect.mapError(() => new OAuthApi.OAuthCallbackFailed()),
    );
    if (decoded.header.alg !== "RS256") {
      return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
    }

    // ESS-001/GC-001/SFS-002/TTE-001: the provider's JWKS document is
    // untrusted, network-fetched input — decoded via `Schema`, never a
    // cast (`packages/jwt/src/verify.ts`'s own established idiom for the
    // identical shape). A malformed body now fails typed as
    // `OAuthCallbackFailed`, the same as every other check in this
    // function, instead of flowing forward fully typed into `findKey`.
    // ECF-001/EEM-004/ERS-003: `httpClient` is the retrying client; the
    // deadline covers request plus decode, and a transport/timeout/5xx
    // failure is `ProviderUnavailable`, a rejected/malformed document a 400.
    const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
      Effect.flatMap(ProviderHttp.decodeBody(Jwt.JwksDocumentSchema)),
      Effect.timeout(jwksTimeout),
      Effect.tap((jwks) =>
        Ref.update(jwksCache, (cache) =>
          HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
        ),
      ),
      Effect.catch((error) => Effect.fail(ProviderHttp.toCallbackFailure(error))),
    );

    // JJS-001/KRS-004/OIT-002: a TTL'd-out entry is treated the same as a
    // cache miss — refetched below, same as an empty cache.
    const cachedEntry = HashMap.get(yield* Ref.get(jwksCache), provider.id);
    const jwks =
      Option.isSome(cachedEntry) &&
      Date.now() - cachedEntry.value.fetchedAt < Duration.toMillis(JWKS_CACHE_TTL)
        ? cachedEntry.value.jwks
        : yield* fetchAndCacheJwks;

    const jwk = yield* Jwt.findKey(jwks, decoded.header.kid).pipe(
      // A `kid` cache miss gets exactly one refetch — the provider may
      // have rotated keys since this process last cached them.
      Effect.catch(() =>
        fetchAndCacheJwks.pipe(Effect.flatMap((fresh) => Jwt.findKey(fresh, decoded.header.kid))),
      ),
      Effect.catchTag("JwtVerificationError", () => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
    );
    const verified = yield* Jwt.verifyRs256(jwk, decoded.signingInput, decoded.signature).pipe(
      Effect.mapError(() => new OAuthApi.OAuthCallbackFailed()),
    );
    if (!verified) return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());

    const claims = decoded.payload;
    const expectedIssuer = Option.getOrUndefined(provider.issuer);
    const exp = typeof claims["exp"] === "number" ? claims["exp"] : undefined;
    if (
      claims["iss"] !== expectedIssuer ||
      claims["aud"] !== provider.clientId ||
      exp === undefined ||
      Date.now() >= exp * 1000 ||
      (nonce !== undefined && claims["nonce"] !== nonce)
    ) {
      return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
    }
    return claims;
  });

export const OAuthHandlers = HttpApiBuilder.group(
  OAuthApi.OAuthApi,
  "oauth",
  Effect.fnUntraced(function* (handlers) {
    const oauth = yield* OAuth;
    const clientAddress = yield* ClientAddress.ClientAddress;

    return handlers.handleAll({
      authorize: Effect.fnUntraced(function* ({
        params,
        query,
        request,
      }: {
        params: OAuthApi.AuthorizeParams;
        query: OAuthApi.AuthorizeQuery;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        yield* noReferrer;
        const principal = yield* Api.CurrentPrincipal;
        const wantsLink = query.link === "true";
        if (wantsLink && principal._tag !== "User") {
          return yield* Effect.fail(new Api.Unauthenticated());
        }
        const link =
          wantsLink && principal._tag === "User" ? { userId: principal.ref.id } : undefined;
        // OAP-008: resolved through the same `ClientAddress` port as `callback`.
        const resolvedAddress = yield* clientAddress.resolve(request);
        const url = yield* oauth.authorize(params.provider, {
          callbackURL: query.callbackURL,
          link,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
        const response = HttpServerResponse.redirect(url.location);
        return yield* HttpServerResponse.setCookie(response, OAUTH_STATE_COOKIE, url.state, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          // CSS-001: the `__Host-` prefix requires Path=/ exactly (no
          // Domain, Secure) — a narrower path silently voids the prefix
          // and conforming browsers drop the cookie.
          path: "/",
          maxAge: FLOW_TTL,
        }).pipe(Effect.orDie);
      }),

      callback: Effect.fnUntraced(function* ({
        params,
        query,
        request,
      }: {
        params: OAuthApi.CallbackParams;
        query: OAuthApi.CallbackQuery;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        yield* noReferrer;
        yield* expireStateCookie;
        const cookieState = request.cookies[OAUTH_STATE_COOKIE];
        // AGA-001/NHS-003: resolved through the application-provided
        // `ClientAddress` port rather than `request.remoteAddress`
        // directly — behind an L7 gateway/load balancer that's the
        // proxy's own address, collapsing every client into one shared
        // rate-limit bucket unless the composition opts into
        // `ClientAddress.layerTrustedProxy`.
        const resolvedAddress = yield* clientAddress.resolve(request);
        const outcome = yield* oauth.callback(params.provider, {
          code: query.code,
          state: query.state,
          iss: query.iss,
          cookieState,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
        if (outcome.session !== undefined) {
          const response = HttpServerResponse.redirect(outcome.callbackURL);
          return yield* HttpServerResponse.setCookie(
            response,
            Sessions.SESSION_COOKIE_NAME,
            Redacted.value(outcome.session.token),
            Sessions.SESSION_COOKIE_ATTRIBUTES,
          ).pipe(Effect.orDie);
        }
        return HttpServerResponse.redirect(outcome.callbackURL);
      }),
    });
  }),
);

export interface OAuthShape {
  readonly authorize: (
    providerId: string,
    input: {
      readonly callbackURL: string | undefined;
      readonly link: { readonly userId: string } | undefined;
      /** OAP-008: the rate-limit key, exactly as for `callback` — `undefined` shares one "unknown origin" bucket. */
      readonly ip?: string;
    },
  ) => Effect.Effect<
    { readonly location: string; readonly state: string },
    OAuthApi.ProviderNotFound | OAuthApi.ProviderUnavailable | Api.RateLimited
  >;
  readonly callback: (
    providerId: string,
    input: {
      readonly code: string;
      readonly state: string;
      readonly iss: string | undefined;
      readonly cookieState: string | undefined;
      /**
       * Shipping-gap map (.scratch/shipping-gaps), ticket 13: the
       * rate-limit key — no identity exists yet at this point in the
       * flow, so IP is the only sensible strategy (ticket 02's own
       * decision). `undefined` when the handler's own `HttpServerRequest`
       * carries none, which the rate limiter treats as a single shared
       * bucket for "unknown origin" requests, never as unthrottled.
       */
      readonly ip?: string;
    },
  ) => Effect.Effect<
    {
      readonly callbackURL: string;
      readonly session:
        | { readonly session: Sessions.SessionView; readonly token: Redacted.Redacted<string> }
        | undefined;
    },
    | OAuthApi.ProviderNotFound
    | OAuthApi.ProviderUnavailable
    | OAuthApi.OAuthCallbackFailed
    | OAuthApi.AccountExists
    | Api.RateLimited
    | Hooks.TwoFactorRequired
  >;
}

export class OAuth extends AuthPlugin.Service<OAuth, OAuthShape>()("oauth", {
  apiVersion: 1,
  contract: OAuthApi.OAuthApi,
  // BEH-EA-125: an OAuth account is an ordinary `accounts` row (extended
  // with `issuer`, per BEH-EA-125) — this plugin owns no table of its own,
  // the same reasoning `@awthaq/password`'s own `tables: []` documents.
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(OAuth, {
    handlers: OAuthHandlers,
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const events = yield* AuthEvents.AuthEvents;
      const config_ = yield* OAuthConfig;
      const crypto = yield* Crypto.Crypto;
      const httpClient = yield* HttpClient.HttpClient;
      const providers = yield* OAuthProviders.OAuthProviders;
      // ERS-003: the retrying client serves the idempotent GETs (JWKS,
      // userinfo); `httpClient` stays plain for the single-use code exchange.
      const readClient = ProviderHttp.retrying(httpClient, config_.retry);
      const jwksCache = yield* Ref.make(HashMap.empty<string, JwksCacheEntry>());
      const limiter = yield* RateLimiter.RateLimiter;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const encryption = yield* Encryption.Encryption;
      const rateLimitsRegistry = yield* RateLimits.RateLimitsRegistry;
      // AOMS-006/BCR-004 (wayfinder ticket 03): the MFA divert point a
      // future `TwoFactor` plugin taps, consulted at the sign-in-completing
      // path of `callback` only (never `flow.link`, which issues no new
      // session).
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;

      /**
       * Ticket 13: 20 callback attempts per minute per source IP — loose
       * enough not to trip a real user's own retries after a transient
       * provider hiccup, tight enough to bound repeated token-exchange
       * calls (the expensive step — a real network round trip to the
       * provider) against one origin. `undefined` IP (no
       * `HttpServerRequest.remoteAddress`) shares one bucket, never
       * unthrottled.
       */
      const { authorize: AUTHORIZE_RATE_LIMIT, callback: CALLBACK_RATE_LIMIT } =
        config_.rateLimits;
      // The explicit return-type annotation below is a narrow, necessary
      // exception, not a style choice: passing `OAuth` (this class) into
      // anything typed `AuthPlugin.Any` (which itself requires a `layer`
      // field) from within `OAuth`'s own `static readonly layer`
      // initializer is a real TS circularity — see `@awthaq/password`'s
      // `Password.ts` for the identical problem and the same fix, first
      // hit there (ticket 12).
      const registerRateLimitRules: Effect.Effect<void, RateLimits.RateLimitScopeViolation> =
        rateLimitsRegistry
          .register(OAuth, {
            group: "oauth",
            endpoint: "callback",
            key: "ip",
            limit: CALLBACK_RATE_LIMIT.limit,
            window: CALLBACK_RATE_LIMIT.window,
          })
          // OAP-008: `authorize` is throttled too, on its own looser rule.
          .pipe(
            Effect.andThen(
              rateLimitsRegistry.register(OAuth, {
                group: "oauth",
                endpoint: "authorize",
                key: "ip",
                limit: AUTHORIZE_RATE_LIMIT.limit,
                window: AUTHORIZE_RATE_LIMIT.window,
              }),
            ),
          );
      yield* registerRateLimitRules.pipe(Effect.orDie);

      // BEH-EA-127/NAM-004: resolved by the shared `OAuthProviders` registry
      // — boot-mode providers while this layer builds (a mismatched or
      // unfetchable discovery document dies before any request is served),
      // lazy ones on first use.

      const trustedProviders =
        config_.linking === "explicit" ? [] : config_.linking.trustedProviders;

      const authorize: OAuthShape["authorize"] = Effect.fnUntraced(function* (providerId, input) {
        yield* limiter
          .consume({
            key: `oauth:authorize:${input.ip ?? "unknown"}`,
            limit: AUTHORIZE_RATE_LIMIT.limit,
            window: AUTHORIZE_RATE_LIMIT.window,
          })
          .pipe(
            Effect.catchTag(
              "RateLimited",
              (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
            ),
          );
        const provider = yield* providers.get(providerId);
        const callbackURL = resolveCallbackURL(
          input.callbackURL,
          config_.trustedOrigins,
          config_.defaultCallbackURL,
        );
        const { verifier, challenge } = yield* generatePkce(crypto);
        const nonce =
          provider.kind === "oidc"
            ? toBase64Url(yield* crypto.randomBytes(16).pipe(Effect.orDie))
            : undefined;
        const identifier = `${FLOW_PREFIX}${yield* crypto.randomUUIDv7.pipe(Effect.orDie)}`;
        // Ticket 19: encrypted at rest inside `VerificationToken.payload` —
        // `identifier` (this flow's own unique correlation id, generated
        // just above) is the AAD, binding each ciphertext to the one flow
        // it belongs to. `nonce` itself (plaintext, above) still goes to
        // the provider's own authorize URL unencrypted below — that's the
        // normal, correct OIDC wire format, not something this ticket
        // touches; only the *persisted copy* this server reads back at
        // callback time is ciphertext.
        const encryptedCodeVerifier = yield* encryption.encrypt(
          Redacted.make(verifier),
          identifier,
        );
        const encryptedNonce =
          nonce === undefined
            ? undefined
            : yield* encryption.encrypt(Redacted.make(nonce), identifier);
        const payload: FlowPayload = {
          providerId,
          codeVerifier: encryptedCodeVerifier,
          nonce: encryptedNonce,
          callbackURL,
          link: input.link,
        };
        const { value } = yield* verification
          .issue({ identifier, ttl: FLOW_TTL, payload })
          .pipe(Effect.orDie);
        const state = encodeState(identifier, value);
        const redirectUri = `${config_.baseUrl}/oauth/${providerId}/callback`;
        const location = buildAuthorizeUrl(provider, {
          state,
          redirectUri,
          codeChallenge: provider.skipPkce ? undefined : challenge,
          nonce,
        });
        return { location, state };
      });

      const callback: OAuthShape["callback"] = Effect.fnUntraced(function* (providerId, input) {
        yield* limiter
          .consume({
            key: `oauth:callback:${input.ip ?? "unknown"}`,
            limit: CALLBACK_RATE_LIMIT.limit,
            window: CALLBACK_RATE_LIMIT.window,
          })
          .pipe(
            Effect.catchTag(
              "RateLimited",
              (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
            ),
          );
        const provider = yield* providers.get(providerId);
        // BEH-EA-122: the correlation cookie and the returned `state` must
        // agree before the (single-use) Verification entry is even
        // consumed — an attacker who tricks a victim's browser into
        // visiting a callback URL carrying the attacker's own `state`
        // fails here, since the victim's browser never held that cookie.
        // TSS-003: compared in constant time over fixed-length digests, so
        // neither where the values differ nor how long they are is observable.
        const decoded = decodeState(input.state);
        const digest = (value: string) =>
          crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie);
        const cookieMatches =
          input.cookieState !== undefined &&
          ConstantTime.constantTimeEqual(
            yield* digest(input.cookieState),
            yield* digest(input.state),
          );
        if (Option.isNone(decoded) || !cookieMatches) {
          return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
        }
        const { identifier, value } = decoded.value;
        const consumed = yield* verification.consume(identifier, value).pipe(
          Effect.catchTag("TokenConsumed", () => new OAuthApi.OAuthCallbackFailed()),
          Effect.catchTag("PlatformError", Effect.die),
        );
        const decodedFlow = decodeFlowPayload(consumed.payload);
        if (Option.isNone(decodedFlow) || decodedFlow.value.providerId !== providerId) {
          return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
        }
        const flow = decodedFlow.value;

        // Ticket 19: `flow.codeVerifier`/`flow.nonce` are ciphertext at
        // rest (encrypted in `authorize`, above, under this same
        // `identifier` as AAD) — decrypted here, once, right after the
        // payload is validated as this flow's own. A failure (tampered
        // envelope, or a `kid` this `KeyProvider` no longer knows about)
        // is treated the same as every other validation failure in this
        // handler: a real, user-facing `OAuthCallbackFailed`, not a
        // defect — this whole payload traveled through attacker-reachable
        // request state (`input.state`/`input.cookieState`) to get here,
        // even though it's the server's own ciphertext underneath.
        const codeVerifier = yield* encryption.decrypt(flow.codeVerifier, identifier).pipe(
          Effect.map(Redacted.value),
          Effect.catchTags({
            DecryptionFailed: () => new OAuthApi.OAuthCallbackFailed(),
            UnknownKeyId: () => new OAuthApi.OAuthCallbackFailed(),
          }),
        );
        const nonce =
          flow.nonce === undefined
            ? undefined
            : yield* encryption.decrypt(flow.nonce, identifier).pipe(
                Effect.map(Redacted.value),
                Effect.catchTags({
                  DecryptionFailed: () => new OAuthApi.OAuthCallbackFailed(),
                  UnknownKeyId: () => new OAuthApi.OAuthCallbackFailed(),
                }),
              );

        // RFC 9207 mix-up countermeasure: validated whenever the provider sends `iss`.
        if (
          input.iss !== undefined &&
          Option.isSome(provider.issuer) &&
          input.iss !== provider.issuer.value
        ) {
          return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
        }

        const redirectUri = `${config_.baseUrl}/oauth/${providerId}/callback`;
        const tokens = yield* exchangeCode(
          httpClient,
          provider,
          { code: input.code, codeVerifier, redirectUri },
          config_.httpTimeouts.tokenExchange,
        );
        const exchangedAt = yield* DateTime.now;

        const idClaims: Record<string, unknown> | undefined =
          provider.kind === "oidc"
            ? tokens.idToken === undefined
              ? yield* Effect.fail(new OAuthApi.OAuthCallbackFailed())
              : yield* verifyIdToken(
                readClient,
                jwksCache,
                provider,
                tokens.idToken,
                nonce,
                config_.httpTimeouts.jwks,
              )
            : undefined;

        // A plain `"oauth2"` provider (no `id_token` at all, e.g. GitHub)
        // gets its claims from `userinfoEndpoint` instead; an `"oidc"`
        // provider that also exposes one gets both merged — userinfo
        // enriches (it is the more current of the two), but the signed
        // `id_token` wins identity-bearing claims and userinfo's `sub`
        // must equal it (OIT-001, OIDC Core 5.3.2).
        const userinfoClaims: Record<string, unknown> | undefined = Option.isSome(
          provider.userinfoEndpoint,
        )
          ? yield* readClient
              .get(provider.userinfoEndpoint.value, {
                headers: { authorization: `Bearer ${tokens.accessToken}` },
              })
              .pipe(
                Effect.flatMap(ProviderHttp.decodeBody(ProviderResponses.UserinfoSchema)),
                Effect.timeout(config_.httpTimeouts.userinfo),
                Effect.catch((error) => Effect.fail(ProviderHttp.toCallbackFailure(error))),
              )
          : undefined;

        if (
          idClaims !== undefined &&
          userinfoClaims !== undefined &&
          userinfoClaims["sub"] !== idClaims["sub"]
        ) {
          return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
        }

        const profile = provider.mapProfile(mergeClaims(idClaims, userinfoClaims));

        const accountIfLinked = yield* accounts.findByProviderSubject(
          providerId,
          profile.subject,
          Option.getOrUndefined(provider.issuer),
        );

        const targetUserId: Users.UserId = yield* Option.match(accountIfLinked, {
          // BE-002: every successful OAuth sign-in against an
          // already-linked account persists the freshly exchanged token
          // set — previously discarded here on every re-authentication,
          // silently leaving a stale (possibly already-expired) access
          // token as this account's only stored credential.
          onSome: (account) =>
            accounts
              .updateProviderTokens(account.id, toProviderTokenSet(tokens, exchangedAt))
              .pipe(Effect.as(account.userId), Effect.orDie),
          onNone: () =>
            Effect.gen(function* () {
              if (flow.link !== undefined) {
                const userId = Users.UserId(flow.link.userId);
                yield* accounts
                  .link({
                    userId,
                    providerId,
                    subject: profile.subject,
                    tokens: toProviderTokenSet(tokens, exchangedAt),
                    ...issuerField(provider.issuer),
                  })
                  .pipe(
                    Effect.catchTag(
                      "AccountAlreadyLinked",
                      () => new OAuthApi.OAuthCallbackFailed(),
                    ),
                    Effect.orDie,
                  );
                return userId;
              }

              const existing =
                profile.email === undefined
                  ? Option.none()
                  : yield* users.findByEmail(profile.email);

              if (Option.isSome(existing)) {
                const autoLink =
                  trustedProviders.includes(providerId) && profile.emailVerified === true;
                if (!autoLink) {
                  return yield* Effect.fail(
                    new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                  );
                }
                yield* accounts
                  .link({
                    userId: existing.value.id,
                    providerId,
                    subject: profile.subject,
                    tokens: toProviderTokenSet(tokens, exchangedAt),
                    ...issuerField(provider.issuer),
                  })
                  .pipe(Effect.orDie);
                return existing.value.id;
              }

              // BEH-EA-113-adjacent silent sign-up (research/05-oauth-oidc.md
              // Q55): the ecosystem norm for a first-time, non-conflicting
              // OAuth sign-in — no separate "confirm sign-up" step in v1.
              // Shipping-gap map (.scratch/shipping-gaps), ticket 16: `create`
              // and `link` now commit together via `SqlTransaction` — the
              // clearest atomicity gap this codebase had (a failure between
              // the two previously left a real, unlinked, orphaned `User`
              // row with no way back in). `Effect.orDie` on the whole
              // transaction, not just `link`'s own failure — a `SqlError`
              // rolling back the transaction is a defect here the same way
              // every other `.pipe(Effect.orDie)` in this codebase already
              // treats an unexpected persistence failure.
              const name = profile.name ?? profile.email ?? profile.subject;
              const created = yield* sqlTransaction
                .withTransaction(
                  Effect.gen(function* () {
                    const user = yield* users
                      .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
                      .pipe(
                        Effect.catchTag(
                          "EmailAlreadyExists",
                          () =>
                            new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                        ),
                        Effect.catchTag("PlatformError", Effect.die),
                      );
                    yield* accounts
                      .link({
                        userId: user.id,
                        providerId,
                        subject: profile.subject,
                        tokens: toProviderTokenSet(tokens, exchangedAt),
                        ...issuerField(provider.issuer),
                      })
                      .pipe(
                        Effect.catchTags({
                          AccountAlreadyLinked: Effect.die,
                          PlatformError: Effect.die,
                        }),
                      );
                    return user;
                  }),
                )
                // Only the transaction's own `SqlError` dies here — a
                // rolled-back commit is an unexpected persistence failure,
                // the same posture every other `Effect.orDie` in this
                // codebase already takes. `OAuthApi.AccountExists` (from
                // `EmailAlreadyExists` above) is a real, expected outcome
                // and must still reach the caller as itself.
                .pipe(Effect.catchTag("SqlError", Effect.die));
              yield* events.publish({ _tag: "auth.user.created", userId: created.id });
              return created.id;
            }),
        });

        if (flow.link !== undefined) {
          // Linking an already-authenticated caller's own account: no new
          // session, the caller's existing one is untouched.
          return { callbackURL: flow.callbackURL, session: undefined };
        }

        // BCR-004/THS-002: same canonical MFA attachment point
        // `@awthaq/password`'s own `signIn` consults, right before this
        // flow's own `sessions.issue`.
        const point = yield* beforeSessionIssue.run({
          userId: targetUserId,
          strategy: providerId,
        });
        if (point._tag === "Diverted") {
          return yield* Effect.fail(point.value);
        }
        const issued = yield* sessions.issue({ userId: targetUserId }).pipe(Effect.orDie);
        yield* events.publish({
          _tag: "auth.user.signedIn",
          userId: targetUserId,
          strategy: providerId,
        });
        yield* afterSignIn.run({ userId: targetUserId, strategy: providerId });
        return { callbackURL: flow.callbackURL, session: issued };
      });

      return OAuth.of({ authorize, callback });
    }),
    // NAM-004: the shared provider registry, provided here so callers need
    // not wire it; Layers memoize by reference, so `OAuthTokenAccess.layer`
    // in the same composition reuses this very instance.
  }).pipe(Layer.provide(OAuthProviders.layer));
}
