---
ID: "AOMS-003"
Title: "MFA is absent at runtime: two-factor placeholder plus unconditional session issue"
Level: high
Category: "security"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:8"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-003 — MFA is absent at runtime: two-factor placeholder plus unconditional session issue

`HIGH` · `security` · `two-factor` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

An Auth0 tenant with an MFA policy imports into a system where nothing can enforce step-up: packages/two-factor is an `export {}` placeholder, and both session-issuing paths mint sessions unconditionally — password signIn (packages/password/src/Password.ts, session issued immediately after credential verification) and the OAuth callback (`sessions.issue({ userId: targetUserId })`, packages/oauth/src/OAuth.ts:729) — with no divert point, no amr/acr recording, and no MFA-related event in AuthEvents' closed registry. The adoption matrix's own E4 enabler ('hook-point step-up/divert wiring') and roadmap M7 acknowledge this, but until it lands a migration must either accept silently downgrading the tenant's assurance posture or build a bespoke gate with no supported seam.

## Evidence

Source: `packages/two-factor/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Before advertising enterprise migrations, wire the spec'd BeforeSessionIssue divert point into Sessions-issuing plugins and ship the TwoFactor plugin against it; until then, document MFA absence as a hard blocker in the migration-readiness README so tenants with MFA policies do not plan an exit onto effect-auth.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`SOS-001` — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders](high/SOS-001-sms-otp-specialist.md) `_(sms-otp-specialist, high)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/two-factor/src/index.ts:8-10` is exactly the quoted empty placeholder; `packages/password/src/Password.ts:559` and `packages/oauth/src/OAuth.ts:729` both call `sessions.issue(...)` unconditionally right after credential verification, with no divert point or MFA event. This is a ground-up feature build (MFA hook-point wiring, TOTP plugin) requiring architecture/product decisions before implementation. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [MFA/two-factor subsystem build-out](../../.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md) — ship a real `TwoFactor` plugin (RFC 6238 TOTP + hashed recovery codes) tapping ticket 3's `Hooks.BeforeSessionIssue` divert point, with a new `SecretBox` port for at-rest secret encryption and the challenge state reusing `Verification.issue`/`consume`. Status → ready-for-agent.

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `mfa-two-factor`. Already fixed by commit 3e298c8. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Fix: Close the residual after THS-001 lands: MFA events in the audit trail, `amr` recorded on sessions minted after a second factor, and the Auth0 migration doc stating enrolments are not importable. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`.

**Resolved (2026-09-29):** Residual closed: MFA events (auth.twoFactor.*: enabled/disabled/verified/challengeFailed/recoveryCodeUsed/recoveryCodesRegenerated/locked) reach the audit trail via AuthEvents; sessions minted after a second factor record amr (e.g. [pwd, otp] / [pwd, recovery]) via BeforeSessionIssue/Sessions amr; packages/migrate-auth0/README.md now has 'MFA enrolments are not importable'. Tests: packages/two-factor/test/TwoFactor.test.ts, packages/core/test/Assurance.test.ts.
