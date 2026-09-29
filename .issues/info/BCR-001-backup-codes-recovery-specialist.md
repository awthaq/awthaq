---
ID: "BCR-001"
Title: "Backup codes entirely absent; two-factor package is an honest export{} placeholder"
Level: info
Category: "architecture"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:8"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-001 — Backup codes entirely absent; two-factor package is an honest export{} placeholder

`INFO` · `architecture` · `two-factor` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **resolved**

## Summary

The persona's core domain does not exist in code: packages/two-factor exports nothing, and a repo-wide grep for backup-code/recovery-code identifiers finds only documentation, coverage artifacts, and a test fixture name. No generation, hashed storage, single-use consumption, regeneration, or show-once UX exists. The absence is at least honestly labeled here and in the README (which nonetheless advertises 'hashed recovery codes' as the package description), and spec/models/06 explicitly gates the work on Phase 2 enabler E4.

## Evidence

Source: `packages/two-factor/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Keep the honest placeholder until the enabler lands, but add a pointer from the README to spec/models/06-two-factor-totp.md and research/07 Q58 so the storage/consumption decisions do not have to be rediscovered at implementation time.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mfa-two-factor`. Duplicate of `THS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `THS-001-totp-hotp-mfa-specialist` — closed by its fix (see that issue's Resolved comment).
