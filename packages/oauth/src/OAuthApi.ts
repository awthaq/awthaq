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
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

/** No provider is registered under this id. */
export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()(
  "ProviderNotFound",
  { providerId: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * BEH-EA-122: covers every one of a callback's indistinguishable failure
 * reasons uniformly — malformed/unknown/replayed/expired flow state, a
 * correlation-cookie mismatch, a mix-up (`iss`) mismatch, a token-exchange
 * failure, or a failed `id_token` claim/signature check. Collapsing all of
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
      error: [ProviderNotFound, Api.Unauthenticated],
    }),
  )
  .add(
    HttpApiEndpoint.get("callback", "/oauth/:provider/callback", {
      params: CallbackParams,
      query: CallbackQuery,
      success: HttpApiSchema.Empty(302),
      // Shipping-gap map (.scratch/shipping-gaps), ticket 13: rate-limited.
      error: [ProviderNotFound, OAuthCallbackFailed, AccountExists, Api.RateLimited],
    }),
  )
  .middleware(Api.OptionalAuthentication);

export const OAuthApi = HttpApi.make("auth").add(OAuthGroup);
