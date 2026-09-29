---
ID: "BCR-006"
Title: "Shared per-account lockout counter for code brute-force is undecided and unowned"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: "spec/models/06-two-factor-totp.md:104"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-006 — Shared per-account lockout counter for code brute-force is undecided and unowned

`MEDIUM` · `security` · `—` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **resolved**

## Summary

research/07 (Q58 evidence and recommendation 3) is explicit that failed attempts should share one per-account counter across all second factors with a typed 429 lockout, and that this is what makes a 10-code set safe against online guessing. The spec defers the decision, no such counter exists, and password's per-endpoint limits (5/15min on signIn/requestReset, Password.ts:157-159) are the wrong shape — they throttle an endpoint, not an account across factors. Verification's uniform auth.token.replay event on every failed consume is a ready-made failure signal for such a counter.

## Evidence

Source: `spec/models/06-two-factor-totp.md:104`

```
(10-minute default is cited, not adopted), whether failed
attempts across TOTP/OTP/recovery-code share one per-account counter, and
```

## Recommended fix

Decide and document before implementation: a per-account counter keyed like '2fa-attempts-<userId>' through the RateLimiter port, incremented on auth.token.replay for backup-code identifiers, reset on success, mapped to a typed AccountLocked error at 5 failures.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-010` — No BDD or behavior-spec coverage for backup codes despite the suite's own hook for it](low/BCR-010-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`SOS-006` — SIM-swap / NIST restricted-authenticator policy exists only in research; zero ADRs, decision explicitly undecided in spec](medium/SOS-006-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- [`THS-004` — TOTP secret encryption-at-rest left undecided despite a proven Encryption port](medium/THS-004-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, medium)_`
- [`THS-007` — Pre-session challenge state (challenge cookie) has no implementation and an undecided TTL/binding design](low/THS-007-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mfa-two-factor-hardening`. Evidence at HEAD ec065a7: `spec/models/06-two-factor-totp.md:104`. Fix: Add to ADR-EA-020 a shared per-account second-factor failure budget through the RateLimiter port (research/07 Q58 recommendation 3), layered on top of ticket 05's per-challenge limit. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ADR-EA-020 Decision: shared per-account failure budget through the RateLimiter port (5 in 15 min, any method/challenge, success does not reset), pre-evaluation check via the new read-only RateLimiter.check plus consume on failure; typed SecondFactorLocked 429 and an audited event. Implemented in SecondFactor.ts and tested (TwoFactor.test.ts lockout). BEH-EA-266.
