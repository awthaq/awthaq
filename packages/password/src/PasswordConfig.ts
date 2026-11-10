// @awthaq/password — PasswordConfig
//
// BEH-EA-119/120: the plugin's policy knobs, a `Context.Reference` with a default (BEH-EA-017). Its own
// file so `Password.ts` and `PasswordCredential.ts` both read it without importing each other;
// `Password.ts` re-exports it, so `Password.config(...)` and `Password.PasswordConfig` are unchanged.

import { RateLimits, Tenant } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

export interface PasswordConfigShape {
  readonly minLength: number;
  /**
   * BEH-EA-119/PHS-006: screening a new password against the HIBP corpus is on
   * by default (NIST SP 800-63B section 3.1.1.2 makes checking against
   * compromised-password lists a SHALL; the k-anonymity range API discloses
   * only a 5-character SHA-1 prefix). `true` fails open when the provider is
   * unavailable, `{ onUnavailable: "reject" }` fails closed, `false` disables
   * it (air-gapped deployments).
   */
  readonly breachCheck: boolean | { readonly onUnavailable: "allow" | "reject" };
  /**
   * PHS-004: how long the breach lookup (request plus body) may take before
   * it counts as "unavailable" and follows `breachCheck`'s `onUnavailable`,
   * so a black-holed egress never hangs sign-up.
   */
  readonly breachCheckTimeout: Duration.Duration;
  readonly resetTtl: Duration.Duration;
  readonly rehashOnLogin: boolean;
  /**
   * TSS-006: the minimum time `signIn`'s credential check (lookup plus
   * verify) takes, so an account whose stored hash is cheaper than the
   * configured cost (a legacy bcrypt row awaiting rehash) cannot be told
   * apart from an unknown email by latency. `"calibrated"` (the default)
   * times the boot-time dummy verify and pads to 1.25 times that; a
   * `Duration` fixes the floor; `"off"` disables it. A hash costlier than
   * the floor still takes longer, and stays distinguishable until rehashed.
   */
  readonly signInTimingFloor: "calibrated" | "off" | Duration.Duration;
  /**
   * TMS-006: maps an address to the per-email rate-limit bucket it is
   * counted in (sign-up, sign-in, reset, resend). The default
   * (`RateLimits.Key.emailKey`) trims, lower-cases and strips a `+tag`, so
   * subaddressed aliases share one budget; delivery still uses the literal
   * address. Override for providers with other conventions. Read once at boot.
   */
  readonly rateLimitEmailKey: (email: string) => string;
  /**
   * MLO-009: builds the link mailed for each token, from the token string. When
   * set, the mail's `data.url` carries it (alongside `token` and `expiresAt`,
   * which are always present). Point it at a page that consumes the token from
   * the URL fragment or a form POST — never a query string a GET handler
   * acts on, which mail scanners prefetch.
   */
  readonly links: {
    readonly verifyEmail?: (token: string) => string;
    readonly resetPassword?: (token: string) => string;
    /** BAM-009: the confirmation link mailed to the *new* address of a change-email flow (a user's own request or an administrator's). */
    readonly changeEmail?: (token: string) => string;
  };
  /**
   * FAMS-003: whether `signIn` refuses an account whose email is unverified
   * (after the credentials are confirmed, so it is never a password oracle).
   * Default `true`. A deployment that imported users from a source that
   * never verified them (or verified differently) may set `false` and
   * restrict unverified users downstream instead, or call
   * `Users.verifyEmail` for the imported users the source had verified.
   */
  readonly requireVerifiedEmail: boolean;
  /**
   * TMS-005: how `signUp` answers an address that already has an account.
   * `"reveal"` (default) fails with 409 `EmailAlreadyExists` and issues the
   * session at once. `"conceal"` answers 202 for a fresh and an existing
   * address alike, issues no session until the mailbox is proven (the
   * verification mail), and mails the existing owner an `account-exists`
   * notice. See ADR-EA-018.
   */
  readonly signUpEnumeration: "reveal" | "conceal";
  /**
   * CSD-004: the secret `auth.user.signInFailed.identifierDigest` is keyed
   * with. `None` (default) generates a random key per process — enough for a
   * single-process detector, but digests do not survive a restart or match
   * across instances; set a stable secret (>= 32 bytes) to correlate attempts
   * across a fleet and over time.
   */
  readonly identifierDigestKey: Option.Option<Redacted.Redacted<string>>;
  /**
   * BEH-EA-320: how recent the session's `authenticatedAt` must be to start an email change
   * (`POST /change-email`); an older session gets `PasswordReauthRequired` and must step up
   * through `POST /password/reauthenticate` (or a passkey) first. Without it a hijacked cookie
   * could point the account's address at an attacker's mailbox and then reset the password.
   * `Duration.infinity` turns the gate off. Default 5 minutes, like passkey enrolment.
   */
  readonly reauthMaxAge: Duration.Duration;
}

const defaultPasswordConfig: PasswordConfigShape = {
  minLength: 12,
  breachCheck: true,
  breachCheckTimeout: Duration.seconds(3),
  resetTtl: Duration.hours(1),
  rehashOnLogin: true,
  signInTimingFloor: "calibrated",
  rateLimitEmailKey: RateLimits.Key.emailKey,
  links: {},
  requireVerifiedEmail: true,
  signUpEnumeration: "reveal",
  identifierDigestKey: Option.none(),
  reauthMaxAge: Duration.minutes(5),
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
export const PasswordConfig: Context.Reference<PasswordConfigShape> = Context.Reference(
  "awthaq/password/Config",
  { defaultValue: () => defaultPasswordConfig },
);

/**
 * BEH-EA-355: tenant-scoped. Boot fields are derived once at build from the build value (the digest key and the
 * rate-limit email-key function); `signInTimingFloor` is read per operation, so it is not boot.
 */
export const PasswordConfigScoped = Tenant.perTenant(PasswordConfig, {
  boot: ["identifierDigestKey", "rateLimitEmailKey"],
});

/** BEH-EA-018/120: a partial override, type-checked against `PasswordConfigShape`, never runtime-validated. */
export const config = (partial: Partial<PasswordConfigShape>) =>
  PasswordConfigScoped.layer({ ...defaultPasswordConfig, ...partial });
