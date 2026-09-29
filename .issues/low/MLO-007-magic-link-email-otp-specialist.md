---
ID: "MLO-007"
Title: "signUp's forked verification mail swallows provider failures with Effect.ignore - silent token loss"
Level: low
Category: "correctness"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:510"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-007 — signUp's forked verification mail swallows provider failures with Effect.ignore - silent token loss

`LOW` · `correctness` · `password` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **resolved**

## Summary

The detached fiber that issues and mails the verify-email token ignores every outcome, so a Mailer outage or template failure produces an account that can never verify and no operational signal beyond the eventual failed verify attempt. The correct goal - never block signUp on mail latency - needs only latency decoupling, not failure suppression; a dead verification mail is precisely the situation the replay/audit event stratum was built to observe. resendVerification partially compensates (a user can re-request), but nothing tells the operator mail is failing.

## Evidence

Source: `packages/password/src/Password.ts:510`

```
}).pipe(Effect.ignore),
```

## Recommended fix

Replace Effect.ignore with Effect.tapError on the forked fiber's failure channel (or catchTag into an auth.mail.failed AuthEvent) so delivery failures are observable while remaining latency-decoupled.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Passwordless Email Tokens
- Full dossier: [`magic-link-email-otp-specialist`](../../.reports/magic-link-email-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mail-delivery-reliability`. Duplicate of `ERS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:783`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
