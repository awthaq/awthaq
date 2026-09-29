---
ID: "THS-001"
Title: "Entire two-factor/TOTP domain is an unimplemented placeholder"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:10"
Auditor: "totp-hotp-mfa-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# THS-001 — Entire two-factor/TOTP domain is an unimplemented placeholder

`HIGH` · `architecture` · `two-factor` · reported by **TOTP/HOTP MFA Specialist** (`totp-hotp-mfa-specialist`)

Status: **ready-for-agent**

## Summary

The package ships zero code: no TOTP/HOTP algorithm, no base32 secret encoding, no otpauth:// URI construction, no QR enrollment, no window/drift verification, no recovery codes. A repo-wide search finds no OTP primitives anywhere (the only SHA-1 use is the password plugin's HIBP prefix check, and no two_factor_* tables exist in @awthaq/sql). M7 is a P1 Phase-2 module per the roadmap, so the absence is planned rather than accidental — but as of this tree, an adopter has no second factor at all.

## Evidence

Source: `packages/two-factor/src/index.ts:10`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Sequence implementation to land the seams first (see THS-002), then the algorithm: a pure, zero-dependency RFC 4226/6238 module (HMAC-SHA-1, dynamic truncation, 6 digits, 30 s step) with property tests against RFC 4226 Appendix D vectors, then the plugin shell (enable/confirm/verify/verifyRecovery) over it.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 24/100), domain: TOTP/HOTP MFA
- Full dossier: [`totp-hotp-mfa-specialist`](../../.reports/totp-hotp-mfa-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/two-factor/src/index.ts` is still exactly the cited placeholder (`export {};` at line 10, comment "Empty placeholder" preserved); repo-wide grep finds zero OTP/TOTP primitives anywhere. Real, but the fix is an entire new crypto+plugin subsystem (algorithm, enrollment flow, recovery-code design) that needs product/architecture decisions, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [MFA/two-factor subsystem build-out](../../.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md) — a pure RFC 4226/6238 TOTP algorithm module (`packages/two-factor/src/Totp.ts`) property-tested against RFC 4226 Appendix D, plus the full plugin shell (enable/confirm/verify/verifyRecovery) tapping ticket 3's `Hooks.BeforeSessionIssue`. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mfa-two-factor`. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Fix: Build the TwoFactor plugin (ticket 05 §1) in 12 implementable steps: pure TOTP module, encrypted secret + hashed recovery-code stores, branded single-use challenge over Verification, enable/confirm/verify/verifyRecovery/disable/regenerate, contract, opt-in hook-tap layers enforced by the type system, events, erasure, spec + BDD. (effort XL). Full dossier: `.plan/slices/07-password-mfa.md`.
