// @awthaq/oauth — OAuthConfig
//
// The plugin's policy knobs, split out of `OAuth.ts` so the shared provider
// registry (`OAuthProviders.ts`) and the token-access port can read them
// without a module cycle. `OAuth.ts` re-exports everything here, so
// `OAuth.config(...)`/`OAuth.OAuthConfig` keep working unchanged.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
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

export interface OAuthConfigShape {
  readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
  /** BEH-EA-123/124: `"explicit"` (default) or an opt-in, per-provider trusted-email-match auto-link list. */
  readonly linking: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
  /** BEH-EA-128: the allowlist a `callbackURL` must resolve to an origin in, or fall back to `defaultCallbackURL`. */
  readonly trustedOrigins: ReadonlyArray<string>;
  /** BEH-EA-128/354: `redirect_uri` is always derived from this, never from request input. */
  readonly baseUrl: string;
  readonly defaultCallbackURL: string;
  readonly httpTimeouts: OAuthHttpTimeouts;
  readonly retry: OAuthRetryPolicy;
}

/** What `config(...)` accepts: the nested policy objects may be given partially. */
export interface OAuthConfigInput
  extends Partial<Omit<OAuthConfigShape, "httpTimeouts" | "retry">> {
  readonly httpTimeouts?: Partial<OAuthHttpTimeouts>;
  readonly retry?: Partial<OAuthRetryPolicy>;
}

const defaultOAuthConfig: OAuthConfigShape = {
  providers: [],
  linking: "explicit",
  trustedOrigins: [],
  baseUrl: "http://localhost:3000",
  defaultCallbackURL: "/",
  httpTimeouts: {
    tokenExchange: Duration.seconds(10),
    jwks: Duration.seconds(5),
    userinfo: Duration.seconds(5),
    discovery: Duration.seconds(10),
  },
  retry: { times: 2, base: Duration.millis(50) },
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
export const OAuthConfig: Context.Reference<OAuthConfigShape> = Context.Reference(
  "awthaq/oauth/Config",
  { defaultValue: () => defaultOAuthConfig },
);

export const config = (input: OAuthConfigInput): Layer.Layer<never> =>
  Layer.succeed(OAuthConfig, {
    ...defaultOAuthConfig,
    ...input,
    httpTimeouts: { ...defaultOAuthConfig.httpTimeouts, ...input.httpTimeouts },
    retry: { ...defaultOAuthConfig.retry, ...input.retry },
  });
