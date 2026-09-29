---
ID: "TTE-008"
Title: "Two-factor challenge state machine absent — the flagship illegal-state encoding cannot exist yet"
Level: info
Category: "architecture"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:8"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-008 — Two-factor challenge state machine absent — the flagship illegal-state encoding cannot exist yet

`INFO` · `architecture` · `two-factor` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

The persona's canonical probe — 'a two-factor challenge must be verified before a session can be finalized, so the compiler rejects the wrong order' — has no object: two-factor (like magic-link and api-key) is a 10-line placeholder. This is honestly documented, not hidden, and the building blocks it will need already exist and are well-typed: HookPoint's `DivertTap`/`DivertResult` discrimination and `Auth.make`'s layer composition.

## Evidence

Source: `packages/two-factor/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

When implementing M7, model the challenge as its own branded type (`TwoFactorChallenge`) that only `verify` returns, and have session-finalization accept only the verified brand — never a boolean flag on a shared session shape — so the unverified state is unrepresentable where a verified session is expected.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mfa-two-factor`. Duplicate of `THS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `THS-001-totp-hotp-mfa-specialist` — closed by its fix (see that issue's Resolved comment).
