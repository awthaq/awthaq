---
ID: "ERS-002"
Title: "Detached verification-mail fiber is unsupervised, unretried, and droppable on shutdown"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/Password.ts:501"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-002 — Detached verification-mail fiber is unsupervised, unretried, and droppable on shutdown

`MEDIUM` · `correctness` · `password` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **ready-for-agent**

## Summary

The sign-up verification email is dispatched via Effect.forkDetach wrapped in Effect.ignore (line 510): the fiber answers to no scope, no supervisor, and no observer. Detaching is intentional (BEH-EA-113: response latency must not depend on mail-provider latency), but the design has three runtime consequences: (1) a SIGTERM during mailer.send silently drops the verification email — the verification token was already issued, so the user is stuck unverified with no record of the loss; (2) a transient mail-provider 5xx permanently loses the mail since Effect.ignore swallows the failure and no retry Schedule exists; (3) if the fiber dies between verification.issue and mailer.send, the token exists but is never delivered.

## Evidence

Source: `packages/password/src/Password.ts:501`

```
yield* Effect.forkDetach(
          Effect.gen(function* () {
            const identifier = `${VERIFY_PREFIX}${user.id}`;
```

## Recommended fix

Keep the dispatch off the response path but make it owned and observable: publish an auth.verification.requested event and deliver via an AuthEvents.on-style scoped subscription layer (the pattern already exists in core), or fork into a layer-owned queue whose finalizer drains (or flushes) pending sends on shutdown. Add a small Effect.retry with jittered exponential backoff inside the delivery fiber and log/mail-loss metrics under a stable event name instead of Effect.ignore.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mail-delivery-reliability`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:775`. Fix: A layer-owned mail dispatcher: forks into a scoped FiberSet (still non-blocking), retries with jittered backoff, bounds concurrency, publishes `auth.mail.failed`, and drains on shutdown; Mailer.send gains a typed failure. (effort M). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.
