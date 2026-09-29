---
ID: "SOS-006"
Title: "SIM-swap / NIST restricted-authenticator policy exists only in research; zero ADRs, decision explicitly undecided in spec"
Level: medium
Category: "compliance"
Status: ready-for-agent
Package: "—"
Source: "spec/models/06-two-factor-totp.md:106"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-006 — SIM-swap / NIST restricted-authenticator policy exists only in research; zero ADRs, decision explicitly undecided in spec

`MEDIUM` · `compliance` · `—` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **ready-for-agent**

## Summary

All 16 ADRs in spec/decisions/ cover plugins-composition, qadi bridging, SQL claiming, error taxonomy, and similar infrastructure — none addresses channel-delivered credentials, SMS, or factor assurance. Meanwhile the analysis is already done and sitting in research: research/07-passwords-2fa.md:132 accurately summarizes NIST 63B-4 §3.1.3.3 (PSTN OOB is 'restricted': verifiers SHALL offer alternatives, SHOULD check 'device swap, SIM change, number porting' risk indicators), and :142 specifies the concrete design (separate degraded plugin, alternatives attestation, factor.sms.used events). The spec then re-opens the question as undecided (this finding's evidence). This is a documentation-velocity gap, not an analysis gap — but an implementer who starts from spec/ alone would build SMS OTP with no restricted-status constraints at all.

## Evidence

Source: `spec/models/06-two-factor-totp.md:106`

```
whether SMS OTP ships as a separate, explicitly "restricted" plugin per NIST
800-63B-4 guidance. None of this has been decided beyond the row in
`archive/PRD.md` §17.
```

## Recommended fix

Promote research/07-passwords-2fa.md's recommendation 7 into a spec/decisions ADR (e.g. 017-sms-otp-restricted-plugin) that settles: separate plugin, degraded marking, operator alternatives-attestation requirement, factor.sms.used audit event, and SIM-swap risk-indicator hook as a documented extension point. Cross-reference it from spec/models/06-two-factor-totp.md to close the open question.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: SMS OTP readiness
- Full dossier: [`sms-otp-specialist`](../../.reports/sms-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-006` — Shared per-account lockout counter for code brute-force is undecided and unowned](medium/BCR-006-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-010` — No BDD or behavior-spec coverage for backup codes despite the suite's own hook for it](low/BCR-010-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`THS-004` — TOTP secret encryption-at-rest left undecided despite a proven Encryption port](medium/THS-004-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, medium)_`
- [`THS-007` — Pre-session challenge state (challenge cookie) has no implementation and an undecided TTL/binding design](low/THS-007-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mfa-two-factor-hardening`. Evidence at HEAD ec065a7: `spec/models/06-two-factor-totp.md:106`. Fix: Codify decision ticket 05 §3 as ADR-EA-021: SMS OTP is a separate, explicitly restricted plugin over the EmailOtp channel substrate, never an account's sole factor, emitting a `factor.sms.used` audit event, with a SIM-swap risk-indicator hook as a documented extension point. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
