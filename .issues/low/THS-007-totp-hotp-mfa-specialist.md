---
ID: "THS-007"
Title: "Pre-session challenge state (challenge cookie) has no implementation and an undecided TTL/binding design"
Level: low
Category: "security"
Status: ready-for-agent
Package: "—"
Source: "spec/models/06-two-factor-totp.md:29"
Auditor: "totp-hotp-mfa-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# THS-007 — Pre-session challenge state (challenge cookie) has no implementation and an undecided TTL/binding design

`LOW` · `security` · `—` · reported by **TOTP/HOTP MFA Specialist** (`totp-hotp-mfa-specialist`)

Status: **ready-for-agent**

## Summary

The whole step-up flow hinges on a challenge artifact that says 'this browser cleared the first factor' — and it exists only as a spec sketch borrowing better-auth's numbers, with the TTL explicitly 'cited, not adopted' (:103-104) and no stated decisions on the properties that make such a cookie safe: binding of challengeId to the authenticated userId (so one user's challenge cannot verify another's), single live challenge per account, consumption on verify, and whether the signing key is the KeyProvider-backed one. Implemented naively, a challenge that outlives its window or is not user-bound becomes a session-minting bypass around the second factor.

## Evidence

Source: `spec/models/06-two-factor-totp.md:29`

```
minted until the second factor succeeds; a signed, HttpOnly 10-minute
challenge cookie binds the challenge to the browser; recovery codes are 10 ×
10 characters, hashed, deleted on use).
```

## Recommended fix

Specify the challenge as a first-class short-lived token: signed (or Encryption-envelope) cookie, TTL fixed (10 minutes is the cited default), AAD/content bound to userId, single-consume semantics via the existing Verification reserve/consume machinery, and revocation when 2FA is disabled — then port the session cookie's fixed-attribute rigor (BEH-EA-055) to it.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 24/100), domain: TOTP/HOTP MFA
- Full dossier: [`totp-hotp-mfa-specialist`](../../.reports/totp-hotp-mfa-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-006` — Shared per-account lockout counter for code brute-force is undecided and unowned](medium/BCR-006-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-010` — No BDD or behavior-spec coverage for backup codes despite the suite's own hook for it](low/BCR-010-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`SOS-006` — SIM-swap / NIST restricted-authenticator policy exists only in research; zero ADRs, decision explicitly undecided in spec](medium/SOS-006-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- [`THS-004` — TOTP secret encryption-at-rest left undecided despite a proven Encryption port](medium/THS-004-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mfa-two-factor-hardening`. Evidence at HEAD ec065a7: `spec/models/06-two-factor-totp.md:29`. Fix: Write ticket 05's challenge design into ADR-EA-020: challengeId minted by Verification.issue (identifier bound to userId, 10-minute TTL, single-consume, replay event), one live challenge per account, revoked when 2FA is disabled. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
