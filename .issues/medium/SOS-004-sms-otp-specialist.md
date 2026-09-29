---
ID: "SOS-004"
Title: "Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit"
Level: medium
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:196"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-004 — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit

`MEDIUM` · `security` · `core` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **resolved**

## Summary

consume compares the presented value's hash and, on mismatch, fails with TokenConsumed while returning the state map unchanged (line 205's '], s,' branch), so the live row survives every wrong guess until its TTL expires. For the current 256-bit hex tokens (line 152) guessing is infeasible and the design is correct. But a 6-digit SMS/email OTP occupies a 10^6 space: unlimited in-TTL guesses make brute force trivial, and the plugin-level limiter that should close this is only a sketch — spec/models/06-two-factor-totp.md:93-96 admits the described 3-per-10-seconds verify rule 'is itself unimplemented, described only in the sketch'. The repo's own mapping doc prescribes the fix (research/19-dbc-to-effect-mapping.md:184: 'A RateLimiter.consume call scoped to the verification key ... bounded-guess OTPs get an attempt budget'), and research/07-passwords-2fa.md:130 adds that better-auth shares one failed-attempt counter across TOTP/OTP/backup codes — a question spec/models/06-two-factor-totp.md:104-105 lists as undecided.

## Evidence

Source: `packages/core/src/Verification.ts:196`

```
                row.value.valueHash !== presentedHash
              ) {
                return [
```

## Recommended fix

Make attempt budgeting a first-class property of OTP-shaped verification: either add an optional maxAttempts to Verification.issue (row discarded after N failed consumes), or require plugins to pair every numeric-code consume with a per-identifier RateLimiter.consume budget. Decide and document the shared per-account cross-factor counter before the two-factor and email-otp plugins are written.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: SMS OTP readiness
- Full dossier: [`sms-otp-specialist`](../../.reports/sms-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-002` — Verification token digest compared with !== instead of constant-time equality](low/ACS-002-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-005` — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes](medium/BCR-005-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSG-003` — No retention sweep: expired sessions and consumed/expired verification rows persist forever](high/CSG-003-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-008` — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly](medium/ECF-008-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-otp-substrate`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:202`. Fix: Add an optional per-token attempt budget: each failed consume against a live row increments attempts; the row is burned at maxAttempts. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Per-token attempt budget: Verification.issue maxAttempts; a wrong presentation against a live row spends an attempt atomically (layerMemory Ref.modify; layerSql single UPDATE attempts = attempts + 1 with burn at the budget, core migration 26, recordFailedAttempt repository op) and the row is burned at maxAttempts; failure stays the uniform TokenConsumed. Tests: packages/core/test/Verification.test.ts. BEH-EA-062 As-shipped note.
