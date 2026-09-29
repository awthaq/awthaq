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

import { Api, SessionContract } from "@awthaq/api";
import { HookPoint, Hooks, Users } from "@awthaq/core";
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
 * AP-005 (RFC 6749 §4.1.2.1): the provider redirected back with an
 * authorization *error* instead of a code — most commonly `access_denied`
 * (the user declined consent). Raised only after the correlation cookie and
 * `state` have been validated and the flow consumed, so its enumerated
 * `error` code is echoed to the very browser that initiated the flow and
 * nobody else (an attacker cannot forge a valid state+cookie pair for a
 * victim). `error_description`/`error_uri` are provider-controlled free text
 * and are never echoed; an `error` outside the RFC's enumerated set is a
 * plain `OAuthCallbackFailed`. Decision (2026-09-29): option B of the plan.
 */
export class OAuthAuthorizationDenied extends Schema.TaggedError<OAuthAuthorizationDenied>()(
  "OAuthAuthorizationDenied",
  {
    error: Schema.Literals([
      "access_denied",
      "invalid_request",
      "unauthorized_client",
      "unsupported_response_type",
      "invalid_scope",
      "server_error",
      "temporarily_unavailable",
    ]),
  },
  { httpApiStatus: 400 },
) {}

/** The RFC 6749 §4.1.2.1 error codes `OAuthAuthorizationDenied` can carry. */
export const AuthorizationErrorCode = OAuthAuthorizationDenied.fields.error;

/**
 * BEH-EA-123: the default, explicit-linking outcome — a callback whose
 * (verified) email matches an existing, unlinked account.
 *
 * NAM-006: `providers` are the provider ids the existing account really has
 * (`"password"`, `"passkey"`, another OAuth provider, ...), so a client can
 * drive its "sign in with X, then link" flow. Populated only when the
 * callback's own provider asserted `email_verified` — someone holding an
 * unverified identity for the victim's address is not handed a map of the
 * victim's sign-in methods. Otherwise `[]`. The error's existence is already
 * disclosed by BEH-EA-123 itself; this adds only the method list.
 */
export class AccountExists extends Schema.TaggedError<AccountExists>()(
  "AccountExists",
  { providers: Schema.Array(Schema.String) },
  { httpApiStatus: 409 },
) {}

/**
 * MNA-003: a native-mode authorize request the server cannot honour as asked —
 * a `code_challenge` that is not an S256 digest (43 base64url characters), or
 * one sent without `mode=native`. Rejected rather than dropped: silently
 * discarding a binding the client thinks it has would hand the exchange code
 * to anyone who can read the redirect.
 */
export class InvalidNativeRequest extends Schema.TaggedError<InvalidNativeRequest>()(
  "InvalidNativeRequest",
  {},
  { httpApiStatus: 400 },
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
  /**
   * MNA-003 (wayfinder ticket 17): `native` returns the flow to a deep link with a
   * one-time exchange code instead of a session cookie (which a native app's
   * system browser jar can never hand over). Absent: the browser flow, unchanged.
   */
  mode: Schema.optional(Schema.Literal("native")),
  /**
   * MNA-003: optional PKCE-style binding for the exchange code (RFC 8252 §8.1,
   * private-use-scheme interception): `base64url(SHA-256(verifier))` of a secret
   * the app keeps and presents at redemption as `codeVerifier`. Native mode only.
   */
  code_challenge: Schema.optional(Schema.String),
});
export type AuthorizeQuery = typeof AuthorizeQuery.Type;

export const CallbackParams = Schema.Struct({ provider: Schema.String });
export type CallbackParams = typeof CallbackParams.Type;

export const CallbackQuery = Schema.Struct({
  /** Absent on an authorization-error redirect (RFC 6749 §4.1.2.1), which carries `error` instead. */
  code: Schema.optional(Schema.String),
  state: Schema.String,
  /** AP-005: the RFC 6749 §4.1.2.1 error response members. */
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
  error_uri: Schema.optional(Schema.String),
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
      error: [
        ProviderNotFound,
        ProviderUnavailable,
        Api.Unauthenticated,
        Api.RateLimited,
        InvalidNativeRequest,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("callback", "/oauth/:provider/callback", {
      params: CallbackParams,
      query: CallbackQuery,
      success: HttpApiSchema.Empty(302),
      // Shipping-gap map (.scratch/shipping-gaps), ticket 13: rate-limited.
      // Wayfinder ticket 03 (BCR-004/THS-002): `Hooks.TwoFactorRequired`
      // when a `Hooks.BeforeSessionIssue` tap diverts. NAM-002:
      // `HookPoint.HookAborted` from a `Hooks.BeforeSignIn`/`BeforeSignUp` veto.
      error: [
        ProviderNotFound,
        ProviderUnavailable,
        OAuthCallbackFailed,
        OAuthAuthorizationDenied,
        AccountExists,
        // SCP-001: `Users.assertCanSignIn` refused a suspended user.
        Users.UserSuspended,
        Api.RateLimited,
        HookPoint.HookAborted,
        Hooks.TwoFactorRequired,
      ],
    }),
  )
  .middleware(Api.OptionalAuthentication);

export const ExchangePayload = Schema.Struct({
  /** The `code` query parameter the native redirect carried. */
  code: Schema.String,
  /** Required exactly when the authorize request sent a `code_challenge`. */
  codeVerifier: Schema.optional(Schema.String),
});
export type ExchangePayload = typeof ExchangePayload.Type;

/**
 * MNA-003: the JSON redemption of a native exchange code — the one place the
 * session token leaves the server for an OAuth sign-in that is not a cookie.
 * Deliberately outside the `oauth` group's `OptionalAuthentication`, and with
 * no `CsrfProtection`: it is anonymous, a browser never calls it, and the
 * unguessable single-use code in the body is the whole authorization (CSRF
 * defends ambient credentials, of which this request has none). Answers the
 * same `SessionDto` (with `token`) as password/passkey bearer delivery.
 */
export const OAuthExchangeGroup = HttpApiGroup.make("oauth.exchange").add(
  HttpApiEndpoint.post("token", "/oauth/token", {
    payload: ExchangePayload,
    success: SessionContract.SessionDto,
    error: [OAuthCallbackFailed, Api.RateLimited, Api.StoreUnavailable],
  }),
);

export const OAuthApi = HttpApi.make("auth").add(OAuthGroup).add(OAuthExchangeGroup);
