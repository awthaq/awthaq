// @awthaq/password — PasswordApi
//
// spec/behaviors/15-password.md, BEH-EA-113, BEH-EA-114, BEH-EA-117, BEH-EA-120.
// The plugin's own contract, groups named `password` (BEH-EA-004: a
// plugin's groups are confined to its own id or a dotted sub-id) — built the
// same way `@awthaq/api`'s core `session` group is (`packages/api/src/Session.ts`),
// since a plugin's contract is stratum-1-shaped even though it lives in the
// plugin's own package (`spec/overview.md`: "Each plugin's own groups,
// schemas, errors, and contract `HttpApi`").

import { Api, EmailContract, SessionContract } from "@awthaq/api";
import { HookPoint, Hooks, Users } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** BEH-EA-120: `422 WeakPassword { hints }` — too short, or (when `breachCheck` is on) found in a breach corpus. */
export class WeakPassword extends Schema.TaggedError<WeakPassword>()(
  "WeakPassword",
  { hints: Schema.Array(Schema.String) },
  { httpApiStatus: 422 },
) {}

/**
 * Not part of BEH-EA-113's own illustrative error union (`Effect<SessionView,
 * WeakPassword>`) — that sketch simply doesn't address what happens when the
 * email is already registered. `Users.create` (BEH-EA-041) already returns a
 * real, distinct `EmailAlreadyExists` for exactly this case; leaving it
 * unmapped here would mean every duplicate sign-up dies as an unhandled
 * defect instead of a request-level failure, which is worse than filling the
 * gap explicitly. `409` (not `401`/`422`) since this is a genuinely different
 * condition from a weak password or an authentication failure.
 */
export class EmailAlreadyExists extends Schema.TaggedError<EmailAlreadyExists>()(
  "EmailAlreadyExists",
  {},
  { httpApiStatus: 409 },
) {}

/**
 * BEH-EA-059/117: `confirmReset`'s failure mode is a bad/expired/replayed
 * reset token, not a wrong password — the wire shape BEH-EA-059 itself
 * fixes (`410 TokenConsumed`), reproduced here as this plugin's own schema
 * error since no shared `verification` contract group exists yet for it to
 * come from instead (see `@awthaq/api`'s own header comment on what is
 * and isn't built yet).
 */
export class TokenConsumed extends Schema.TaggedError<TokenConsumed>()(
  "TokenConsumed",
  {},
  { httpApiStatus: 410 },
) {}

/**
 * Upstream-hardening map, ticket 04: `signIn`'s hard block on an
 * unverified account, checked only after password verification succeeds
 * (BEH-EA-114's uniform-cost discipline — a wrong password can never be
 * distinguished from an unverified one). `403`, not upstream's `400` —
 * matching `EmailAlreadyExists`'s own precedent of picking the
 * semantically-correct code: credentials are valid, the account state
 * forbids proceeding.
 */
export class EmailNotVerified extends Schema.TaggedError<EmailNotVerified>()(
  "EmailNotVerified",
  {},
  { httpApiStatus: 403 },
) {}

/**
 * ARF-005 (BEH-EA-232): the account has a second factor and the reset request carried none — the
 * `Hooks.BeforeCredentialReset` veto refused with code `TWO_FACTOR_REQUIRED`. `401`, like
 * `Hooks.TwoFactorRequired` at sign-in: the emailed link was valid, but that alone no longer
 * suffices; clients branch on `_tag` and resubmit with `secondFactorCode`. Any other veto code
 * reaches the caller as the generic `HookAborted`.
 */
export class SecondFactorRequired extends Schema.TaggedError<SecondFactorRequired>()(
  "SecondFactorRequired",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * ESS-006: config-independent ceiling on a submitted password. `minLength` and
 * the breach check live in `checkPolicy` because they read the runtime
 * `PasswordConfig`, which a static schema cannot; the upper bound needs no
 * config and stops a multi-megabyte "password" from reaching the hasher
 * (hash-wasm input cost is linear in its length).
 */
export const MAX_PASSWORD_LENGTH = 1024;
const PasswordInput = Schema.Redacted(Schema.String.check(Schema.isMaxLength(MAX_PASSWORD_LENGTH)));

export const SignUpPayload = Schema.Struct({
  email: EmailContract.Email,
  password: PasswordInput,
});
export type SignUpPayload = typeof SignUpPayload.Type;

export const SignInPayload = Schema.Struct({
  email: EmailContract.Email,
  password: PasswordInput,
});
export type SignInPayload = typeof SignInPayload.Type;

/** BEH-EA-064/117: answered identically whether or not `email` resolves to an account. */
export const RequestResetPayload = Schema.Struct({
  email: EmailContract.Email,
});
export type RequestResetPayload = typeof RequestResetPayload.Type;

/** Upstream-hardening map, ticket 04: same shape as `RequestResetPayload` — answered identically regardless of whether `email` resolves to an account, or is already verified. */
export const ResendVerificationPayload = Schema.Struct({
  email: EmailContract.Email,
});
export type ResendVerificationPayload = typeof ResendVerificationPayload.Type;

export const ConfirmResetPayload = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  password: PasswordInput,
  /**
   * ARF-005: a TOTP or recovery code, required only when the account has a second factor
   * (`@awthaq/two-factor`'s `credentialResetGate`); ignored otherwise.
   */
  secondFactorCode: Schema.optionalKey(Schema.Redacted(Schema.String)),
});
export type ConfirmResetPayload = typeof ConfirmResetPayload.Type;

export const VerifyEmailPayload = Schema.Struct({
  token: Schema.Redacted(Schema.String),
});
export type VerifyEmailPayload = typeof VerifyEmailPayload.Type;

export const ChangePasswordPayload = Schema.Struct({
  currentPassword: PasswordInput,
  newPassword: PasswordInput,
});
export type ChangePasswordPayload = typeof ChangePasswordPayload.Type;

/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
 * (AAPS-001): the password-credential half of the step-up discharge path —
 * re-submits the current password to refresh the session's own
 * `authenticatedAt` without minting a new session (unlike `changePassword`,
 * which mints and returns a fresh, superseding one).
 */
export const ReauthenticatePayload = Schema.Struct({
  password: PasswordInput,
});
export type ReauthenticatePayload = typeof ReauthenticatePayload.Type;

/**
 * Shipping-gap map (.scratch/shipping-gaps), ticket 11: a wrong current
 * password is a distinct condition from "not authenticated at all"
 * (`Api.Unauthenticated`, from this endpoint's own `Authentication`
 * middleware) — this plugin's own error, not that contract-stratum one,
 * mirroring `Api.InvalidCredentials`'s own shape for `signIn`.
 */
export class WrongPassword extends Schema.TaggedError<WrongPassword>()(
  "WrongPassword",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * BEH-EA-113: `signUp`/`signIn`'s success shape reuses `@awthaq/api`'s
 * `SessionContract.SessionDto` rather than inventing a second, competing
 * "who is signed in" wire shape — `SessionView`/`SubjectDto` proper
 * (BEH-EA-026) is its own, still-deferred piece of work; `SessionDto` is
 * the one that already exists and is already what the `session` group
 * itself returns for the identical "here is your session" moment.
 * `confirmReset` declares no `success` schema (defaults to `204`, the same
 * convention `@awthaq/api`'s `session` group's `signOut`/`revokeOthers`
 * already use) — it does not sign the caller in on whatever device
 * submitted the reset, only revokes every *other* session (BEH-EA-117).
 */
export const PasswordGroup = HttpApiGroup.make("password")
  .add(
    HttpApiEndpoint.post("signUp", "/password/sign-up", {
      payload: SignUpPayload,
      // TMS-005: `200` with the session (`signUpEnumeration: "reveal"`, the
      // default) or an empty `202` (`"conceal"`: same answer for a fresh and
      // an existing address, no session until the mailbox is proven).
      success: [SessionContract.SessionDto, HttpApiSchema.Empty(202)],
      // Each error's own `httpApiStatus` is only honored per member when
      // `error` is a plain array — `HttpApiEndpoint.getErrorSchemas` reads
      // `endpoint.error` as a `Set` of individually-annotated schemas
      // (`HttpApiEndpoint.ts`'s own `getErrorResponse`); a `Schema.Union`
      // here would be stored as a single member whose own AST carries no
      // `httpApiStatus` annotation, silently falling back to 500.
      // Shipping-gap map (.scratch/shipping-gaps), ticket 12: rate-limited.
      // Wayfinder ticket 03 (AOMS-006/BCR-004): `HookPoint.HookAborted`
      // from a `Hooks.BeforeSignUp` veto tap (e.g. an email-domain
      // allow-list).
      // MNA-001: `Api.InvalidTokenDelivery` (400) for an unrecognised
      // `X-Awthaq-Token-Delivery` value.
      error: [
        WeakPassword,
        EmailAlreadyExists,
        Api.RateLimited,
        HookPoint.HookAborted,
        Api.InvalidTokenDelivery,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("signIn", "/password/sign-in", {
      payload: SignInPayload,
      success: SessionContract.SessionDto,
      // Ticket 12: rate-limited. Upstream-hardening ticket 04: hard-blocks
      // an unverified account. Wayfinder ticket 03 (BCR-004/THS-002):
      // `Hooks.TwoFactorRequired` when a `Hooks.BeforeSessionIssue` tap
      // (a future `TwoFactor` plugin) diverts. NAM-002: `HookPoint.HookAborted`
      // from a `Hooks.BeforeSignIn` veto tap.
      // SCP-001: `Users.UserSuspended` when `Users.assertCanSignIn` refuses.
      // MNA-001: `Api.InvalidTokenDelivery` for an unrecognised `X-Awthaq-Token-Delivery` value.
      error: [
        Api.InvalidCredentials,
        EmailNotVerified,
        Users.UserSuspended,
        Api.RateLimited,
        HookPoint.HookAborted,
        Hooks.TwoFactorRequired,
        Api.InvalidTokenDelivery,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("requestReset", "/password/request-reset", {
      payload: RequestResetPayload,
      success: HttpApiSchema.Empty(202),
      // Ticket 12: rate-limited.
      error: Api.RateLimited,
    }),
  )
  .add(
    HttpApiEndpoint.post("confirmReset", "/password/confirm-reset", {
      payload: ConfirmResetPayload,
      // BEH-EA-120: the new password is checked against the same policy
      // (`minLength`/`breachCheck`) any other newly-set password is. A
      // plain array, not `Schema.Union` — see `signUp`'s own comment above.
      // Ticket 12: rate-limited.
      // ARF-005: `SecondFactorRequired` (401) / `HookAborted` when a `BeforeCredentialReset` tap refuses.
      error: [TokenConsumed, WeakPassword, Api.RateLimited, SecondFactorRequired, HookPoint.HookAborted],
    }),
  )
  .add(
    // Shipping-gap map (.scratch/shipping-gaps), ticket 08: a top-level
    // route, not nested under `/password/*` — account-lifecycle actions
    // apply regardless of which auth method a user signed up with, even
    // though this particular capability happens to be implemented here
    // (it consumes the token `signUp` mails). No `success` schema —
    // defaults to `204`, matching `signOut`'s own convention.
    HttpApiEndpoint.post("verifyEmail", "/verify-email", {
      payload: VerifyEmailPayload,
      error: [TokenConsumed, Api.RateLimited],
    }),
  )
  .add(
    // Upstream-hardening map, ticket 04: top-level, matching `verifyEmail`'s
    // own convention above — same reasoning, this is account-lifecycle, not
    // password-specific, even though this plugin happens to own the only
    // verification mechanism today. Copies `requestReset`'s enumeration-safe
    // shape exactly: identical `202` whether the email doesn't exist, the
    // account is already verified, or a mail genuinely goes out.
    HttpApiEndpoint.post("resendVerification", "/resend-verification", {
      payload: ResendVerificationPayload,
      success: HttpApiSchema.Empty(202),
      error: Api.RateLimited,
    }),
  )
  // CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: every endpoint here
  // is an unsafe method, and most (signUp/signIn/requestReset/
  // confirmReset/verifyEmail/resendVerification) are otherwise-public —
  // exactly the login-CSRF surface `CsrfProtectionLive` exists to close,
  // and `CsrfProtection` doesn't require an authenticated principal, so it
  // applies at the group level. The authenticated endpoints are in
  // `PasswordAccountGroup`.
  .middleware(Api.CsrfProtection);

/**
 * EHA-007: the endpoints that need a live session, in a dotted sub-id group of
 * their own with group-level `Authentication` (the `passkey`/`passkey.credentials`
 * and `jwt` convention), not per-endpoint middleware inside the public group.
 * Wire paths are unchanged. `CsrfProtection` is declared last so it runs first.
 */
export const PasswordAccountGroup = HttpApiGroup.make("password.account")
  .add(
    // Shipping-gap map (.scratch/shipping-gaps), ticket 11: authenticated
    // change-password, distinct from the unauthenticated forgot-password
    // pair (`requestReset`/`confirmReset`) in the `password` group. Top-level
    // route, matching `verifyEmail`'s own convention.
    HttpApiEndpoint.post("changePassword", "/change-password", {
      payload: ChangePasswordPayload,
      // PIL-002/RRS-001/SMS-001: BEH-EA-053 requires every privilege-change
      // to mint a fresh session and revoke every other one — the caller's
      // own session is rotated (superseded), not merely kept, so the
      // response carries the new session the same way signUp/signIn's do.
      success: SessionContract.SessionDto,
      // Ticket 14: rate-limited.
      error: [WrongPassword, WeakPassword, Api.RateLimited, Api.InvalidTokenDelivery],
    }),
  )
  .add(
    // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
    // (AAPS-001): this obligation's own real discharge path — re-verifies
    // the submitted password (reusing `signIn`'s own hash-comparison
    // path) and, on success, calls `Sessions.reauthenticate`. No `success`
    // schema — defaults to `204`, since this never mints a new session.
    HttpApiEndpoint.post("reauthenticate", "/password/reauthenticate", {
      payload: ReauthenticatePayload,
      error: [WrongPassword, Api.RateLimited],
    }),
  )
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const PasswordApi = HttpApi.make("auth").add(PasswordGroup).add(PasswordAccountGroup);
