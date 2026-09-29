---
ID: "ACS-010"
Title: "TOTP, API-key, and magic-link crypto surfaces not yet implemented"
Level: info
Category: "compliance"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:8"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-010 — TOTP, API-key, and magic-link crypto surfaces not yet implemented

`INFO` · `compliance` · `two-factor` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

Two of the plugin packages in this audit's scope (two-factor TOTP, api-key) and magic-link are empty placeholders, so their crypto cannot be reviewed: TOTP will involve base32 secret encoding, truncated-HMAC code comparison, and replay windows; api-key will involve key generation and lookup-by-hash; magic-link reuses Verification. These are exactly the surfaces where the constant-time and entropy disciplines audited elsewhere must be carried over, and the current record is that no such code exists to assess.

## Evidence

Source: `packages/two-factor/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

When implemented, apply the established patterns: 128-bit+ secrets from Crypto.randomBytes, hash-at-rest lookup (never plaintext comparison), constant-time equality via the shared helper, and a parameter ceiling on any embedded-key computation.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mfa-two-factor`. Duplicate of `THS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
