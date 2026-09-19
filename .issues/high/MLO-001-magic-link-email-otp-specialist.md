---
ID: "MLO-001"
Title: "requestReset awaits mailer.send inline, creating a timing-based email-enumeration oracle"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:584"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-001 — requestReset awaits mailer.send inline, creating a timing-based email-enumeration oracle

`HIGH` · `security` · `password` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **resolved**

## Summary

requestReset only sends mail when the email resolves to an account, and it awaits mailer.send inline before returning. Response latency therefore correlates with account existence (SMTP/TLS round-trip, provider latency), letting an attacker enumerate registered emails by timing alone - exactly the side channel signUp's own comment names ("a slow-vs-fast response is itself an enumeration side channel", research/05-oauth-oidc.md Q48) and fixes there with Effect.forkDetach (Password.ts:501). BEH-EA-064's uniform-response requirement is satisfied at the status/body level but broken at the timing level in this flow; resendVerification (Password.ts:609) repeats the same pattern. A real provider outage also surfaces here as a failed request for existing accounts only - a second distinguishing signal.

## Evidence

Source: `packages/password/src/Password.ts:584`

```
yield* mailer.send({
  to: user.email,
  template: "reset-password",
```

## Recommended fix

Mirror signUp: wrap the issue+mailer.send block in Effect.forkDetach (with a mail-failure event instead of Effect.ignore silence), or route through a durable queue; alternatively pad the unknown-email branch with equivalent work. Do the same in resendVerification.

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

**Validation (2026-09-19):** CONFIRMED — `Password.ts:584-588` matches the evidence; `requestReset` `yield*`s `mailer.send` inline only inside the `Option.isSome(userOpt)` branch, with no fork/detach, unlike `signUp` (`Password.ts:501-511`), which explicitly wraps its issue+mail block in `Effect.forkDetach` "so response latency must not depend on mail-provider latency." `resendVerification` (`Password.ts:609-613`) repeats the same inline-await pattern. Mirroring `signUp`'s `forkDetach` pattern in both is a well-scoped mechanical fix. Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `TSS-001` (shared source line, same root cause) — see that finding's comment. `resendVerification`'s own companion fix is `TSS-002`.
