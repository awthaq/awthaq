---
ID: "MLO-002"
Title: "Verification.reserve - the domain-level resend/serialization primitive - has zero production callers"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Verification.ts:116"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-002 — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers

`MEDIUM` · `architecture` · `core` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **ready-for-agent**

## Summary

BEH-EA-063 and ADR-EA-016 exist to provide atomic first-caller-wins reservations (a dedicated verification_reservations table with a conditional upsert), and the memory and SQL layers plus tests implement them correctly - but grep across all 21 packages finds no caller outside Verification.test.ts and the SQL repository tests. Resend limiting in packages/password rests entirely on the per-email RateLimiter; the primitives meant to serialize operations like 'one outstanding reset flow per identifier' or to de-duplicate mail sends under concurrent requests are dead code in production paths, and the eventual magic-link plugin is exactly the consumer this machinery was built for.

## Evidence

Source: `packages/core/src/Verification.ts:116`

```
readonly reserve: (input: {
  readonly identifier: string;
  readonly ttl: Duration.Duration;
```

## Recommended fix

Either wire reserve into requestReset/resendVerification (e.g. guard 'one live reset token per identifier per window' as defense-in-depth under the RateLimiter) or document it explicitly as infrastructure reserved for M7's MagicLink/EmailOtp so its maintained-but-unwired status is a decision, not an accident.

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
- [`MLO-004` — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture](low/MLO-004-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, low)_`
- [`SOS-004` — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit](medium/SOS-004-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- … 3 more findings touch `packages/core/src/Verification.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-otp-substrate`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:121`. Fix: Make reserve's status a decision: document it as the resend-window primitive for MagicLink/EmailOtp (ticket 05) and use it there; until then note it in the Shape doc. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
