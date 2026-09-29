---
ID: "ECF-009"
Title: "No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent"
Level: info
Category: "architecture"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:8"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-009 — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent

`INFO` · `architecture` · `two-factor` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

Semaphore, STM/TRef, Deferred, and Queue are used in zero packages — all coordination is Ref.modify CAS plus one Effect.cached — and Effect.race is likewise never used. The persona's flagship 2FA-verification rate limiting cannot be assessed: packages/two-factor is an empty M7 placeholder, and no plugin currently caps OTP-style attempts via Verification.reserve despite the one-claim-per-identifier primitive being ready (it is exercised only in tests). The Ref-CAS discipline is correct for today's in-process stores, but nothing in the codebase yet expresses bounded fan-out (per-account hash admission, provider-call concurrency caps), which becomes load-bearing the moment a Redis store or worker pool arrives.

## Evidence

Source: `packages/two-factor/src/index.ts:8`

```
Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

When M7 lands, build 2FA attempt throttling on Verification.reserve + RateLimiter (both already atomic), and introduce the project's first Semaphore for hashing/provider-call admission per ECF-004/ECF-001; keep STM out until a genuinely multi-key invariant needs it — Ref.modify is earning its keep so far.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mfa-two-factor`. Duplicate of `THS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
