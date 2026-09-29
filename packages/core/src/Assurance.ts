// @awthaq/core — Assurance
//
// SOS-005/AAPS-006 (BEH-EA-231): the vocabulary a policy uses to ask "how strongly was this
// session authenticated" without re-deriving it from `amr` at every check. A session records the
// RFC 8176 method references that created it (`Sessions.AuthMethod`, THS-003); this module maps
// that list onto NIST SP 800-63B authenticator assurance levels, in one pure function, so
// `@awthaq/qadi` can expose `aal` as a subject attribute and a host can require
// `hasAttribute("aal", oneOf("aal2", "aal3"))` instead of enumerating method combinations.
//
// The mapping is deliberately conservative — it never guesses a stronger level than the recorded
// methods prove:
//
// - **Factors are counted by class.** Knowledge (`pwd`) and possession (`hwk`, `swk`, `otp`,
//   `sms`, `email`) are different classes; two possession methods are still one factor
//   (an emailed code plus the mailbox link is just the mailbox). A key method with user
//   verification (`user`) is a multi-factor authenticator: possession plus a local factor.
//   `mfa` (recorded by `@awthaq/two-factor`) states multiple factors outright.
// - **`fed` counts for nothing.** A federated sign-in is as strong as the identity provider
//   says, which awthaq cannot see; it is the aal1 floor unless other methods say more.
// - **AAL3** needs a hardware-bound key with user verification (`hwk` + `user`).
// - **`sms` is restricted** (NIST SP 800-63B-4: out-of-band SMS is a restricted authenticator).
//   It may carry a session to aal2 alongside another class, but `restricted` flags it, and
//   `satisfies` ignores it unless the caller explicitly opts in — so a policy that says "aal2"
//   is not silently met by a SIM-swappable factor.

import type { AuthMethod } from "./Sessions.ts";

export type AssuranceLevel = "aal1" | "aal2" | "aal3";

export interface Assurance {
  readonly level: AssuranceLevel;
  /** `true` when the session used a restricted factor (`sms`): the level may rely on it. */
  readonly restricted: boolean;
}

const RESTRICTED: ReadonlySet<AuthMethod> = new Set<AuthMethod>(["sms"]);

const POSSESSION: ReadonlySet<AuthMethod> = new Set<AuthMethod>([
  "hwk",
  "swk",
  "otp",
  "sms",
  "email",
]);

/** NIST SP 800-63B-4: whether `method` is a restricted authenticator. */
export const isRestrictedFactor = (method: AuthMethod): boolean => RESTRICTED.has(method);

const distinctFactorClasses = (amr: ReadonlyArray<AuthMethod>): number => {
  const has = (method: AuthMethod) => amr.includes(method);
  const knowledge = has("pwd") ? 1 : 0;
  const possession = amr.some((method) => POSSESSION.has(method)) ? 1 : 0;
  // A hardware or software key proven with user verification carries a second factor of its own.
  const localFactor = (has("hwk") || has("swk")) && has("user") ? 1 : 0;
  const counted = knowledge + possession + localFactor;
  // `mfa` is a recorded claim of multiple factors (the two-factor plugin adds it only after both passed).
  return has("mfa") ? Math.max(counted, 2) : counted;
};

export const assuranceLevel = (amr: ReadonlyArray<AuthMethod>): AssuranceLevel => {
  if (amr.includes("hwk") && amr.includes("user")) return "aal3";
  return distinctFactorClasses(amr) >= 2 ? "aal2" : "aal1";
};

export const assurance = (amr: ReadonlyArray<AuthMethod>): Assurance => ({
  level: assuranceLevel(amr),
  restricted: amr.some(isRestrictedFactor),
});

const rank = (level: AssuranceLevel): number => (level === "aal1" ? 1 : level === "aal2" ? 2 : 3);

/**
 * Whether the recorded methods meet `required`. A restricted factor is left out of the count
 * unless `allowRestricted` is set, so `["pwd", "sms"]` does not satisfy `aal2` by default.
 */
export const satisfies = (
  amr: ReadonlyArray<AuthMethod>,
  required: AssuranceLevel,
  options?: { readonly allowRestricted?: boolean },
): boolean => {
  const considered =
    options?.allowRestricted === true ? amr : amr.filter((method) => !isRestrictedFactor(method));
  return rank(assuranceLevel(considered)) >= rank(required);
};
