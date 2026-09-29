---
ID: "MLO-003"
Title: "All email-flow rate limits key on email alone; no IP or dual keying, so mailbox flooding is bounded only per-victim"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:158"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-003 — All email-flow rate limits key on email alone; no IP or dual keying, so mailbox flooding is bounded only per-victim

`MEDIUM` · `security` · `password` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **resolved**

## Summary

Every rule keys on identity/email - the module itself documents that no client-IP extraction exists anywhere yet and defers IP keying as tracked follow-on work. Until it lands, an attacker who knows a victim's address can trigger up to 5 reset mails + 3 resend mails per 15 min indefinitely (a harassment/inbox-flooding vector the resend comment itself names), and distributed password-reset spraying pays no per-IP cost at all. The tighter 3/15min resend limit shows the right instinct, but per-email buckets alone cannot see the attacker.

## Evidence

Source: `packages/password/src/Password.ts:158`

```
requestReset: { limit: 5, window: Duration.minutes(15) },
```

## Recommended fix

Add the tracked IP-keying work: key requestReset/resendVerification on (email, IP) jointly or run parallel per-IP rules with lower ceilings, so one source cannot rotate across victims and one victim cannot be flooded from one source.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `password-rate-limit-hardening`. Already fixed by commit a3b7255. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:923`. Fix: Give resendVerification the same per-IP dimension. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** resendVerification gains a per-source dimension: rules.resendVerificationByIp (20 per 15 min), handler resolves ClientAddress, IP checked before email. Test: PasswordRateLimits.test.ts (one IP across distinct emails is throttled, another IP is not).
