---
ID: "SOS-008"
Title: "No phone identity groundwork: no phone field, no E.164 normalization, identifier taxonomy is email/password only"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Verification.ts:71"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-008 — No phone identity groundwork: no phone field, no E.164 normalization, identifier taxonomy is email/password only

`LOW` · `dx` · `core` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **ready-for-agent**

## Summary

Verification's identifier is a free-form string and its own doc comment illustrates the taxonomy as verify-email/reset-password only; there is no phone scheme, no phone column on User/Account, and no normalization helper anywhere in packages/ (E.164 greps return nothing). Un-normalized phone identifiers are a real security hazard, not just hygiene: '+1 555 0100', '15550100', and '+15550100' would mint three independent verification rows for one destination, splitting rate-limit and attempt budgets and allowing duplicate sends. The vendored better-auth analysis (better-auth/05-mfa-and-verification/04-phone-number.md:16-38) specifies what phone identity requires: globally-unique normalized phoneNumber, a phoneNumberVerified flag that can never be true while the number is null, and a narrowing of the generic update-user contract so a number can only be SET through its own verify flow.

## Evidence

Source: `packages/core/src/Verification.ts:71`

```
  /** BEH-EA-057: e.g. `verify-email:<userId>`, `reset-password:<userId>`. */
```

## Recommended fix

Before any SMS plugin: add a normalizePhone (E.164) helper to core or a shared module, define the identifier scheme (e.g. verify-phone:<userId> keyed on the normalized number), and adopt the better-auth invariants above — including forbidding raw client-supplied phone strings from ever reaching Verification.issue unnormalized.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `users-identity-model`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:72`. Fix: Ship E.164 normalization as part of ticket 09's Phone identity, enforced at the Users boundary, plus the verify-phone identifier scheme. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
