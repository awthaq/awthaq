// @awthaq/device-authorization — DeviceAuthorizationApi
//
// BEH-EA-299 to BEH-EA-304, spec/models/13-device-authorization.md, RFC 8628. The plugin's contract:
//
// - `device_authorization` — the **device-facing back channel**: `POST /device/code` (§3.1/§3.2) and
//   `POST /device/token` (§3.4/§3.5). Form-encoded like every OAuth endpoint, anonymous, and with no CSRF
//   check for the reason `@awthaq/api-key`'s `apikey.token` has none: it is a back-channel POST whose
//   authority is the secret in the request (the device code), a browser never calls it, and a device
//   that is not a browser has no cookie to double-submit.
// - `device_authorization.verification` — the **user-facing page's API**, `POST /device/verify`. It runs
//   under `OptionalAuthentication`: a signed-in user *claims* the code and sees which client asks for what;
//   an anonymous caller (or a different user) learns only `{ user_code, status }`, enough for the page to
//   say "sign in first". CSRF protected, because it changes state for a browser session.
// - `device_authorization.decision` — `POST /device/approve` and `POST /device/deny`, behind
//   `Authentication` (the user tier) and `CsrfProtection`.
//
// Poll answers follow RFC 8628 §3.5: an error body carries the RFC's `error` member beside the typed
// `_tag`, so a stock OAuth 2.0 client library reads it without knowing this contract (the pattern
// `apikey.token` uses for RFC 6749 §5.2).

import { Api } from "@awthaq/api";
import { HookPoint, Users } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** RFC 8628 §3.4: the one `grant_type` the token endpoint accepts. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// ---- errors (device-facing, RFC 6749 §5.2 / RFC 8628 §3.5) ---------------------------------------------

const rfcError = <const Code extends string>(code: Code) =>
  Schema.Literal(code).pipe(Schema.withConstructorDefault(Effect.succeed(code)));

/** A malformed request: a missing parameter, or a `scope` that is not a list of scope tokens. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { error: rfcError("invalid_request") },
  { httpApiStatus: 400 },
) {}

/** The `client_id` is unknown or revoked — one answer for both. */
export class InvalidClient extends Schema.TaggedError<InvalidClient>()(
  "InvalidClient",
  { error: rfcError("invalid_client") },
  { httpApiStatus: 400 },
) {}

/** The requested scope is not one the client is registered for. */
export class InvalidScope extends Schema.TaggedError<InvalidScope>()(
  "InvalidScope",
  { error: rfcError("invalid_scope") },
  { httpApiStatus: 400 },
) {}

export class UnsupportedGrantType extends Schema.TaggedError<UnsupportedGrantType>()(
  "UnsupportedGrantType",
  { error: rfcError("unsupported_grant_type") },
  { httpApiStatus: 400 },
) {}

/**
 * RFC 8628 §3.5: the device code is unknown, belongs to another client, or was already redeemed — one
 * answer for all three, and also what the loser of two concurrent redemptions receives (design
 * constraint 3): a session is minted only for the poll that won the atomic claim.
 */
export class InvalidGrant extends Schema.TaggedError<InvalidGrant>()(
  "InvalidGrant",
  { error: rfcError("invalid_grant") },
  { httpApiStatus: 400 },
) {}

/** RFC 8628 §3.5: the user has not decided yet; keep polling at the current interval. */
export class AuthorizationPending extends Schema.TaggedError<AuthorizationPending>()(
  "AuthorizationPending",
  { error: rfcError("authorization_pending") },
  { httpApiStatus: 400 },
) {}

/**
 * RFC 8628 §3.5: the device polled before its interval had elapsed. The client MUST add 5 seconds to its
 * interval; `interval` (a non-RFC extension member) is the server's new value, so a client can also just adopt it.
 */
export class SlowDown extends Schema.TaggedError<SlowDown>()(
  "SlowDown",
  { error: rfcError("slow_down"), interval: Schema.Number },
  { httpApiStatus: 400 },
) {}

/** RFC 8628 §3.5: the user denied the request (or the sign-in gate refused the session). Terminal. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()(
  "AccessDenied",
  { error: rfcError("access_denied") },
  { httpApiStatus: 400 },
) {}

/** RFC 8628 §3.5: the device code's lifetime elapsed. Terminal; the device restarts the flow. */
export class ExpiredToken extends Schema.TaggedError<ExpiredToken>()(
  "ExpiredToken",
  { error: rfcError("expired_token") },
  { httpApiStatus: 400 },
) {}

// ---- errors (user-facing) ------------------------------------------------------------------------------------

/** The user code is malformed, unknown, expired or already decided: one answer, so the endpoint is not an oracle. */
export class InvalidUserCode extends Schema.TaggedError<InvalidUserCode>()(
  "InvalidUserCode",
  {},
  { httpApiStatus: 404 },
) {}

/** Design constraint 6: approving (or denying) a code this user has not claimed by opening the verification page is refused. */
export class UserCodeNotClaimed extends Schema.TaggedError<UserCodeNotClaimed>()(
  "UserCodeNotClaimed",
  {},
  { httpApiStatus: 409 },
) {}

/** The session is an impersonation (`actingAs`): an administrator must not mint a device login as someone else. */
export class DeviceApprovalRefused extends Schema.TaggedError<DeviceApprovalRefused>()(
  "DeviceApprovalRefused",
  {},
  { httpApiStatus: 403 },
) {}

// ---- wire types -------------------------------------------------------------------------------------------------------

/** RFC 8628 §3.1: form-encoded; `scope` is the space-delimited list of RFC 6749 §3.3. */
export const CodePayload = Schema.Struct({
  client_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  scope: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type CodePayload = typeof CodePayload.Type;

/** RFC 8628 §3.2, with the RFC's snake_case member names. */
export class CodeResponse extends Schema.Class<CodeResponse>("DeviceCodeResponse")({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
}) {}

/** RFC 8628 §3.4. */
export const TokenPayload = Schema.Struct({
  grant_type: Schema.String,
  device_code: Schema.String.check(Schema.isMaxLength(512)),
  client_id: Schema.String.check(Schema.isMaxLength(256)),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type TokenPayload = typeof TokenPayload.Type;

/**
 * RFC 8628 §3.5 / RFC 6749 §5.1: the approved poll's answer. `access_token` is the session's bearer token
 * (a normal session: it authenticates `Authorization: Bearer <token>` and is revoked, listed and expired
 * like any other, BEH-EA-304).
 */
export class TokenResponse extends Schema.Class<TokenResponse>("DeviceTokenResponse")({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.String,
}) {}

/** The verification page's `{ user_code, status }`, plus the context only the claiming user sees. */
export const GrantStatus = Schema.Literals(["pending", "approved", "denied"]);
export type GrantStatus = typeof GrantStatus.Type;

export class VerificationClient extends Schema.Class<VerificationClient>(
  "DeviceVerificationClient",
)({
  client_id: Schema.String,
  name: Schema.String,
}) {}

export class VerificationDto extends Schema.Class<VerificationDto>("DeviceVerificationDto")({
  user_code: Schema.String,
  status: GrantStatus,
  /** Present only for the user who claimed the code (design constraint 6). */
  client: Schema.optional(VerificationClient),
  scope: Schema.optional(Schema.Array(Schema.String)),
  expires_at: Schema.optional(Schema.String),
}) {}

/** What the page posts: the code as the person typed it (normalised server-side). */
export const UserCodePayload = Schema.Struct({
  user_code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type UserCodePayload = typeof UserCodePayload.Type;

export class DecisionDto extends Schema.Class<DecisionDto>("DeviceDecisionDto")({
  user_code: Schema.String,
  status: GrantStatus,
}) {}

// ---- groups ------------------------------------------------------------------------------------------------------------------

export const DeviceGroup = HttpApiGroup.make("device_authorization")
  .add(
    HttpApiEndpoint.post("code", "/device/code", {
      payload: CodePayload,
      success: CodeResponse,
      error: [InvalidRequest, InvalidClient, InvalidScope, Api.RateLimited, Api.StoreUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/device/token", {
      payload: TokenPayload,
      success: TokenResponse,
      // Plain array: each member's own `httpApiStatus` is honoured per member (see `PasswordApi.ts`).
      error: [
        AuthorizationPending,
        SlowDown,
        AccessDenied,
        ExpiredToken,
        InvalidGrant,
        InvalidRequest,
        UnsupportedGrantType,
        Api.RateLimited,
        // NAM-002: a `BeforeSignIn` veto tap refused the session.
        HookPoint.HookAborted,
        // SCP-001: `Users.assertCanSignIn` refused.
        Users.UserSuspended,
        // MA-004: this group has no middleware that declares it, and the session store can be down.
        Api.StoreUnavailable,
      ],
    }),
  )
  // BEH-EA-201: no cookie in, none out, and a device has none to double-submit: `awthaq doctor` skips its CSRF check.
  .annotate(Api.BackChannel, true);

export const VerificationGroup = HttpApiGroup.make("device_authorization.verification")
  .add(
    HttpApiEndpoint.post("verify", "/device/verify", {
      payload: UserCodePayload,
      success: VerificationDto,
      error: [InvalidUserCode, Api.RateLimited],
    }),
  )
  .middleware(Api.OptionalAuthentication)
  .middleware(Api.CsrfProtection);

export const DecisionGroup = HttpApiGroup.make("device_authorization.decision")
  .add(
    HttpApiEndpoint.post("approve", "/device/approve", {
      payload: UserCodePayload,
      success: DecisionDto,
      error: [
        InvalidUserCode,
        UserCodeNotClaimed,
        DeviceApprovalRefused,
        Api.RateLimited,
        HookPoint.HookAborted,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("deny", "/device/deny", {
      payload: UserCodePayload,
      success: DecisionDto,
      error: [InvalidUserCode, UserCodeNotClaimed, DeviceApprovalRefused, Api.RateLimited],
    }),
  )
  // The last-declared middleware runs first, so a forged request is rejected before any credential work.
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const DeviceAuthorizationApi = HttpApi.make("auth")
  .add(DeviceGroup)
  .add(VerificationGroup)
  .add(DecisionGroup);
