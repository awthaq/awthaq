---
ID: "THS-004"
Title: "TOTP secret encryption-at-rest left undecided despite a proven Encryption port"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: "spec/models/06-two-factor-totp.md:103"
Auditor: "totp-hotp-mfa-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# THS-004 — TOTP secret encryption-at-rest left undecided despite a proven Encryption port

`MEDIUM` · `security` · `—` · reported by **TOTP/HOTP MFA Specialist** (`totp-hotp-mfa-specialist`)

Status: **resolved**

## Summary

The authenticator shared secret is exactly the 'sensitive at rest' asset the persona rubric flags, yet its storage protection is still an open question — even though the infrastructure is done: the ports Encryption service is AES-256-GCM with a 12-byte IV, kid-tagged versioned envelopes, and AAD binding (packages/ports/src/Encryption.ts:46-47, 91-95), already proven in AccountsRepository (access/refresh tokens encrypted transparently, packages/sql/src/Repositories.ts:147-151) and OAuth PKCE flow state (packages/oauth/src/OAuth.ts:109-112). Leaving the decision open invites a first implementation that stores a base32 secret in the clear next to a hashed password.

## Evidence

Source: `spec/models/06-two-factor-totp.md:103`

```
Q58 include: TOTP secret encryption at rest, the exact challenge-cookie TTL
(better-auth's 10-minute default is cited, not adopted), whether failed
```

## Recommended fix

Decide now, before any schema exists: TOTP secrets are stored only as Encryption envelopes (AAD bound to e.g. 'two-factor:<userId>'), the same way accounts tokens already are; record it in spec/decisions/ so the migration starts encrypted and no plaintext column ever exists.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 24/100), domain: TOTP/HOTP MFA
- Full dossier: [`totp-hotp-mfa-specialist`](../../.reports/totp-hotp-mfa-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-006` — Shared per-account lockout counter for code brute-force is undecided and unowned](medium/BCR-006-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`BCR-010` — No BDD or behavior-spec coverage for backup codes despite the suite's own hook for it](low/BCR-010-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`SOS-006` — SIM-swap / NIST restricted-authenticator policy exists only in research; zero ADRs, decision explicitly undecided in spec](medium/SOS-006-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- [`THS-007` — Pre-session challenge state (challenge cookie) has no implementation and an undecided TTL/binding design](low/THS-007-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mfa-two-factor-hardening`. Evidence at HEAD ec065a7: `spec/models/06-two-factor-totp.md:103`. Fix: Record in a new ADR (with THS-007/BCR-006) that TOTP secrets are stored only as Encryption-port envelopes with AAD bound to the user, reusing packages/ports/src/Encryption.ts instead of the SecretBox port ticket 05 proposed (same intent, already shipped). (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ADR-EA-020 (spec/decisions/020-two-factor-state.md): TOTP secrets stored only as Encryption-port envelopes (AAD two_factor_secret:<userId>), no new SecretBox port; implemented in TwoFactorStore/SecondFactor and tested (ciphertext at rest, lazy re-encryption). Model MOD-EA-06 status updated.
