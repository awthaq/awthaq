---
ID: "MA-010"
Title: "Sign-up verification mail is an unsupervised detached fiber with no shutdown or backpressure story"
Level: low
Category: "architecture"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:501"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-010 — Sign-up verification mail is an unsupervised detached fiber with no shutdown or backpressure story

`LOW` · `architecture` · `password` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **resolved**

## Summary

Deferring mail latency off the response path is the correct product decision (the comment cites the enumeration side channel), but forkDetach is the weakest primitive available: the fiber joins no scope, is invisible to supervision, its failures are swallowed by Effect.ignore (lines after 504), and under a burst of sign-ups the fork count is unbounded. On short-lived runtimes (serverless, a deploy shutdown mid-request) the verification mail silently vanishes — for an auth product, 'user never receives verify-email and cannot sign in' is a provisioning bug, not a telemetry gap. Effect offers the structured alternative this codebase otherwise uses everywhere: forkIn an application-scoped fiber (attached to the Layer's scope, interrupted cleanly on shutdown) or a bounded queue drained by a supervised worker.

## Evidence

Source: `packages/password/src/Password.ts:501`

```
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const identifier = `${VERIFY_PREFIX}${user.id}`;
```

## Recommended fix

Replace with a forkIn(scope) attached to the plugin layer's own scope (or a small bounded PubSub/Queue worker inside the plugin's make), so mail delivery is tracked, bounded, and flushed or logged on shutdown instead of silently dropped.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mail-delivery-reliability`. Duplicate of `ERS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:775`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
