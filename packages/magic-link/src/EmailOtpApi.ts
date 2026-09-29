// @awthaq/magic-link — EmailOtpApi
//
// SOS-001 (BEH-EA-268 to BEH-EA-271): the email-OTP contract — one public group, `emailOtp`. `request`
// mails a short numeric code and answers `202` identically for every address (an unknown address, an
// address inside its resend window, a mail that was never sent look the same); `verify` trades the
// code for a session. Every failure of the code itself — wrong, expired, burned by too many guesses,
// never issued — is the one `InvalidEmailOtp` (401): the response cannot be used to tell whether an
// account exists or how many guesses a code has left.

import { Api, EmailContract, SessionContract } from "@awthaq/api";
import { HookPoint, Hooks, Users } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** The code is wrong, expired, spent, burned by its attempt budget or was never issued — one error for all of them. */
export class InvalidEmailOtp extends Schema.TaggedError<InvalidEmailOtp>()(
  "InvalidEmailOtp",
  {},
  { httpApiStatus: 401 },
) {}

export const RequestPayload = Schema.Struct({ email: EmailContract.Email });
export type RequestPayload = typeof RequestPayload.Type;

export const VerifyPayload = Schema.Struct({
  email: EmailContract.Email,
  code: Schema.Redacted(Schema.String.check(Schema.isMaxLength(32))),
});
export type VerifyPayload = typeof VerifyPayload.Type;

export const EmailOtpGroup = HttpApiGroup.make("emailOtp")
  .add(
    HttpApiEndpoint.post("request", "/email-otp/request", {
      payload: RequestPayload,
      success: HttpApiSchema.Empty(202),
      error: Api.RateLimited,
    }),
  )
  .add(
    HttpApiEndpoint.post("verify", "/email-otp/verify", {
      payload: VerifyPayload,
      success: SessionContract.SessionDto,
      error: [
        InvalidEmailOtp,
        Api.RateLimited,
        HookPoint.HookAborted,
        Hooks.TwoFactorRequired,
        Users.UserSuspended,
        Api.InvalidTokenDelivery,
      ],
    }),
  )
  .middleware(Api.CsrfProtection);

export const EmailOtpApi = HttpApi.make("auth").add(EmailOtpGroup);
