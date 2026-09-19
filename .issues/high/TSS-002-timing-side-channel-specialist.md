---
ID: "TSS-002"
Title: "resendVerification awaited send yields a three-profile timing classifier (unknown vs verified vs unverified)"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:603"
Auditor: "timing-side-channel-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TSS-002 — resendVerification awaited send yields a three-profile timing classifier (unknown vs verified vs unverified)

`HIGH` · `security` · `password` · reported by **Timing / Side-Channel Specialist** (`timing-side-channel-specialist`)

Status: **resolved**

## Summary

The guard produces three externally distinguishable latency profiles: unknown email (fast — lookup only), registered-and-verified (fast — lookup only, no issue/send), registered-and-unverified (slow — verification.issue plus awaited mailer.send at line 609). Probing both resendVerification and requestReset on the same address lets an attacker classify every address into unknown / known-unverified / known-verified, which is strictly more information than requestReset alone. Same root cause as TSS-001 and the same contradiction with the forkDetach posture signUp demonstrates; rate limiting at 3/15min slows but does not close the channel.

## Evidence

Source: `packages/password/src/Password.ts:603`

```
if (Option.isSome(userOpt) && !userOpt.value.emailVerified) {
  const user = userOpt.value;
  const identifier = `${VERIFY_PREFIX}${user.id}`;
```

## Recommended fix

Apply the same forkDetach+Effect.ignore treatment to the issue+send block, making all three branches latency-equivalent; optionally add a dummy verification.issue to the no-send branches if sub-millisecond DB-write asymmetry matters against a high-precision attacker.

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

**Validation (2026-09-19):** CONFIRMED — `resendVerification` (`packages/password/src/Password.ts:591-616`) guards the issue+send block on `Option.isSome(userOpt) && !userOpt.value.emailVerified` (evidence matches line 603 exactly), with `mailer.send` awaited inline, producing the described three-profile timing split. Same root cause and same mechanical fix as TSS-001. Status → ready-for-agent.

**Resolved (2026-09-19):** `resendVerification` now mirrors `signUp`/`requestReset`'s `Effect.forkDetach(...).pipe(Effect.ignore)` posture for its own `verification.issue`+`mailer.send` pair, closing the third latency profile (known-unverified) that previously distinguished it from the fast known-verified/unknown-email branches. Regression test in `packages/password/test/Password.test.ts` (`TSS-002: resendVerification for a known, unverified account doesn't wait on mailer.send`) mirrors `TSS-001`'s hanging-`Mailer` technique — verified to genuinely hang/time out with the fix reverted. Full monorepo typecheck and test suite (606 tests) pass.
