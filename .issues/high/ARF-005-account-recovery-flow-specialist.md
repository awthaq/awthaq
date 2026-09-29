---
ID: "ARF-005"
Title: "The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor"
Level: high
Category: "security"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:8"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-005 — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor

`HIGH` · `security` · `two-factor` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **resolved**

## Summary

packages/two-factor (whose own header promises 'TOTP-based two-factor authentication with a divert hook and hashed recovery codes') and packages/magic-link are both export-{} placeholders. Consequence: for an account protected by a passkey plus (future) TOTP, the sole way back in is the password plugin's single emailed link — mailbox possession alone yields a full credential reset and revokes every session, which is exactly the 'recovery downgrades trust below the factors it recovers' failure this persona's rubric flags as a red flag. Symmetrically, a passkey-only account (no password credential) has no self-service recovery path whatsoever — losing the authenticator means permanent lockout or support intervention. Admin impersonation exists as a support path with a durable audit trail and fail-closed gate, but no owner notification is wired and it is not a lost-factor recovery flow.

## Evidence

Source: `packages/two-factor/src/index.ts:8`

```
Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Ship the two-factor plugin's hashed recovery codes and require step-up (second factor or recovery code) before credential-changing operations for accounts that hold strong factors; make passkey enrollment itself a recovery anchor (re-add via verified passkey). At minimum, document per-account which recovery paths apply so applications cannot silently offer email-reset to passkey-only users.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/two-factor/src/index.ts:8-10` and `packages/magic-link/src/index.ts` are both `export {}` placeholders, matching the evidence exactly; the password plugin's emailed reset link remains the only credential-recovery path. Shipping hashed recovery codes plus deciding which operations require step-up, and how passkey-only accounts recover, are security/product design decisions, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [MFA/two-factor subsystem build-out](../../.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md) — ship `TwoFactor`'s recovery codes; ship `magic-link` now and add it to `BeforeSessionIssue`'s call sites; add a new `BeforeCredentialReset` veto hook so `Password.reset` requires the second factor when one is enrolled. Passkey-only zero-factor lockout is flagged as an open product-scope question, with owner-notification on admin impersonation as the one concrete mitigation shipped now. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mfa-two-factor`. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Fix: Add `Hooks.BeforeCredentialReset` (veto), consult it inside confirmReset's transaction, tap it from `TwoFactor.credentialResetGate`, and notify owners on impersonation start. (effort L). Full dossier: `.plan/slices/07-password-mfa.md`.

**Resolved (2026-09-29):** Added Hooks.BeforeCredentialReset (veto, {userId, secondFactorCode?: Redacted}); Password.confirmReset consults it inside its transaction (SecondFactorRequired 401, secondFactorCode in the payload); TwoFactor.credentialResetGate taps it; MagicLink/EmailOtp/first-factor sign-ins consult BeforeSessionIssue divert (Fix A); admin ImpersonationOwnerNotice opt-in layer notifies the owner when impersonation starts. Tests: packages/password (reset asks for the factor), packages/two-factor/test/AuthHttp.test.ts, packages/admin/test/ImpersonationOwnerNotice.test.ts. BEH-EA-256, BEH-EA-258.
