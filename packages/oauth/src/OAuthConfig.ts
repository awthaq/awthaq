// @awthaq/oauth — OAuthConfig
//
// The plugin's policy knobs, split out of `OAuth.ts` so the shared provider
// registry (`OAuthProviders.ts`) and the token-access port can read them
// without a module cycle. `OAuth.ts` re-exports everything here, so
// `OAuth.config(...)`/`OAuth.OAuthConfig` keep working unchanged.
//
// PDR-005: `baseUrl` is deliberately a *required* field with no default —
// `OAuthConfig` is a plain `Context.Service` (`JwtConfig`'s precedent, unlike
// the `Context.Reference`-with-default configs elsewhere), so composing OAuth
// without `config({ baseUrl })` fails to type-check instead of silently
// shipping a `http://localhost:3000` redirect_uri.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as OAuthProvider from "./OAuthProvider.ts";

/**
 * ECF-001: one deadline per outbound call class, covering the request *and*
 * its body decode. A call that outlives its deadline is interrupted and
 * surfaces as `ProviderUnavailable` (EEM-004), never a hung auth fiber.
 */
export interface OAuthHttpTimeouts {
  /** The single-use authorization-code exchange and the refresh-token grant. */
  readonly tokenExchange: Duration.Duration;
  readonly jwks: Duration.Duration;
  readonly userinfo: Duration.Duration;
  /** OIDC discovery (`.well-known/openid-configuration`). */
  readonly discovery: Duration.Duration;
}

/**
 * ERS-003: retries for the *idempotent* provider GETs only (JWKS, userinfo,
 * discovery) — jittered exponential backoff inside each call's deadline.
 * The code exchange is never retried: an authorization code is single-use
 * (RFC 6749 §4.1.2), so a replay after an ambiguous failure would turn a
 * transient error into a permanent one.
 */
export interface OAuthRetryPolicy {
  /** Extra attempts after the first (`0` disables retrying). */
  readonly times: number;
  readonly base: Duration.Duration;
}

/** A per-source-IP fixed-window limit (BEH-EA-107/108). */
export interface OAuthRateLimit {
  readonly limit: number;
  readonly window: Duration.Duration;
}

/**
 * OAP-008: both unauthenticated endpoints are throttled per source IP.
 * `authorize` is looser (a real user opening the sign-in page repeatedly is
 * normal) but still bounds the Verification-row and crypto amplification an
 * anonymous caller could otherwise generate; `callback` is tighter because
 * each admitted call may cost a provider round trip.
 */
export interface OAuthRateLimits {
  readonly authorize: OAuthRateLimit;
  readonly callback: OAuthRateLimit;
  /** MNA-003: the native exchange-code redemption (`POST /oauth/token`), also unauthenticated. */
  readonly token: OAuthRateLimit;
}

export interface OAuthConfigShape {
  readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
  /** BEH-EA-123/124: `"explicit"` (default) or an opt-in, per-provider trusted-email-match auto-link list. */
  readonly linking: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
  /** BEH-EA-128: the allowlist a `callbackURL` must resolve to an origin in, or fall back to `defaultCallbackURL`. */
  readonly trustedOrigins: ReadonlyArray<string>;
  /** BEH-EA-128/354: `redirect_uri` is always derived from this, never from request input. */
  readonly baseUrl: string;
  readonly defaultCallbackURL: string;
  /**
   * MNA-004 (RFC 8252 §7.1): the private-use-scheme (or claimed-`https`-less)
   * deep links a *native-mode* flow may return to — e.g. `myapp://oauth/callback`
   * or `com.example.app:/cb`. A requested `callbackURL` is honoured only when its
   * normalized serialization equals an entry or extends it at a path boundary
   * (scheme, authority and path all compared, never just an origin, which is
   * `"null"` for these schemes). `http`, `https`, `javascript`, `data`, `blob`
   * and `file` entries are refused at boot. Default `[]`: native return leg off.
   * Prefer a claimed `https` universal/app link in `trustedOrigins` where the
   * platform supports it.
   */
  readonly nativeRedirectURLs: ReadonlyArray<string>;
  /** MNA-003: how long a native exchange code may be redeemed for (default 60 seconds). It is single-use regardless. */
  readonly nativeExchangeTtl: Duration.Duration;
  readonly httpTimeouts: OAuthHttpTimeouts;
  readonly retry: OAuthRetryPolicy;
  readonly rateLimits: OAuthRateLimits;
  /**
   * OIT-004: leeway applied to an `id_token`'s `exp`, `nbf` and `iat` — the
   * provider's clock and ours are never perfectly aligned (default 60s).
   */
  readonly clockSkew: Duration.Duration;
  /**
   * OIT-004: optional defence in depth — when set, an `id_token` whose `iat`
   * is older than this (or missing) is rejected even if it has not expired.
   */
  readonly maxIdTokenAge: Option.Option<Duration.Duration>;
}

/**
 * What `config(...)` accepts: `baseUrl` is required (the public scheme+host
 * the provider redirects back to — see `OAuth.ts`'s boot validation), and the
 * nested policy objects may be given partially.
 */
export interface OAuthConfigInput extends Partial<
  Omit<OAuthConfigShape, "baseUrl" | "httpTimeouts" | "retry" | "rateLimits" | "maxIdTokenAge">
> {
  readonly baseUrl: string;
  readonly maxIdTokenAge?: Duration.Duration;
  readonly httpTimeouts?: Partial<OAuthHttpTimeouts>;
  readonly retry?: Partial<OAuthRetryPolicy>;
  readonly rateLimits?: Partial<OAuthRateLimits>;
}

const defaults = {
  providers: [],
  linking: "explicit",
  trustedOrigins: [],
  defaultCallbackURL: "/",
  nativeRedirectURLs: [],
  nativeExchangeTtl: Duration.seconds(60),
  httpTimeouts: {
    tokenExchange: Duration.seconds(10),
    jwks: Duration.seconds(5),
    userinfo: Duration.seconds(5),
    discovery: Duration.seconds(10),
  },
  retry: { times: 2, base: Duration.millis(50) },
  rateLimits: {
    authorize: { limit: 30, window: Duration.minutes(1) },
    callback: { limit: 20, window: Duration.minutes(1) },
    token: { limit: 20, window: Duration.minutes(1) },
  },
  clockSkew: Duration.seconds(60),
  maxIdTokenAge: Option.none(),
} satisfies Omit<OAuthConfigShape, "baseUrl">;

export class OAuthConfig extends Context.Service<OAuthConfig, OAuthConfigShape>()(
  "awthaq/oauth/Config",
) {}

export const config = (input: OAuthConfigInput) =>
  Layer.succeed(OAuthConfig, {
    ...defaults,
    ...input,
    maxIdTokenAge: Option.fromNullOr(input.maxIdTokenAge ?? null),
    httpTimeouts: { ...defaults.httpTimeouts, ...input.httpTimeouts },
    retry: { ...defaults.retry, ...input.retry },
    rateLimits: { ...defaults.rateLimits, ...input.rateLimits },
  });
