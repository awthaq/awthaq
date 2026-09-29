// @awthaq/magic-link — passwordless sign-in over the Verification substrate (M7)
//
// Two plugins in one package, sharing one channel-credential module (`Channel`):
//
//   MagicLink.MagicLink   a single-use emailed link; POST-only consumption, token in the URL fragment
//   EmailOtp.EmailOtp     a six-digit emailed code, hashed, attempt-budgeted, resend-windowed
//
// Both consult the sign-in veto and the MFA divert (`BeforeSessionIssue`), so a user with a confirmed
// second factor (`@awthaq/two-factor`) is diverted exactly as a password or passkey sign-in is.
// See `README.md` for the interstitial pattern a link needs, and spec/behaviors/29-magic-link.md and
// spec/behaviors/30-email-otp.md for the behaviors.

export * as Channel from "./Channel.ts";
export * as EmailOtp from "./EmailOtp.ts";
export * as EmailOtpApi from "./EmailOtpApi.ts";
export * as MagicLink from "./MagicLink.ts";
export * as MagicLinkApi from "./MagicLinkApi.ts";
