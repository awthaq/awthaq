---
ID: "SOS-001"
Title: "SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders"
Level: high
Category: "architecture"
Status: resolved
Package: "two-factor"
Source: "packages/two-factor/src/index.ts:10"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-001 — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders

`HIGH` · `architecture` · `two-factor` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **resolved**

## Summary

Greps for sms|phone|telephony|twilio|e164 and for otp across packages/, features/, and examples/ return zero matches: there is no SmsSender port, no phone field on User/Account, no OTP code path, and no BDD feature. The factor an SMS plugin would extend or pair with (two-factor, TOTP) and the channel-delivery sibling (magic-link) are both export-{} placeholders, so there is no implemented template for channel-delivered credentials at all. The roadmap positions Email OTP and Two-Factor as Phase-2 (spec/models/00-adoption-matrix.md:116-118), which makes the absence honest rather than broken — but it means every OTP-specific property (numeric code space, attempt caps, resend windows, SIM-swap posture) is currently undesigned in code terms, not just unimplemented.

## Evidence

Source: `packages/two-factor/src/index.ts:10`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
//
export {};
```

## Recommended fix

Before any sms-otp work, land the shared enabler first: the Email OTP / magic-link channel-credential substrate (E1) with an attempt-budgeted consume path, since research/07-passwords-2fa.md:129 already specifies the shared shape (6-digit code, pluggable sendOTP, hashed storage, resend window). An SMS plugin then becomes a channel over that substrate plus an SmsSender port, exactly as the adoption matrix's E1 row intends.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: SMS OTP readiness
- Full dossier: [`sms-otp-specialist`](../../.reports/sms-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-005` — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor](high/ARF-005-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ACS-010` — TOTP, API-key, and magic-link crypto surfaces not yet implemented](info/ACS-010-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, info)_`
- [`AOMS-003` — MFA is absent at runtime: two-factor placeholder plus unconditional session issue](high/AOMS-003-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-001` — Backup codes entirely absent; two-factor package is an honest export{} placeholder](info/BCR-001-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, info)_`
- [`BAM-007` — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users](high/BAM-007-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSD-005` — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover](medium/CSD-005-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ECF-009` — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent](info/ECF-009-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, info)_`
- [`THS-001` — Entire two-factor/TOTP domain is an unimplemented placeholder](high/THS-001-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, high)_`
- … 1 more findings touch `packages/two-factor/src/index.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — packages/two-factor/src/index.ts:10 is the cited empty placeholder, and repo-wide greps for sms/phone/telephony/twilio/e164/otp return no real source matches (only `.tsbuildinfo` build artifacts). spec/models/00-adoption-matrix.md:116-118 confirms this is roadmapped Phase-2 work, so the absence is honest, but designing the OTP/channel-credential substrate is a genuine product decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [MFA/two-factor subsystem build-out](../../.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md) — ship the shared `EmailOtp` channel-OTP substrate now; defer the SMS channel itself to a later, explicitly degraded `sms-otp` plugin (NIST SP 800-63B-4 "restricted" OOB status), never installable as an account's sole factor. Flagged as a scope call for the user's sanity-check, not an engineering-inevitable conclusion. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passwordless-magic-link-email-otp`. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Fix: Ship the EmailOtp substrate (6-digit, hashed, attempt-budgeted, resend-windowed) over Verification; record SMS as deferred. (effort L). Full dossier: `.plan/slices/07-password-mfa.md`.

**Resolved (2026-09-29):** Shipped EmailOtp in @awthaq/magic-link: 6-digit Verification-minted code (BCR-005), hashed, per-code attempt budget (SOS-004), 60s resend window via Verification.reserve (MLO-002), uniform InvalidEmailOtp 401, always-202 request, shared channel step and MFA divert, amr [otp,email]. SMS deferred: ADR-EA-021 (separate restricted plugin, method sms). Tests: packages/magic-link/test/EmailOtp.test.ts. BEH-EA-268..247.
