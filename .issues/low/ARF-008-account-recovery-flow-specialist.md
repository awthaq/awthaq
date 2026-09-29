---
ID: "ARF-008"
Title: "Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked"
Level: low
Category: "dx"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:548"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-008 — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked

`LOW` · `dx` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **resolved**

## Summary

requestReset deliberately ignores emailVerified, so unverified accounts are recoverable — the right call, since the mailbox is otherwise unreachable as a trust anchor. But confirmReset updates the credential without flipping emailVerified, and signIn hard-refuses unverified users (lines 548-549): a user who forgot their password on an unverified account completes the entire reset flow and still cannot sign in, with no mail telling them why. The reset token just proved mailbox control — the same evidence verifyEmail requires — yet the flow discards it.

## Evidence

Source: `packages/password/src/Password.ts:548`

```
if (!user.emailVerified) {
          return yield* Effect.fail(new PasswordApi.EmailNotVerified());
```

## Recommended fix

Either treat a successfully consumed reset token as proof of mailbox control (flip emailVerified in the same transaction) or send the verification mail alongside the reset confirmation, so recovery actually ends in a usable session.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-recovery-correctness`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:841`. Fix: Treat a consumed reset token as email verification. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** confirmReset calls users.verifyEmail(userId) inside the transaction after updating the credential (a consumed reset token proves mailbox control). Test (red first): 'an unverified user who completes confirmReset can then signIn' in PasswordRecovery.test.ts. BEH-EA-117 states it.
