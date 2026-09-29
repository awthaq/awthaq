---
ID: "MLO-004"
Title: "Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture"
Level: low
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:196"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-004 — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture

`LOW` · `security` · `core` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **resolved**

## Summary

The memory layer compares the stored SHA-256 hex digest to the presented digest with !== (and the SQL layer does the same via WHERE "valueHash" = ?), while Sessions.ts implements constantTimeEqual for the identical secret-comparison problem and cites BEH-EA-056 for it. Practical risk is negligible here - a 256-bit random token leaves nothing to guess - but it is an inconsistent hardening posture within one package for the same class of comparison, and verification tokens gate password reset, the highest-value flow in the library.

## Evidence

Source: `packages/core/src/Verification.ts:196`

```
row.value.valueHash !== presentedHash
```

## Recommended fix

Reuse Sessions.ts' constantTimeEqual (extract it to a shared internal) for the memory-layer comparison, and note the DB-side equality caveat in the tryConsume doc comment.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Passwordless Email Tokens
- Full dossier: [`magic-link-email-otp-specialist`](../../.reports/magic-link-email-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-002` — Verification token digest compared with !== instead of constant-time equality](low/ACS-002-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-005` — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes](medium/BCR-005-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSG-003` — No retention sweep: expired sessions and consumed/expired verification rows persist forever](high/CSG-003-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-008` — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly](medium/ECF-008-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`SOS-004` — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit](medium/SOS-004-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `verification-hardening`. Duplicate of `ACS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:202`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
