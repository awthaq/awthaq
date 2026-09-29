# P15 — MFA, passwordless & authentication assurance

Phase 3 · 19 open issues to fix (6 high, 10 medium, 3 low) · 13 closed by validation · ~131h summed per-issue estimate (upper bound) · 1 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `mfa-two-factor` — TwoFactor plugin (TOTP + recovery codes) and second-factor-aware recovery

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~45h · depends on workstreams: `mail-delivery-reliability`, `password-rate-limit-hardening`, `password-recovery-correctness`, `session-issuance-context`, `verification-token-delivery`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AOMS-003](../slices/07-password-mfa.md) | high | security | PARTIAL | S | THS-001, APS-007 | Close the residual after THS-001 lands: MFA events in the audit trail, `amr` recorded on sessions minted after a second factor, and the Auth0 migration doc stating enrolments are not importable. |
| [ARF-005](../slices/07-password-mfa.md) | high | security | CONFIRMED | L | THS-001, ARF-002, BAM-007, ERS-002 | Add `Hooks.BeforeCredentialReset` (veto), consult it inside confirmReset's transaction, tap it from `TwoFactor.credentialResetGate`, and notify owners on impersonation start. |
| [THS-001](../slices/07-password-mfa.md) | high | architecture | CONFIRMED | XL | RBS-006 | Build the TwoFactor plugin (ticket 05 §1) in 12 implementable steps: pure TOTP module, encrypted secret + hashed recovery-code stores, branded single-use challenge over Verification, enable/confirm/verify/verifyRecovery/disable/regenerate, contract, opt-in hook-tap layers enforced by the type system, events, erasure, spec + BDD. |

Closed by validation in this workstream: CSD-005 (DUPLICATE → THS-001), ACS-010 (DUPLICATE → THS-001), BCR-001 (DUPLICATE → THS-001), ECF-009 (DUPLICATE → THS-001), TTE-008 (DUPLICATE → THS-001)

## `passwordless-magic-link-email-otp` — MagicLink + EmailOtp plugins on the Verification substrate

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~24h · depends on workstreams: `mail-delivery-reliability`, `mfa-two-factor`, `password-rate-limit-hardening`, `verification-token-delivery`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BAM-007](../slices/07-password-mfa.md) | high | api | CONFIRMED | L | MLO-009, ERS-002, TMS-006 | Ship `@awthaq/magic-link`'s MagicLink plugin on the Verification substrate, POST-only consumption, fragment-carried token, consulting BeforeSessionIssue (ARF-005 Fix A). |
| [SOS-001](../slices/07-password-mfa.md) | high | architecture | CONFIRMED | L | BAM-007, ERS-002, TMS-006 | Ship the EmailOtp substrate (6-digit, hashed, attempt-budgeted, resend-windowed) over Verification; record SMS as deferred. |

Closed by validation in this workstream: MLO-005 (DUPLICATE → BAM-007), FAMS-007 (DUPLICATE → BAM-007), IC-009 (DUPLICATE → BAM-007), SAM-009 (DUPLICATE → SOS-001)

## `two-factor-recovery-codes` — Recovery-code set primitives (in the two-factor plugin build)

Slices: [05-sql](../slices/05-sql.md) · ~4h · depends on workstreams: `two-factor plugin build (ticket 05: AOMS-003/THS-001/ARF-005)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BCR-002](../slices/05-sql.md) | high | architecture | PARTIAL | M | AOMS-003 | Don't add prefix/count primitives to VerificationRepository. Implement bulk-replace and count on the `two_factor_recovery_code` repository when the two-factor plugin is built (ticket 05). Verification history purging comes from CSG-003's `deleteExpiredBefore`. |

Closed by validation in this workstream: BCR-009 (WONTFIX-CANDIDATE)

## `mfa-two-factor-hardening` — Two-factor state ADRs (secret encryption, challenge, lockout, SMS posture) + coverage

Slices: [12-spec](../slices/12-spec.md) · ~8h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BCR-006](../slices/12-spec.md) | medium | security | CONFIRMED | S | THS-004 | Add to ADR-EA-020 a shared per-account second-factor failure budget through the RateLimiter port (research/07 Q58 recommendation 3), layered on top of ticket 05's per-challenge limit. |
| [SOS-006](../slices/12-spec.md) | medium | compliance | CONFIRMED | S | — | Codify decision ticket 05 §3 as ADR-EA-021: SMS OTP is a separate, explicitly restricted plugin over the EmailOtp channel substrate, never an account's sole factor, emitting a `factor.sms.used` audit event, with a SIM-swap risk-indicator hook as a documented extension point. |
| [THS-004](../slices/12-spec.md) | medium | security | CONFIRMED | S | — | Record in a new ADR (with THS-007/BCR-006) that TOTP secrets are stored only as Encryption-port envelopes with AAD bound to the user, reusing packages/ports/src/Encryption.ts instead of the SecretBox port ticket 05 proposed (same intent, already shipped). |
| [BCR-010](../slices/12-spec.md) | low | testing | CONFIRMED | M | THS-004, THS-007, BCR-006, THS-001 (cross-slice: two-factor build) | Write the two-factor behaviors + feature (including recovery codes) as the first artifact of the TwoFactor build decided in ticket 05, mirroring BEH-EA-057/058's reset-token scenarios. |
| [THS-007](../slices/12-spec.md) | low | security | CONFIRMED | S | THS-004 | Write ticket 05's challenge design into ADR-EA-020: challengeId minted by Verification.issue (identifier bound to userId, 10-minute TTL, single-consume, replay event), one live challenge per account, revoked when 2FA is disabled. |

## `verification-otp-substrate` — Verification as an OTP substrate (ticket 05 prerequisites)

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~10h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BCR-005](../slices/01-core-sessions-users.md) | medium | security | PARTIAL | M | SOS-004 | Let Verification.issue mint caller-formatted values via a typed generator option (never a raw caller string), keeping hashing and single-use semantics. |
| [MLO-002](../slices/01-core-sessions-users.md) | medium | architecture | CONFIRMED | S | — | Make reserve's status a decision: document it as the resend-window primitive for MagicLink/EmailOtp (ticket 05) and use it there; until then note it in the Shape doc. |
| [SOS-004](../slices/01-core-sessions-users.md) | medium | security | CONFIRMED | M | — | Add an optional per-token attempt budget: each failed consume against a live row increments attempts; the row is burned at maxAttempts. |
| [THS-005](../slices/01-core-sessions-users.md) | medium | correctness | CONFIRMED | S | THS-001 | Add a lastUsedStep compare-and-set to the TOTP secret row in the two-factor design and implementation. |

Closed by validation in this workstream: SOS-007 (WONTFIX-CANDIDATE), BCR-008 (WONTFIX-CANDIDATE)

## `session-assurance-channel` — Session assurance / trust channel into the subject

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~16h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AAPS-006](../slices/08-authz-org-roles-qadi.md) | medium | architecture | PARTIAL | L | — | Declare the ADR-EA-012 SessionViewExtension slot and carry session-trust facts (authenticatedAt, amr, derived aal) onto the principal and into AuthSubject.attributes through one mapping point. |
| [SOS-005](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED | M | AAPS-006 | Add the assurance vocabulary on top of AAPS-006's amr channel so SMS can be policy-ranked below TOTP/passkey before any SMS plugin ships. |

Closed by validation in this workstream: AAPS-009 (WONTFIX-CANDIDATE)

## `session-assurance` — Session authentication assurance (amr) for qadi (decision needed)

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~12h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [HSK-005](../slices/10-passkey-admin.md) | medium | api | CONFIRMED ⚖️ decision | L | — | Record per-session authentication assurance (amr + UV + credential facts) at issuance and expose it to qadi policies. |

## `session-authentication-methods` — amr/auth_time on sessions and JWTs

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~12h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AOMS-012](../slices/04-oauth-provider-jwt.md) | low | api | CONFIRMED | L | — | Record RFC 8176-style authentication methods on the session, carry them on the UserPrincipal, and emit `amr` + `auth_time` in principal JWTs. |

