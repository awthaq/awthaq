---
ID: "BAM-007"
Title: "two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users"
Level: high
Category: "api"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:10"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-007 — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users

`HIGH` · `api` · `two-factor` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

All three M7 packages are honest `export {}` stubs (magic-link and api-key identical). better-auth's twoFactor plugin stores TOTP secrets and encrypted recovery codes per user; a migrating two-factor user population has literally no table to land in, and enabling password-only parity for them means either downgrading their security posture or blocking their migration entirely.

## Evidence

Source: `packages/two-factor/src/index.ts:10`

```
export {};
```

## Recommended fix

Either land the two-factor plugin (TOTP secret storage, verification challenge, hashed recovery codes per the package header's own plan) before advertising password-plugin migration parity, or publish a migration-compatibility matrix declaring two-factor out of scope for v1 imports so teams can plan.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/two-factor/src/index.ts:10`, `packages/magic-link/src/index.ts`, and `packages/api-key/src/index.ts` are all confirmed `export {}` placeholders. Landing three real plugins (TOTP secret storage, recovery codes, API-key resolution) versus formally scoping them out of v1 import parity is a product-roadmap decision, not a mechanical change. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [MFA/two-factor subsystem build-out](../../.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md) — `two-factor` and `magic-link` both ship now per the design above; `api-key` is explicitly out of scope for this ticket and deferred to ticket 10 (`machine-service-identity-m2m`). Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passwordless-magic-link-email-otp`. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Fix: Ship `@awthaq/magic-link`'s MagicLink plugin on the Verification substrate, POST-only consumption, fragment-carried token, consulting BeforeSessionIssue (ARF-005 Fix A). (effort L). Full dossier: `.plan/slices/07-password-mfa.md`.

**Resolved (2026-09-29):** Shipped @awthaq/magic-link MagicLink on Verification: POST /magic-link/request (always 202) and POST /magic-link/verify only; no GET route; token in the URL fragment (<baseUrl>/magic-link#token=), random public id, address in the row payload, no table; consults BeforeSignIn/BeforeSessionIssue and diverts to TwoFactorRequired; amr [email]. Tests: packages/magic-link/test/MagicLink.test.ts, AuthHttp.test.ts (26 tests incl. contract). BEH-EA-240..243. Package README documents the interstitial page.
