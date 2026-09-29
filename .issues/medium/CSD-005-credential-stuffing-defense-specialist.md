---
ID: "CSD-005"
Title: "MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover"
Level: medium
Category: "security"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:10"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-005 — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover

`MEDIUM` · `security` · `two-factor` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

The two-factor package (listed in the package map as the MFA plugin) contains no implementation. There is also no CAPTCHA, risk-scoring, or step-up hook anywhere in library source (a repo-wide scan finds only unrelated WebAuthn/PKCE 'challenge' usages). Combined with breach checking off by default and no IP throttling, the system's response to a correctly guessed breached password is: issue a full session. Every defense-in-depth layer that would catch stuffing after the credential match is missing.

## Evidence

Source: `packages/two-factor/src/index.ts:10`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Ship the TOTP plugin per the roadmap's M7 milestone; until then, expose a composable post-credential-verify hook (the HookPoint machinery exists for organization lifecycle hooks) so applications can gate session issuance on their own risk logic.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mfa-two-factor`. Duplicate of `THS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
