---
ID: "TSS-001"
Title: "requestReset awaits mailer.send inline — response-time and failure-status enumeration oracle"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:584"
Auditor: "timing-side-channel-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TSS-001 — requestReset awaits mailer.send inline — response-time and failure-status enumeration oracle

`HIGH` · `security` · `password` · reported by **Timing / Side-Channel Specialist** (`timing-side-channel-specialist`)

Status: **resolved**

## Summary

For a registered email, requestReset pays verification.issue plus a fully awaited mailer.send (real network I/O in production); for an unknown email it returns immediately after the user lookup. The comment at lines 574-577 claims the difference is "invisible to the caller", but request latency is directly observable, and Mailer.send's Effect.Effect<void> signature (packages/ports/src/Mailer.ts:38) means a failing provider or the intended-prod layerNoop mailer (which Effect.die's, Mailer.ts:54) turns the known-email path into a 500 while the unknown-email path still returns 202 — a content-level oracle on top of the timing channel. This contradicts BEH-EA-064 (spec/behaviors/08-verification-tokens.md:113 "requestReset always answers 202, whether the email belongs to a real account or not") and the codebase's own stated reasoning at lines 497-500 citing research/05-oauth-oidc.md Q48 that slow-vs-fast responses are themselves an enumeration side channel — reasoning signUp implements correctly with Effect.forkDetach at line 501.

## Evidence

Source: `packages/password/src/Password.ts:584`

```
yield* mailer.send({
  to: user.email,
  template: "reset-password",
```

## Recommended fix

Wrap the issue+send block in Effect.forkDetach(Effect.ignore(...)) exactly as signUp does at line 501, so both branches cost one user lookup and return 202 with identical latency distribution regardless of mail-provider latency or failure.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: timing side channels
- Full dossier: [`timing-side-channel-specialist`](../../.reports/timing-side-channel-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `requestReset` (`packages/password/src/Password.ts:576-588`) awaits `mailer.send` inline inside the known-email branch, evidence matches exactly; `signUp` (`Password.ts:500-510`) already demonstrates the correct `Effect.forkDetach(Effect.ignore(...))` pattern for the identical issue+send sequence. Mechanical fix mirroring existing sibling code. Status → ready-for-agent.

**Resolved (2026-09-19):** `requestReset` now mirrors `signUp`'s own `Effect.forkDetach(...).pipe(Effect.ignore)` posture: the `verification.issue`+`mailer.send` pair for a known account runs in a detached background fiber, so the endpoint returns after one user lookup with the same latency distribution regardless of whether the email resolves to an account, and regardless of mail-provider health (a dead provider can no longer turn the known-email branch into a 500 while the unknown-email branch still answers 202). Regression test in `packages/password/test/Password.test.ts` (`TSS-001/EEM-001/MLO-001: requestReset for a known account doesn't wait on mailer.send`) provides a `Mailer` whose `send` never resolves (`Effect.never`) and asserts `requestReset` still completes — verified to genuinely hang/time out with the fix reverted. Full monorepo typecheck and test suite (606 tests) pass.
