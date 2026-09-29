// @awthaq/two-factor — TwoFactorApi
//
// THS-001 step 10 (BEH-EA-233 to BEH-EA-239): this plugin's own HTTP contract — two groups, both
// named `two_factor` or a dotted sub-id of it (BEH-EA-004):
//
// - `two_factor` — public and anonymous by construction: `verify` / `verify-recovery` are how a
//   caller who has passed a first factor and holds a `challengeId` (the `TwoFactorRequired` a
//   `BeforeSessionIssue` divert answered) completes the sign-in. The challenge *is* the
//   credential here, so there is no `Api.Authentication`; `CsrfProtection` still guards the two
//   unsafe methods, like `@awthaq/password`'s public `signIn`.
// - `two_factor.account` — an already-authenticated user managing their own second factor:
//   enrol, confirm, disable, regenerate recovery codes, read status. Group-level
//   `.middleware(Api.Authentication)` (EHA-007), `CsrfProtection` declared last so it runs first.
//
// Errors are plain arrays of `Schema.TaggedError`s (each member's own `httpApiStatus` is only
// honoured per member when `error` is an array — see `PasswordApi.ts`'s signUp note), so a client
// branches on `_tag`. The two secrets a response can carry (the enrolment secret, the fresh
// recovery codes) are shown exactly once, in the body of the response that creates them.

import { Api, SessionContract } from "@awthaq/api";
import { Users } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/**
 * BEH-EA-235: the presented code (TOTP or recovery), the challenge, or the challenge's attempt
 * budget did not check out — deliberately one error for a wrong code, an unknown, expired,
 * replayed or foreign challenge, and a factor that was disabled meanwhile, so the response says
 * nothing about which. When the challenge still has attempts left, `challengeId` is the *fresh*
 * challenge to retry with (a consumed challenge is never re-used); absent, the client restarts
 * the sign-in.
 */
export class InvalidTwoFactorCode extends Schema.TaggedError<InvalidTwoFactorCode>()(
  "InvalidTwoFactorCode",
  { challengeId: Schema.optional(Schema.String) },
  { httpApiStatus: 401 },
) {}

/** `enable` on an account whose second factor is already confirmed — disable it first. */
export class TwoFactorAlreadyEnabled extends Schema.TaggedError<TwoFactorAlreadyEnabled>()(
  "TwoFactorAlreadyEnabled",
  {},
  { httpApiStatus: 409 },
) {}

/** `confirm`/`disable`/`regenerate` on an account with no (confirmed) second factor, or `confirm` with no enrolment in progress. */
export class TwoFactorNotEnabled extends Schema.TaggedError<TwoFactorNotEnabled>()(
  "TwoFactorNotEnabled",
  {},
  { httpApiStatus: 409 },
) {}

/**
 * BEH-EA-236: enrolling, disabling or regenerating needs a session that proved a credential
 * recently — otherwise a hijacked cookie could quietly swap the victim's second factor for the
 * attacker's. `403`, like `PasskeyReauthRequired`: the session is live, its freshness forbids
 * this action; step up (`/password/reauthenticate`, `/passkey/reauthenticate/*`) and retry.
 */
export class TwoFactorReauthRequired extends Schema.TaggedError<TwoFactorReauthRequired>()(
  "TwoFactorReauthRequired",
  { maxAgeSeconds: Schema.Number },
  { httpApiStatus: 403 },
) {}

/**
 * BCR-006 (ADR-EA-020): the account's shared second-factor failure budget is spent — five
 * failures across TOTP, recovery codes and every challenge in fifteen minutes. `429`; even a
 * correct code is refused until `retryAfterMillis` has passed (success does not reset the window).
 */
export class SecondFactorLocked extends Schema.TaggedError<SecondFactorLocked>()(
  "SecondFactorLocked",
  { retryAfterMillis: Schema.Number },
  { httpApiStatus: 429 },
) {}

const Code = Schema.Redacted(Schema.String.check(Schema.isMaxLength(64)));
const ChallengeId = Schema.Redacted(Schema.String.check(Schema.isMaxLength(512)));

export const VerifyPayload = Schema.Struct({ challengeId: ChallengeId, code: Code });
export type VerifyPayload = typeof VerifyPayload.Type;

export const VerifyRecoveryPayload = Schema.Struct({
  challengeId: ChallengeId,
  recoveryCode: Code,
});
export type VerifyRecoveryPayload = typeof VerifyRecoveryPayload.Type;

export const ConfirmPayload = Schema.Struct({ code: Code });
export type ConfirmPayload = typeof ConfirmPayload.Type;

/** A TOTP or recovery code — disabling and regenerating accept either, so a user who lost their device can still act. */
export const CodePayload = Schema.Struct({ code: Code });
export type CodePayload = typeof CodePayload.Type;

/** BEH-EA-236: what `enable` returns, once — the secret for manual entry and the `otpauth://` link a QR code carries. */
export class EnrollmentDto extends Schema.Class<EnrollmentDto>("TwoFactorEnrollmentDto")({
  secret: Schema.String,
  otpauthUri: Schema.String,
}) {}

/** BEH-EA-237: the fresh recovery codes, shown once. Only their hashes are stored. */
export class RecoveryCodesDto extends Schema.Class<RecoveryCodesDto>("TwoFactorRecoveryCodesDto")({
  recoveryCodes: Schema.Array(Schema.String),
}) {}

export class StatusDto extends Schema.Class<StatusDto>("TwoFactorStatusDto")({
  enabled: Schema.Boolean,
  /** A low count is the cue to regenerate. */
  remainingRecoveryCodes: Schema.Number,
}) {}

export const TwoFactorGroup = HttpApiGroup.make("two_factor")
  .add(
    HttpApiEndpoint.post("verify", "/two-factor/verify", {
      payload: VerifyPayload,
      success: SessionContract.SessionDto,
      error: [
        InvalidTwoFactorCode,
        SecondFactorLocked,
        Api.RateLimited,
        // The account was suspended between the first factor and this one (SCP-001).
        Users.UserSuspended,
        Api.InvalidTokenDelivery,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("verifyRecovery", "/two-factor/verify-recovery", {
      payload: VerifyRecoveryPayload,
      success: SessionContract.SessionDto,
      error: [
        InvalidTwoFactorCode,
        SecondFactorLocked,
        Api.RateLimited,
        Users.UserSuspended,
        Api.InvalidTokenDelivery,
      ],
    }),
  )
  .middleware(Api.CsrfProtection);

export const TwoFactorAccountGroup = HttpApiGroup.make("two_factor.account")
  .add(
    HttpApiEndpoint.post("enable", "/two-factor/enable", {
      success: EnrollmentDto,
      error: [TwoFactorAlreadyEnabled, TwoFactorReauthRequired, Api.RateLimited],
    }),
  )
  .add(
    HttpApiEndpoint.post("confirm", "/two-factor/confirm", {
      payload: ConfirmPayload,
      success: RecoveryCodesDto,
      error: [
        InvalidTwoFactorCode,
        TwoFactorNotEnabled,
        TwoFactorAlreadyEnabled,
        SecondFactorLocked,
        Api.RateLimited,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("disable", "/two-factor/disable", {
      payload: CodePayload,
      success: HttpApiSchema.Empty(204),
      error: [
        InvalidTwoFactorCode,
        TwoFactorNotEnabled,
        TwoFactorReauthRequired,
        SecondFactorLocked,
        Api.RateLimited,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("regenerateRecoveryCodes", "/two-factor/recovery-codes/regenerate", {
      payload: CodePayload,
      success: RecoveryCodesDto,
      error: [
        InvalidTwoFactorCode,
        TwoFactorNotEnabled,
        TwoFactorReauthRequired,
        SecondFactorLocked,
        Api.RateLimited,
      ],
    }),
  )
  .add(HttpApiEndpoint.get("status", "/two-factor/status", { success: StatusDto }))
  // See `@awthaq/api`'s `Session.ts`: `CsrfProtection` declared last so it runs first.
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const TwoFactorApi = HttpApi.make("auth").add(TwoFactorGroup).add(TwoFactorAccountGroup);
