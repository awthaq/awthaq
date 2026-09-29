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

import { AccountContract, Api, SessionContract } from "@awthaq/api";
import {
  Accounts,
  AuthEvents,
  AuthPlugin,
  Errors,
  HookPoint,
  Hooks,
  Observability,
  RateLimits,
  SessionCookie,
  Sessions,
  Tenant,
  Users,
  Verification,
} from "@awthaq/core";
import {
  ClientAddress,
  Defects,
  Encryption,
  Hmac,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Session } from "@awthaq/server";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as CallbackFailure from "./CallbackFailure.ts";
import * as IdToken from "./IdToken.ts";
import * as OAuthApi from "./OAuthApi.ts";
import { OAuthConfig, type OAuthConfigShape, defaultRateLimits } from "./OAuthConfig.ts";
import * as OAuthProvider from "./OAuthProvider.ts";
import * as OAuthProviders from "./OAuthProviders.ts";
import * as ProviderHttp from "./ProviderHttp.ts";
import * as ProviderResponses from "./ProviderResponses.ts";
import * as TokenEndpoint from "./TokenEndpoint.ts";

// The policy knobs live in `OAuthConfig.ts` (so the shared provider registry
// can read them without a module cycle); re-exported so `OAuth.config(...)`
// and `OAuth.OAuthConfig` are unchanged for callers.
export { OAuthConfig, config } from "./OAuthConfig.ts";
export type {
  OAuthConfigInput,
  OAuthConfigShape,
  OAuthHttpTimeouts,
  OAuthRateLimit,
  OAuthRateLimits,
  OAuthRetryPolicy,
} from "./OAuthConfig.ts";

const OAUTH_STATE_COOKIE = "__Host-oauth-state";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * PV-016: the same-site interstitial. A `SameSite=Strict` session cookie set on the response of a
 * navigation the provider began cross-site is stored, but the browser withholds it from every
 * request in that redirect chain, so the landing page's first request looks signed out. Answering
 * a `200` page instead ends the chain: the browser follows the meta refresh as a fresh navigation
 * initiated by a document of this site, and that request carries the cookie. A meta refresh, not a
 * script, so a strict `script-src` CSP cannot block it; the anchor is the no-refresh fallback.
 */
const bouncePage = (location: string) => {
  const target = escapeHtml(location);
  return HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${target}"><title>Signing you in</title></head><body><p>Signing you in&hellip; <a href="${target}">Continue</a></p></body></html>`,
    { contentType: "text/html; charset=utf-8" },
  ).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
};

const FLOW_TTL = Duration.minutes(10);
/** NAM-009: the same bounded http(s) rule the client-writable `image` field has (`AccountContract.ImageUrl`). */
const isImageUrl = Schema.is(AccountContract.ImageUrl);
const FLOW_PREFIX = "oauth.flow:";

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
  /** MNA-003: native mode — the callback returns an exchange code, not a cookie. */
  native: Schema.optional(Schema.Boolean),
  /** MNA-003: the optional S256 challenge the exchange code is bound to. */
  nativeChallenge: Schema.optional(Schema.String),
});
type FlowPayload = typeof FlowPayloadSchema.Type;
const decodeFlowPayload = Schema.decodeUnknownOption(FlowPayloadSchema);

const EXCHANGE_PREFIX = "oauth.exchange:";

/**
 * MNA-003: what a native exchange code stands for, held in `Verification`
 * (atomic single-use, TTL-bound, hashed at rest) for the ~60 seconds between
 * the deep-link redirect and the JSON redemption. The session token is
 * `Encryption`-sealed under the record's own identifier, like the PKCE
 * material in `FlowPayload`, so a database read yields no live credential;
 * `session` is the `SessionDto` snapshot the redemption answers with.
 */
const ExchangePayloadSchema = Schema.Struct({
  token: Schema.String,
  session: Schema.Struct({
    id: Schema.String,
    createdAt: Schema.String,
    lastActiveAt: Schema.String,
    expiresAt: Schema.String,
    userAgent: Schema.NullOr(Schema.String),
    amr: Schema.Array(Schema.String),
  }),
  codeChallenge: Schema.optional(Schema.String),
});
const decodeExchangePayload = Schema.decodeUnknownOption(ExchangePayloadSchema);

/** RFC 7636 S256 challenge shape: the unpadded base64url of a SHA-256 digest. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** MNA-004: schemes that may never be a native redirect, whatever the operator lists. */
const FORBIDDEN_NATIVE_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "javascript:",
  "data:",
  "blob:",
  "file:",
]);

const generatePkce = (
  crypto: Crypto.Crypto,
): Effect.Effect<{ readonly verifier: string; readonly challenge: string }> =>
  Effect.gen(function* () {
    const verifier = toBase64Url(yield* crypto.randomBytes(32));
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: toBase64Url(digest) };
  }).pipe(Effect.orDie);

/**
 * FAMS-006: the `(providerId, subject, issuer)` anchor `callback` looks an
 * account up by (BEH-EA-125), computed from the provider's own config — so a
 * migration/import tool writes exactly the key a sign-in will read and never
 * drifts from it (`issuer` is absent for a plain `"oauth2"` provider).
 */
export const accountAnchorFor = (provider: OAuthProvider.OAuthProviderConfig, subject: string) =>
  Effect.gen(function* () {
    const issuer =
      provider.issuer === undefined ? undefined : yield* OAuthProvider.liftConfig(provider.issuer);
    return { providerId: provider.id, subject, ...(issuer === undefined ? {} : { issuer }) };
  });

/** Only present when there is an issuer — spreading this avoids ever assigning `issuer: undefined` under `exactOptionalPropertyTypes`. */
const issuerField = (issuer: Option.Option<string>): { readonly issuer: string } | {} =>
  Option.isSome(issuer) ? { issuer: issuer.value } : {};

/** MNA-004: why a requested `callbackURL` was discarded for the safe default. */
type CallbackDiscard =
  | "unparseable"
  | "untrusted-origin"
  | "untrusted-native-scheme"
  | "native-mode-required";

/**
 * MNA-004: `raw` is honoured when it normalizes to `entry` or extends it at a
 * path boundary. Compared on the WHATWG-serialized `href` (scheme, authority
 * and path — dot segments resolved, userinfo kept), never on `.origin`, which
 * is the opaque `"null"` for every private-use scheme.
 */
const matchesNativeRedirect = (url: URL, allowlist: ReadonlyArray<URL>): boolean =>
  allowlist.some((entry) => {
    if (url.href === entry.href) return true;
    if (!url.href.startsWith(entry.href)) return false;
    // `myapp://oauth/callback` admits `.../callback/x` and `.../callback?x`, never `.../callbackx`.
    const next = url.href.charAt(entry.href.length);
    return entry.href.endsWith("/") || next === "/" || next === "?" || next === "#";
  });

/**
 * BEH-EA-128: a relative (same-origin) destination is always safe; an
 * absolute http(s) one is honored only when its origin is on the configured
 * allowlist — anything else falls back to the safe default rather than
 * failing the whole request (REQ-EA-353: the handler simply never redirects
 * there, it does not need to error either). MNA-004: a private-use-scheme deep
 * link is honoured only in native mode and only against `nativeRedirectURLs`;
 * every fallback names its reason so the caller can log it.
 */
const resolveCallbackURL = (
  raw: string | undefined,
  options: {
    readonly trustedOrigins: ReadonlyArray<string>;
    readonly nativeRedirects: ReadonlyArray<URL>;
    readonly native: boolean;
    readonly fallback: string;
  },
): { readonly url: string; readonly discarded: Option.Option<CallbackDiscard> } => {
  const fallback = (reason: CallbackDiscard) => ({
    url: options.fallback,
    discarded: Option.some(reason),
  });
  if (raw === undefined) return { url: options.fallback, discarded: Option.none() };
  // OAP-001/AP-001: a bare leading slash alone isn't enough to prove
  // same-origin — a network-path reference (`//evil.com/phish`) or a
  // backslash variant (`/\evil.com/phish`) also starts with `/`, and a
  // browser still resolves either off-origin against the current scheme.
  // Only when the second character is neither `/` nor `\` is `raw`
  // genuinely a same-origin relative path.
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return { url: raw, discarded: Option.none() };
  }
  const parsed = URL.parse(raw);
  if (parsed === null) return fallback("unparseable");
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return options.trustedOrigins.includes(parsed.origin)
      ? { url: raw, discarded: Option.none() }
      : fallback("untrusted-origin");
  }
  // A Set-Cookie on a 302 to `myapp://` is useless to a browser flow, so a
  // deep link is only ever meaningful (and only ever admitted) in native mode.
  if (!options.native) return fallback("native-mode-required");
  return matchesNativeRedirect(parsed, options.nativeRedirects)
    ? { url: raw, discarded: Option.none() }
    : fallback("untrusted-native-scheme");
};

/** MNA-003: `callbackURL` with `code` appended as a query parameter; a relative URL stays relative. */
const withExchangeCode = (callbackURL: string, baseOrigin: string, code: string): string => {
  const parsed = URL.parse(callbackURL, baseOrigin);
  if (parsed === null) return callbackURL;
  parsed.searchParams.set("code", code);
  return callbackURL.startsWith("/")
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.href;
};

/**
 * OIT-007: the only response type this plugin ever requests — authorization
 * code. Pinned here (not a parameter) because `at_hash` validation is
 * deliberately absent (see `Jwt.ts`'s header) and only becomes required if a
 * hybrid/implicit type is ever added.
 */
const RESPONSE_TYPE = "code";

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
  url.searchParams.set("response_type", RESPONSE_TYPE);
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
    const grant: Record<string, string> = {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    };
    if (!provider.skipPkce) grant["code_verifier"] = input.codeVerifier;
    // ESS-003: decoded at the boundary — a body without a string
    // `access_token` (or with a mistyped member) fails the schema, typed.
    // ECF-001: the deadline covers the request and its body decode. ERS-003:
    // this is the one call that is never retried — the authorization code is
    // single-use (RFC 6749 §4.1.2), so `httpClient` here is the plain client.
    // AP-006: the client authenticates per the provider's resolved method.
    const body = yield* httpClient
      .post(provider.tokenEndpoint, TokenEndpoint.clientAuthentication(provider, grant))
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
  }).pipe(Effect.catch((error) => CallbackFailure.providerFailure("token-exchange", error)));

/** BE-002: the `TokenSet` half of the `Accounts.ProviderTokenSet` conversion — see `TokenSet`'s own comment. */
const toProviderTokenSet = (tokens: TokenSet, now: DateTime.Utc): Accounts.ProviderTokenSet => ({
  accessToken: Redacted.make(tokens.accessToken),
  refreshToken:
    tokens.refreshToken === undefined
      ? Option.none()
      : Option.some(Redacted.make(tokens.refreshToken)),
  // BAM-008: kept (encrypted at rest by the repository) for import parity and `id_token_hint`.
  idToken:
    tokens.idToken === undefined ? Option.none() : Option.some(Redacted.make(tokens.idToken)),
  accessTokenExpiresAt:
    tokens.expiresIn === undefined
      ? Option.none()
      : Option.some(DateTime.addDuration(now, Duration.seconds(tokens.expiresIn))),
  refreshTokenExpiresAt: Option.none(),
  scope: tokens.scope === undefined ? Option.none() : Option.some(tokens.scope),
  tokenType: tokens.tokenType === undefined ? Option.none() : Option.some(tokens.tokenType),
});

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

const OAuthFlowHandlers = HttpApiBuilder.group(
  OAuthApi.OAuthApi,
  "oauth",
  Effect.fnUntraced(function* (handlers) {
    const oauth = yield* OAuth;
    const clientAddress = yield* ClientAddress.ClientAddress;
    const configNow = Tenant.configInForce(OAuthConfig, yield* OAuthConfig);

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
        // MNA-003: a `code_challenge` only makes sense for a native flow, and must
        // be an S256 digest — refused, never silently dropped, since dropping it
        // would leave the client believing its exchange code is bound.
        if (
          query.code_challenge !== undefined &&
          (query.mode !== "native" || !S256_CHALLENGE.test(query.code_challenge))
        ) {
          return yield* new OAuthApi.InvalidNativeRequest();
        }
        // OAP-008: resolved through the same `ClientAddress` port as `callback`.
        const resolvedAddress = yield* clientAddress.resolve(request);
        const url = yield* oauth.authorize(params.provider, {
          callbackURL: query.callbackURL,
          link,
          ...(query.mode === "native"
            ? {
                native:
                  query.code_challenge === undefined ? {} : { codeChallenge: query.code_challenge },
              }
            : {}),
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
          ...(query.error === undefined ? {} : { error: query.error }),
          ...(query.error_description === undefined
            ? {}
            : { errorDescription: query.error_description }),
          cookieState,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
          ...Option.match(Headers.get(request.headers, "user-agent"), {
            onNone: () => ({}),
            onSome: (userAgent) => ({ userAgent }),
          }),
        });
        // PV-016: a browser landing (never the native deep link) behind a `SameSite=Strict` session
        // cookie goes through the same-site interstitial so its first request carries the session.
        const cookieConfig = yield* SessionCookie.SessionCookieConfig;
        const bounce =
          (yield* configNow).bounce &&
          outcome.native !== true &&
          SessionCookie.isStrict(cookieConfig);
        const response = bounce
          ? bouncePage(outcome.callbackURL)
          : HttpServerResponse.redirect(outcome.callbackURL);
        if (outcome.session !== undefined) {
          const cookie = yield* SessionCookie.render(
            outcome.session.session,
            outcome.session.token,
          );
          return yield* HttpServerResponse.setCookie(
            response,
            cookie.name,
            cookie.value,
            cookie.options,
          ).pipe(Effect.orDie);
        }
        return response;
      }),
    });
  }),
);

/** MNA-003: `POST /oauth/token` — redeems a native exchange code for the session (with its token). */
const OAuthExchangeHandlers = HttpApiBuilder.group(
  OAuthApi.OAuthApi,
  "oauth.exchange",
  Effect.fnUntraced(function* (handlers) {
    const oauth = yield* OAuth;
    const clientAddress = yield* ClientAddress.ClientAddress;
    return handlers.handleAll({
      token: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: OAuthApi.ExchangePayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const resolvedAddress = yield* clientAddress.resolve(request);
        // Holds a live token: never cacheable (MAPS-008).
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
        );
        // Typed local so declaration emit can name `SessionDto` (TS2883).
        const session: SessionContract.SessionDto = yield* oauth.exchange({
          code: payload.code,
          ...(payload.codeVerifier === undefined ? {} : { codeVerifier: payload.codeVerifier }),
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
        return session;
      }),
    });
  }),
);

export const OAuthHandlers = Layer.mergeAll(OAuthFlowHandlers, OAuthExchangeHandlers);

export interface OAuthShape {
  readonly authorize: (
    providerId: string,
    input: {
      readonly callbackURL: string | undefined;
      readonly link: { readonly userId: string } | undefined;
      /** OAP-008: the rate-limit key, exactly as for `callback` — `undefined` shares one "unknown origin" bucket. */
      readonly ip?: string;
      /**
       * MNA-003: present for a native flow — the callback then returns to the
       * (allowlisted) deep link with a one-time exchange code rather than
       * setting a cookie. `codeChallenge` (S256) binds that code to a secret
       * only the app holds.
       */
      readonly native?: { readonly codeChallenge?: string };
    },
  ) => Effect.Effect<
    { readonly location: string; readonly state: string },
    OAuthApi.ProviderNotFound | OAuthApi.ProviderUnavailable | Api.RateLimited
  >;
  readonly callback: (
    providerId: string,
    input: {
      /** `undefined` on an authorization-error redirect (AP-005), which carries `error` instead. */
      readonly code: string | undefined;
      readonly state: string;
      readonly iss: string | undefined;
      readonly cookieState: string | undefined;
      /** AP-005: the RFC 6749 §4.1.2.1 `error` code, when the provider redirected back with one. */
      readonly error?: string;
      /** Provider-controlled free text: logged at debug level only, never echoed. */
      readonly errorDescription?: string;
      /**
       * Shipping-gap map (.scratch/shipping-gaps), ticket 13: the
       * rate-limit key — no identity exists yet at this point in the
       * flow, so IP is the only sensible strategy (ticket 02's own
       * decision). `undefined` when the handler's own `HttpServerRequest`
       * carries none, which the rate limiter treats as a single shared
       * bucket for "unknown origin" requests, never as unthrottled.
       */
      readonly ip?: string;
      /** CSD-003: the callback request's `User-Agent`, recorded on the issued session (capped by `Sessions.issue`). */
      readonly userAgent?: string;
    },
  ) => Effect.Effect<
    {
      readonly callbackURL: string;
      readonly session:
        | { readonly session: Sessions.SessionView; readonly token: Redacted.Redacted<string> }
        | undefined;
      /** PV-016: `true` when `callbackURL` is a native deep link carrying an exchange code (never bounced). */
      readonly native?: true;
    },
    | OAuthApi.ProviderNotFound
    | OAuthApi.ProviderUnavailable
    | OAuthApi.OAuthCallbackFailed
    | OAuthApi.OAuthAuthorizationDenied
    | OAuthApi.AccountExists
    | Users.UserSuspended
    | Api.RateLimited
    | HookPoint.HookAborted
    | Hooks.TwoFactorRequired
    | Errors.StoreUnavailable
  >;
  /**
   * MNA-003: redeems the exchange code a native callback put in its deep link.
   * Single-use (`Verification.consume`), short-lived (`nativeExchangeTtl`) and,
   * when the authorize request bound one, gated on the matching `codeVerifier`.
   * Every failure is the same opaque `OAuthCallbackFailed`.
   */
  readonly exchange: (input: {
    readonly code: string;
    readonly codeVerifier?: string;
    readonly ip?: string;
  }) => Effect.Effect<
    SessionContract.SessionDto,
    OAuthApi.OAuthCallbackFailed | Api.RateLimited | Errors.StoreUnavailable
  >;
}

export class OAuth extends AuthPlugin.Service<OAuth, OAuthShape>()("oauth", {
  apiVersion: 1,
  contract: OAuthApi.OAuthApi,
  // PV-241: the default throttles (`OAuthConfig.rateLimits` tunes them); mirrors the layer's registrations.
  rateLimits: [
    {
      group: "oauth",
      endpoint: "callback",
      name: "callback",
      dimension: "ip",
      ...defaultRateLimits.callback,
    },
    {
      group: "oauth",
      endpoint: "authorize",
      name: "authorize",
      dimension: "ip",
      ...defaultRateLimits.authorize,
    },
    {
      group: "oauth.exchange",
      endpoint: "token",
      name: "token",
      dimension: "ip",
      ...defaultRateLimits.token,
    },
  ],
  // BEH-EA-125: an OAuth account is an ordinary `accounts` row (extended
  // with `issuer`, per BEH-EA-125) — this plugin owns no table of its own,
  // the same reasoning `@awthaq/password`'s own `tables: []` documents.
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(OAuth, {
    ports: [
      ClientAddress.ClientAddress,
      Encryption.Encryption,
      RateLimiter.RateLimiter,
      SqlTransaction.SqlTransaction,
    ],
    handlers: OAuthHandlers,
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const events = yield* AuthEvents.AuthEvents;
      // EP-007 (ADR-EA-018 Decision 8): the per-request policy — trusted origins, auto-link list,
      // timeouts, clock skew, rate-limit budgets — is decided per operation, so a tenant's
      // `OAuth.config(...)` provided in the calling fiber applies to that request; with none, the
      // build-time value applies exactly as before. Boot-scoped by nature: `baseUrl` (the
      // redirect_uri registered with each provider), `nativeRedirectURLs` (validated here), the
      // provider registry and the retry policy of the shared read client.
      const config_ = yield* OAuthConfig;
      const configNow = Tenant.configInForce(OAuthConfig, config_);
      const crypto = yield* Crypto.Crypto;
      const httpClient = yield* HttpClient.HttpClient;
      const providers = yield* OAuthProviders.OAuthProviders;

      // PDR-005/AGA-005: `baseUrl` is the redirect_uri's only derivation input
      // (BEH-EA-128), so a malformed one is a deployment defect caught here
      // at boot, not a provider-side `redirect_uri_mismatch` at the first
      // sign-in. It must be the public scheme+host+port the provider redirects
      // back to — no path, query or fragment — and Host/X-Forwarded-Host are
      // never consulted. The origin is used (not the raw string) so a
      // trailing slash can't double up in `redirect_uri`.
      const parsedBase = URL.parse(config_.baseUrl);
      if (
        parsedBase === null ||
        (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") ||
        parsedBase.pathname !== "/" ||
        parsedBase.search !== "" ||
        parsedBase.hash !== "" ||
        parsedBase.username !== "" ||
        parsedBase.password !== ""
      ) {
        return yield* Defects.invalidConfiguration(
          "baseUrl",
          `awthaq/oauth: baseUrl "${config_.baseUrl}" must be the public scheme+host ` +
            '(e.g. "https://app.example.com") with no path, query, fragment or credentials',
        );
      }
      const baseOrigin = parsedBase.origin;
      // MNA-004: a native redirect entry is a private-use-scheme URL. An
      // http(s)/javascript/data/... entry would let the allowlist admit the very
      // destinations it exists to keep out, so it is a boot-time defect.
      const nativeRedirects: Array<URL> = [];
      for (const entry of config_.nativeRedirectURLs) {
        const parsedEntry = URL.parse(entry);
        if (parsedEntry === null || FORBIDDEN_NATIVE_SCHEMES.has(parsedEntry.protocol)) {
          return yield* Defects.invalidConfiguration(
            "nativeRedirectURLs",
            `awthaq/oauth: nativeRedirectURLs entry "${entry}" must be a private-use-scheme URL ` +
              '(e.g. "myapp://oauth/callback" or "com.example.app:/cb"), never http(s), javascript, data, blob or file',
          );
        }
        nativeRedirects.push(parsedEntry);
      }
      if (parsedBase.protocol === "http:" && !LOOPBACK_HOSTS.has(parsedBase.hostname)) {
        yield* Effect.logWarning(
          `awthaq/oauth: baseUrl "${config_.baseUrl}" is plain http on a non-loopback host — ` +
            "most providers refuse such a redirect_uri, and the session cookie needs https",
        );
      }
      // So an operator can diff each redirect_uri against the provider console.
      for (const provider of config_.providers) {
        yield* Effect.logInfo(
          `awthaq/oauth: provider "${provider.id}" redirect_uri is ${baseOrigin}/oauth/${provider.id}/callback`,
        );
      }
      // ERS-003: the retrying client serves the idempotent GETs (JWKS,
      // userinfo); `httpClient` stays plain for the single-use code exchange.
      const readClient = ProviderHttp.retrying(httpClient, config_.retry);
      const jwksCaches = yield* IdToken.makeJwksCaches;
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
      // NAM-002: the sign-in veto every sign-in-completing flow consults, and
      // the sign-up veto/observer for the first-login user creation below.
      const beforeSignIn = yield* Hooks.BeforeSignIn;
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const afterSignUp = yield* Hooks.AfterSignUp;

      /**
       * Ticket 13: 20 callback attempts per minute per source IP — loose
       * enough not to trip a real user's own retries after a transient
       * provider hiccup, tight enough to bound repeated token-exchange
       * calls (the expensive step — a real network round trip to the
       * provider) against one origin. `undefined` IP (no
       * `HttpServerRequest.remoteAddress`) shares one bucket, never
       * unthrottled.
       */
      const {
        authorize: AUTHORIZE_RATE_LIMIT,
        callback: CALLBACK_RATE_LIMIT,
        token: TOKEN_RATE_LIMIT,
      } = config_.rateLimits;
      // Only registered above for introspection; enforcement reads the budget in force (EP-007).
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
            // MNA-003: the exchange redemption is anonymous too.
            Effect.andThen(
              rateLimitsRegistry.register(OAuth, {
                group: "oauth.exchange",
                endpoint: "token",
                key: "ip",
                limit: TOKEN_RATE_LIMIT.limit,
                window: TOKEN_RATE_LIMIT.window,
              }),
            ),
          );
      yield* registerRateLimitRules.pipe(Effect.orDie);

      // BEH-EA-127/NAM-004: resolved by the shared `OAuthProviders` registry
      // — boot-mode providers while this layer builds (a mismatched or
      // unfetchable discovery document dies before any request is served),
      // lazy ones on first use.

      const trustedProvidersOf = (config: OAuthConfigShape) =>
        config.linking === "explicit" ? [] : config.linking.trustedProviders;

      /**
       * NAM-006: the provider ids `userId` actually has — never asserted,
       * always read — and only when the callback's own provider vouched for
       * the email (`providerVerified`); otherwise nothing is revealed.
       */
      const conflictingProviders = (userId: Users.UserId, providerVerified: boolean) =>
        providerVerified
          ? accounts
              .listByUser(userId)
              .pipe(Effect.map((linked) => linked.map((account) => account.providerId)))
          : Effect.succeed([]);

      const authorize: OAuthShape["authorize"] = Effect.fnUntraced(function* (providerId, input) {
        const config = yield* configNow;
        // EOTS-007: `RateLimits.enforce` also publishes the breach event, logs and counts it.
        yield* RateLimits.enforce({
          key: `oauth:authorize:${input.ip ?? "unknown"}`,
          limit: config.rateLimits.authorize.limit,
          window: config.rateLimits.authorize.window,
          meta: { group: "oauth", endpoint: "authorize", rule: "authorize", dimension: "ip" },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );
        const provider = yield* providers.get(providerId);
        const nativeChallenge = input.native?.codeChallenge;
        const resolved = resolveCallbackURL(input.callbackURL, {
          trustedOrigins: config.trustedOrigins,
          nativeRedirects,
          native: input.native !== undefined,
          fallback: config.defaultCallbackURL,
        });
        const callbackURL = resolved.url;
        // MNA-004: the request still succeeds (REQ-EA-353) but the operator can see
        // why the deep link they configured did not survive. The URL itself is
        // caller-controlled, so it is logged as data, never interpolated.
        if (Option.isSome(resolved.discarded)) {
          yield* Effect.logWarning(`oauth callbackURL discarded: ${resolved.discarded.value}`).pipe(
            Effect.annotateLogs({
              requested: input.callbackURL ?? "",
              reason: resolved.discarded.value,
              native: input.native !== undefined,
            }),
          );
        }
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
          ...(input.native === undefined
            ? {}
            : {
                native: true,
                ...(nativeChallenge === undefined ? {} : { nativeChallenge }),
              }),
        };
        const { value } = yield* verification
          .issue({ identifier, ttl: FLOW_TTL, payload })
          .pipe(Effect.orDie);
        const state = encodeState(identifier, value);
        const redirectUri = `${baseOrigin}/oauth/${providerId}/callback`;
        const location = buildAuthorizeUrl(provider, {
          state,
          redirectUri,
          codeChallenge: provider.skipPkce ? undefined : challenge,
          nonce,
        });
        return { location, state };
      });

      const callbackFlow: OAuthShape["callback"] = Effect.fnUntraced(function* (providerId, input) {
        const config = yield* configNow;
        // EOTS-007: `RateLimits.enforce` also publishes the breach event, logs and counts it.
        yield* RateLimits.enforce({
          key: `oauth:callback:${input.ip ?? "unknown"}`,
          limit: config.rateLimits.callback.limit,
          window: config.rateLimits.callback.window,
          meta: { group: "oauth", endpoint: "callback", rule: "callback", dimension: "ip" },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
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
          Hmac.constantTimeEqualBytes(yield* digest(input.cookieState), yield* digest(input.state));
        if (Option.isNone(decoded)) return yield* CallbackFailure.callbackFailed("state-malformed");
        if (!cookieMatches) return yield* CallbackFailure.callbackFailed("state-cookie-mismatch");
        const { identifier, value } = decoded.value;
        const consumed = yield* verification
          .consume(identifier, value)
          .pipe(
            Effect.catchTag("Verification/TokenConsumed", () =>
              CallbackFailure.callbackFailed("flow-consumed"),
            ),
          );
        const decodedFlow = decodeFlowPayload(consumed.payload);
        if (Option.isNone(decodedFlow) || decodedFlow.value.providerId !== providerId) {
          return yield* CallbackFailure.callbackFailed("flow-invalid");
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
          Effect.map((decrypted) => Redacted.value(decrypted.plaintext)),
          Effect.catchTags({
            DecryptionFailed: () => CallbackFailure.callbackFailed("decrypt"),
            UnknownKeyId: () => CallbackFailure.callbackFailed("decrypt"),
          }),
        );
        const nonce =
          flow.nonce === undefined
            ? undefined
            : yield* encryption.decrypt(flow.nonce, identifier).pipe(
                Effect.map((decrypted) => Redacted.value(decrypted.plaintext)),
                Effect.catchTags({
                  DecryptionFailed: () => CallbackFailure.callbackFailed("decrypt"),
                  UnknownKeyId: () => CallbackFailure.callbackFailed("decrypt"),
                }),
              );

        // RFC 9207 mix-up countermeasure: validated whenever the provider sends `iss`.
        if (
          input.iss !== undefined &&
          Option.isSome(provider.issuer) &&
          input.iss !== provider.issuer.value
        ) {
          return yield* CallbackFailure.callbackFailed("iss-mismatch");
        }

        // AP-005 (RFC 6749 §4.1.2.1): an authorization-error redirect (no
        // `code`) ends the flow here — state, cookie and provider were
        // validated and the single-use flow entry is already consumed above,
        // so a denial can't be replayed into an exchange. An enumerated
        // `error` code is surfaced typed; anything else is the uniform
        // failure. `error_description`/`error_uri` are never echoed.
        if (input.error !== undefined || input.code === undefined) {
          yield* Effect.logDebug("oauth authorization error redirect").pipe(
            Effect.annotateLogs({
              error: input.error ?? "(no code)",
              ...(input.errorDescription === undefined
                ? {}
                : { errorDescription: input.errorDescription }),
            }),
          );
          const code = Schema.decodeUnknownOption(OAuthApi.AuthorizationErrorCode)(input.error);
          return yield* Option.match(code, {
            onNone: () => CallbackFailure.callbackFailed("error-redirect"),
            onSome: (error) => Effect.fail(new OAuthApi.OAuthAuthorizationDenied({ error })),
          });
        }

        const redirectUri = `${baseOrigin}/oauth/${providerId}/callback`;
        const tokens = yield* exchangeCode(
          httpClient,
          provider,
          { code: input.code, codeVerifier, redirectUri },
          config.httpTimeouts.tokenExchange,
        );
        const exchangedAt = yield* DateTime.now;

        // OIT-006: an oidc flow always carries a nonce (authorize mints one),
        // so a flow payload without one is refused rather than verified
        // without the replay/injection binding.
        const idClaims: Record<string, unknown> | undefined =
          provider.kind === "oidc"
            ? tokens.idToken === undefined
              ? yield* CallbackFailure.callbackFailed("id-token-missing")
              : nonce === undefined
                ? yield* CallbackFailure.callbackFailed("missing-nonce")
                : yield* IdToken.verify({
                    httpClient: readClient,
                    jwksCaches,
                    provider,
                    idToken: tokens.idToken,
                    nonce,
                    jwksTimeout: config.httpTimeouts.jwks,
                    clockSkew: config.clockSkew,
                    maxIdTokenAge: config.maxIdTokenAge,
                  })
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
                Effect.timeout(config.httpTimeouts.userinfo),
                Effect.catch((error) => CallbackFailure.providerFailure("userinfo", error)),
              )
          : undefined;

        if (
          idClaims !== undefined &&
          userinfoClaims !== undefined &&
          userinfoClaims["sub"] !== idClaims["sub"]
        ) {
          return yield* CallbackFailure.callbackFailed("userinfo-sub-mismatch");
        }

        const profile = provider.mapProfile(mergeClaims(idClaims, userinfoClaims));
        // A claim set that yields no stable identifier (a userinfo body with
        // no `id`/`sub`, a `mapProfile` reading the wrong field) must never
        // become an account keyed on an empty or missing subject.
        if (typeof profile.subject !== "string" || profile.subject === "") {
          return yield* CallbackFailure.callbackFailed("no-subject");
        }

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
                    Effect.catchTag("AccountAlreadyLinked", () =>
                      CallbackFailure.callbackFailed("account-already-linked"),
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
                // TMS-007: auto-link needs *both* sides proven — the provider
                // asserts the email is verified AND the local account's own
                // email is already verified. An unverified local account may
                // have been registered by someone squatting the address, and
                // linking a trusted identity into it would hand them the
                // victim's account the moment anything verifies that email.
                const autoLink =
                  trustedProvidersOf(config).includes(providerId) &&
                  profile.emailVerified === true &&
                  Users.isEmailVerified(existing.value);
                if (!autoLink) {
                  return yield* Effect.fail(
                    new OAuthApi.AccountExists({
                      providers: yield* conflictingProviders(
                        existing.value.id,
                        profile.emailVerified === true,
                      ),
                    }),
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
              // NAM-002/SCP-008: creation via OAuth is still a sign-up, so the
              // same `BeforeSignUp` veto guards it (its `strategy` is the
              // provider id), before anything is written.
              const vetoedSignUp = yield* HookPoint.aborted(Hooks.BeforeSignUp)(
                beforeSignUp.run({
                  ...(profile.email === undefined ? {} : { email: profile.email }),
                  name,
                  strategy: providerId,
                }),
              );
              const created = yield* sqlTransaction
                .withTransaction(
                  Effect.gen(function* () {
                    // FAMS-002: a profile with no email creates an Anonymous
                    // user (upgradeable through `Users.promoteIdentity`) — the
                    // synthetic `${providerId}:${subject}` placeholder email
                    // this used to fabricate is gone.
                    const user = yield* users
                      .create({
                        identity:
                          vetoedSignUp.email === undefined
                            ? { _tag: "Anonymous" }
                            : { _tag: "Email", email: vetoedSignUp.email },
                        name: vetoedSignUp.name,
                        // NAM-009: an http(s) avatar only — see `OAuthProfile.image`.
                        ...(profile.image !== undefined && isImageUrl(profile.image)
                          ? { image: profile.image }
                          : {}),
                      })
                      .pipe(
                        Effect.catchTag("Users/EmailAlreadyExists", () =>
                          // A concurrent sign-up claimed the address between
                          // our lookup and this insert: report whatever the
                          // winner has, or nothing if it isn't visible yet.
                          (profile.email === undefined
                            ? Effect.succeed(Option.none())
                            : users.findByEmail(profile.email)
                          ).pipe(
                            Effect.flatMap((winner) =>
                              Option.isSome(winner)
                                ? conflictingProviders(
                                    winner.value.id,
                                    profile.emailVerified === true,
                                  )
                                : Effect.succeed([]),
                            ),
                            Effect.flatMap(
                              (providers) => new OAuthApi.AccountExists({ providers }),
                            ),
                          ),
                        ),
                        // FAMS-002: no phone identity is created here.
                        Effect.catchTag("Users/PhoneAlreadyExists", Effect.die),
                      );
                    // AOMS-007: a *trusted* provider's `email_verified` claim
                    // is proof enough to mark the new local user verified, in
                    // the same transaction. Deliberately not for an untrusted
                    // provider — that claim must not flip local state TMS-007's
                    // auto-link gate later relies on — and never on the
                    // auto-link/explicit-link paths, whose local account keeps
                    // its own verification state.
                    if (
                      profile.email !== undefined &&
                      profile.emailVerified === true &&
                      trustedProvidersOf(config).includes(providerId)
                    ) {
                      yield* users.verifyEmail(user.id).pipe(Effect.orDie);
                    }
                    yield* accounts
                      .link({
                        userId: user.id,
                        providerId,
                        subject: profile.subject,
                        tokens: toProviderTokenSet(tokens, exchangedAt),
                        ...issuerField(provider.issuer),
                      })
                      .pipe(Effect.catchTag("AccountAlreadyLinked", Effect.die));
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
              yield* afterSignUp.run({
                userId: created.id,
                ...(vetoedSignUp.email === undefined ? {} : { email: vetoedSignUp.email }),
                strategy: providerId,
              });
              return created.id;
            }),
        });

        if (flow.link !== undefined) {
          // Linking an already-authenticated caller's own account: no new
          // session, the caller's existing one is untouched.
          return { callbackURL: flow.callbackURL, session: undefined };
        }

        // SCP-001/BAM-005: THE shared sign-in gate — the provider proved the
        // identity; a suspended user still gets no session.
        const signedInUser = yield* users
          .findById(targetUserId)
          .pipe(Effect.orDie, Effect.tap(Users.assertCanSignIn));
        // NAM-002: the sign-in veto, before the MFA divert point below.
        const signedInEmail = Users.emailOf(signedInUser);
        yield* HookPoint.aborted(Hooks.BeforeSignIn)(
          beforeSignIn.run({
            userId: targetUserId,
            ...(Option.isSome(signedInEmail) ? { email: signedInEmail.value } : {}),
            strategy: providerId,
          }),
        );

        // BCR-004/THS-002: same canonical MFA attachment point
        // `@awthaq/password`'s own `signIn` consults, right before this
        // flow's own `sessions.issue`.
        const point = yield* beforeSessionIssue.run({
          userId: targetUserId,
          strategy: providerId,
          amr: ["fed"],
        });
        if (point._tag === "Diverted") {
          return yield* Effect.fail(point.value);
        }
        // CSD-003: the callback request is the browser's own, so its
        // address and user agent are what the device list should show.
        const issued = yield* sessions
          .issue({
            userId: targetUserId,
            request: {
              ...(input.ip !== undefined ? { ip: input.ip } : {}),
              ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
            },
            amr: ["fed"],
          })
          .pipe(Effect.orDie);
        yield* events.publish({
          _tag: "auth.user.signedIn",
          userId: targetUserId,
          strategy: providerId,
        });
        yield* afterSignIn.run({ userId: targetUserId, strategy: providerId });
        if (flow.native !== true) return { callbackURL: flow.callbackURL, session: issued };

        // MNA-003 (ticket 17): a native app can only receive the deep-link URL, so
        // the session goes into a short-lived, single-use exchange record and the
        // redirect carries that record's code: never the session token itself,
        // which would land in OS-level URL history and logs.
        const exchangeIdentifier = `${EXCHANGE_PREFIX}${yield* crypto.randomUUIDv7.pipe(Effect.orDie)}`;
        // MW-008: the DTO holds `DateTime.Utc`; the stored snapshot is its wire (ISO string) form.
        const dto = yield* Schema.encodeEffect(SessionContract.SessionDto)(
          Session.toSessionDto(issued.session),
        ).pipe(Effect.orDie);
        const exchangePayload: typeof ExchangePayloadSchema.Type = {
          token: yield* encryption.encrypt(issued.token, exchangeIdentifier),
          session: {
            id: dto.id,
            createdAt: dto.createdAt,
            lastActiveAt: dto.lastActiveAt,
            expiresAt: dto.expiresAt,
            userAgent: dto.userAgent,
            amr: dto.amr ?? [],
          },
          ...(flow.nativeChallenge === undefined ? {} : { codeChallenge: flow.nativeChallenge }),
        };
        const exchange = yield* verification
          .issue({
            identifier: exchangeIdentifier,
            ttl: config.nativeExchangeTtl,
            payload: exchangePayload,
            userId: targetUserId,
          })
          .pipe(Effect.orDie);
        return {
          callbackURL: withExchangeCode(
            flow.callbackURL,
            baseOrigin,
            encodeState(exchangeIdentifier, exchange.value),
          ),
          session: undefined,
          native: true,
        };
      });

      /**
       * CSD-004: a rejected callback (bad state, cookie mismatch, replayed flow,
       * failed token exchange or ID-token check) is the OAuth strategy's failure
       * signal — `auth.user.signInFailed`, so a detector sees every strategy. The
       * provider's own "user said no" redirect and an availability failure are not.
       */
      const callback: OAuthShape["callback"] = (providerId, input) =>
        callbackFlow(providerId, input).pipe(
          Effect.tapError((error) =>
            error._tag === "OAuthCallbackFailed"
              ? events.publish({
                  _tag: "auth.user.signInFailed",
                  strategy: providerId,
                  reason: "callbackRejected",
                  ...(input.ip === undefined ? {} : { clientIp: input.ip }),
                })
              : Effect.void,
          ),
          // EOTS-001: `awthaq.oauth.callback`, with the provider id (a configured, bounded label).
          Observability.authSpan("awthaq.oauth.callback", {
            "awthaq.plugin": "oauth",
            [Observability.Field.strategy]: providerId,
          }),
        );

      const exchange: OAuthShape["exchange"] = Effect.fnUntraced(function* (input) {
        const config = yield* configNow;
        yield* RateLimits.enforce({
          key: `oauth:token:${input.ip ?? "unknown"}`,
          limit: config.rateLimits.token.limit,
          window: config.rateLimits.token.window,
          meta: { group: "oauth.exchange", endpoint: "token", rule: "token", dimension: "ip" },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );
        const decoded = decodeState(input.code);
        // The prefix is checked BEFORE `consume`: consuming is destructive, and
        // this endpoint must never burn (or redeem) a `Verification` value issued
        // for another purpose, such as an in-flight OAuth flow's own `state`.
        if (Option.isNone(decoded) || !decoded.value.identifier.startsWith(EXCHANGE_PREFIX)) {
          return yield* CallbackFailure.callbackFailed("exchange-malformed");
        }
        const { identifier, value } = decoded.value;
        const consumed = yield* verification
          .consume(identifier, value)
          .pipe(
            Effect.catchTag("Verification/TokenConsumed", () =>
              CallbackFailure.callbackFailed("exchange-consumed"),
            ),
          );
        const record = decodeExchangePayload(consumed.payload);
        if (Option.isNone(record)) return yield* CallbackFailure.callbackFailed("exchange-invalid");
        // The code is already spent, so a wrong or missing verifier is one guess
        // gone, not a retry: constant-time over fixed-length digests.
        if (record.value.codeChallenge !== undefined) {
          const presented =
            input.codeVerifier === undefined
              ? undefined
              : toBase64Url(
                  yield* crypto
                    .digest("SHA-256", new TextEncoder().encode(input.codeVerifier))
                    .pipe(Effect.orDie),
                );
          const digest = (text: string) =>
            crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.orDie);
          const matches =
            presented !== undefined &&
            Hmac.constantTimeEqualBytes(
              yield* digest(presented),
              yield* digest(record.value.codeChallenge),
            );
          if (!matches) return yield* CallbackFailure.callbackFailed("exchange-verifier");
        }
        const token = yield* encryption.decrypt(record.value.token, identifier).pipe(
          Effect.map((decrypted) => Redacted.value(decrypted.plaintext)),
          Effect.catchTags({
            DecryptionFailed: () => CallbackFailure.callbackFailed("decrypt"),
            UnknownKeyId: () => CallbackFailure.callbackFailed("decrypt"),
          }),
        );
        return yield* Schema.decodeUnknownEffect(SessionContract.SessionDto)({
          ...record.value.session,
          current: true,
          token,
        }).pipe(
          Effect.catchTag("SchemaError", () => CallbackFailure.callbackFailed("exchange-invalid")),
        );
      });

      return OAuth.of({ authorize, callback, exchange });
    }),
    // NAM-004: the shared provider registry, provided here so callers need
    // not wire it; Layers memoize by reference, so `OAuthTokenAccess.layer`
    // in the same composition reuses this very instance.
  }).pipe(Layer.provide(OAuthProviders.layer));
}
