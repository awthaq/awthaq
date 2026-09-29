// @awthaq/oauth — OAuthApi
//
// spec/behaviors/16-oauth.md, BEH-EA-121 through BEH-EA-128. This plugin's
// own contract, groups named `oauth` (BEH-EA-004), built the same way
// `@awthaq/password`'s `PasswordApi.ts` builds its own.
//
// Both endpoints answer typed JSON errors on failure rather than a
// redirect-with-`?error=` query param (unlike better-auth's convention) —
// consistent with how `@awthaq/password`'s own contract already
// treats every failure as a typed response, not a redirect; an
// application's own frontend is the one place a user-facing "something
// went wrong" redirect belongs, not this plugin.

import { Api } from "@awthaq/api";
import { Hooks } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** No provider is registered under this id. */
export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()(
  "ProviderNotFound",
  { providerId: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * EEM-004: the provider itself could not be reached in time — a transport
 * failure, a deadline overrun (ECF-001), or a 5xx/429 answer from its token,
 * JWKS, userinfo or discovery endpoint. A 503, distinct from the 400
 * `OAuthCallbackFailed` so a client can tell "try again shortly" from "this
 * flow is dead". Field-less like every uniform error here: it can only be
 * reached after state, cookie and PKCE validation of a flow the caller
 * initiated, so distinguishing it leaks nothing an attacker could use.
 */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()(
  "ProviderUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

/**
 * BEH-EA-122: covers every one of a callback's indistinguishable *protocol*
 * failure reasons uniformly — malformed/unknown/replayed/expired flow state,
 * a correlation-cookie mismatch, a mix-up (`iss`) mismatch, a token endpoint
 * that answered but rejected the exchange (or returned a body that doesn't
 * decode), or a failed `id_token` claim/signature check. Transport, timeout
 * and 5xx failures are `ProviderUnavailable`, split out (EEM-004). Collapsing all of
 * these into one shape is deliberate (research/05-oauth-oidc.md's Q88
 * "unknown state, expired state, and nonce mismatch all ... the same
 * generic ?error" guidance, applied to a typed response instead of a
 * redirect): which specific stage failed is exactly what an attacker
 * probing the callback endpoint should not be able to learn from the
 * response alone.
 */
export class OAuthCallbackFailed extends Schema.TaggedError<OAuthCallbackFailed>()(
  "OAuthCallbackFailed",
  {},
  { httpApiStatus: 400 },
) {}

/**
 * BEH-EA-123: the default, explicit-linking outcome — a callback whose
 * (verified) email matches an existing, unlinked account.
 */
export class AccountExists extends Schema.TaggedError<AccountExists>()(
  "AccountExists",
  { provider: Schema.String },
  { httpApiStatus: 409 },
) {}

export const AuthorizeParams = Schema.Struct({ provider: Schema.String });
export type AuthorizeParams = typeof AuthorizeParams.Type;

export const AuthorizeQuery = Schema.Struct({
  callbackURL: Schema.optional(Schema.String),
  /**
   * BEH-EA-123/model 02's `client.oauth.link` — a plain `"true"` string
   * (query params are always strings on the wire), requires an
   * authenticated caller (checked in the handler, not the contract).
   */
  link: Schema.optional(Schema.String),
});
export type AuthorizeQuery = typeof AuthorizeQuery.Type;

export const CallbackParams = Schema.Struct({ provider: Schema.String });
export type CallbackParams = typeof CallbackParams.Type;

export const CallbackQuery = Schema.Struct({
  code: Schema.String,
  state: Schema.String,
  /** RFC 9207 mix-up countermeasure — validated when the provider sends it. */
  iss: Schema.optional(Schema.String),
});
export type CallbackQuery = typeof CallbackQuery.Type;

export const OAuthGroup = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.get("authorize", "/oauth/:provider/authorize", {
      params: AuthorizeParams,
      query: AuthorizeQuery,
      success: HttpApiSchema.Empty(302),
      // `Api.Unauthenticated` here is the handler's own explicit failure
      // for `?link=true` from an anonymous caller — `OptionalAuthentication`
      // itself never fails (BEH-EA-029/068's own doc comment), it only
      // ever resolves `CurrentPrincipal`, defaulting to anonymous.
      error: [ProviderNotFound, ProviderUnavailable, Api.Unauthenticated],
    }),
  )
  .add(
    HttpApiEndpoint.get("callback", "/oauth/:provider/callback", {
      params: CallbackParams,
      query: CallbackQuery,
      success: HttpApiSchema.Empty(302),
      // Shipping-gap map (.scratch/shipping-gaps), ticket 13: rate-limited.
      // Wayfinder ticket 03 (BCR-004/THS-002): `Hooks.TwoFactorRequired`
      // when a `Hooks.BeforeSessionIssue` tap diverts.
      error: [
        ProviderNotFound,
        ProviderUnavailable,
        OAuthCallbackFailed,
        AccountExists,
        Api.RateLimited,
        Hooks.TwoFactorRequired,
      ],
    }),
  )
  .middleware(Api.OptionalAuthentication);

export const OAuthApi = HttpApi.make("auth").add(OAuthGroup);
