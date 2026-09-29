---
ID: "THS-005"
Title: "No replay primitive for time-windowed codes: Verification is identifier-keyed single-use only"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:200"
Auditor: "totp-hotp-mfa-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# THS-005 — No replay primitive for time-windowed codes: Verification is identifier-keyed single-use only

`MEDIUM` · `correctness` · `core` · reported by **TOTP/HOTP MFA Specialist** (`totp-hotp-mfa-specialist`)

Status: **resolved**

## Summary

Verification.consume is the repo's only replay machinery, and it models a single-use token keyed by identifier: consumed is forever. That is the right shape for hashed recovery codes (each code burns exactly once) but the wrong shape for TOTP, where a code must stay valid across the +/-1 step window yet be rejected on second presentation within that window — which requires tracking the last-accepted time step per secret (reject timestep <= lastUsedStep). The spec fixes the window parameters (spec/models/06-two-factor-totp.md:26-27) but the Q58 open-questions list carries no replay/used-step decision, so the persona red flag 'does not track used codes' is one careless implementation away.

## Evidence

Source: `packages/core/src/Verification.ts:200`

```
                    new TokenConsumed({
                      message: `awthaq: token replay or unknown token: ${identifier}`,
                      identifier,
```

## Recommended fix

Design the used-step check into the secret row from day one: an atomic compare-and-set on lastUsedStep inside the verification transaction (SQL: UPDATE ... WHERE lastUsedStep < ?, mirroring tryConsume's single-statement atomicity), so a valid code is accepted for at most one step index even with concurrent verify calls and clock drift resync.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 24/100), domain: TOTP/HOTP MFA
- Full dossier: [`totp-hotp-mfa-specialist`](../../.reports/totp-hotp-mfa-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-002` — Verification token digest compared with !== instead of constant-time equality](low/ACS-002-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-005` — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes](medium/BCR-005-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSG-003` — No retention sweep: expired sessions and consumed/expired verification rows persist forever](high/CSG-003-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-008` — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly](medium/ECF-008-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-56 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `verification-otp-substrate`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:186`. Fix: Add a lastUsedStep compare-and-set to the TOTP secret row in the two-factor design and implementation. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** lastUsedStep compare-and-set on the two_factor_secret row (advanceLastUsedStep; confirm seeds it): a replayed or older step is refused; 12 concurrent submissions of one step advance exactly once. Tests: TwoFactorStore.test.ts (memory + SQLite), Totp.test.ts. BEH-EA-262.
