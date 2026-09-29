---
ID: "ACS-002"
Title: "Verification token digest compared with !== instead of constant-time equality"
Level: low
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:196"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-002 — Verification token digest compared with !== instead of constant-time equality

`LOW` · `security` · `core` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

Verification.consume compares the presented token's SHA-256 hex against the stored hash with plain !==, while Sessions deliberately uses constantTimeEqual for the identical shape (BEH-EA-056, spec/invariants.md:83 mandates constant-time for session secrets). Practical exploitability is negligible — the compared values are digests of 256-bit random secrets, so a timing leak on the digest reveals nothing recoverable — but the inconsistent discipline invites the pattern to spread to future lower-entropy comparisons.

## Evidence

Source: `packages/core/src/Verification.ts:196`

```
                row.value.valueHash !== presentedHash
```

## Recommended fix

Route the digest comparison through the same constantTimeEqual helper Sessions uses (or a shared internal module, see ACS-005), matching the codebase's own stated invariant.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-003` — Unthrottled /verify-email plus replay-per-miss floods the bounded AuthEvents PubSub](high/APS-003-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`BCR-005` — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes](medium/BCR-005-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-008` — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted](info/BCR-008-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSG-003` — No retention sweep: expired sessions and consumed/expired verification rows persist forever](high/CSG-003-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-008` — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly](medium/ECF-008-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`MLO-002` — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers](medium/MLO-002-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- [`SOS-004` — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit](medium/SOS-004-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-hardening`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:202`. Fix: Extract one shared constant-time comparator into @awthaq/ports and use it in Verification.layerMemory; document the SQL WHERE-equality exception. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New packages/ports/src/ConstantTime.ts (equalBytes/equalHex, exported from the ports index); Verification.layerMemory.consume and PasswordHasher use it, hasher's private copies removed. tryConsume documents the SQL WHERE-equality exception. Sessions.ts's private comparator left for now (another program is editing it). Tests: packages/ports/test/ConstantTime.test.ts, existing Verification suites.
