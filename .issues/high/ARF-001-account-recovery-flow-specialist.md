---
ID: "ARF-001"
Title: "confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:630"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-001 — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently

`HIGH` · `security` · `password` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **resolved**

## Summary

BEH-EA-058 and BEH-EA-117 require that confirming a reset 'consume the reset token and revoke every other session for the account in the same transaction that sets the new password' (spec/behaviors/15-password.md:91-93), and Verification.ts's header (line 22-24) explicitly delegates the wrap to 'the calling plugin'. The calling plugin never does it: Password.ts does not even import SqlTransaction (imports at lines 20 vs OAuth.ts:28 which does), so consume (line 630), updateCredentialHash (line 657), and revokeAll (line 664) are three independent commits. A crash between consume and updateCredentialHash leaves the token burned with the old password still live; a failure between the hash update and revokeAll leaves the new password live while an attacker's pre-reset sessions survive — precisely the takeover window BEH-EA-117 exists to close. The BDD suite declares the guarding scenario (REQ-EA-163/165) but PasswordSteps.ts implements no step for 'A failure applying the authorized state change leaves the token unconsumed'.

## Evidence

Source: `packages/password/src/Password.ts:630`

```
yield* verification.consume(identifier, value).pipe(
          Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
          Effect.catchTag("PlatformError", Effect.die),
```

## Recommended fix

Wrap consume + updateCredentialHash + revokeAll in SqlTransaction.withTransaction (the port's layerSql threads the real transaction; layerNoop covers in-memory composition), mirroring OAuth.ts:682-684. Add the missing REQ-EA-165 step definition so a mid-flow failure is proven to roll the consumption back.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`AR-001` — Documented MFA step-up flow has no attachment point: nothing hooks session issuance](high/AR-001-aeneas-rekkas.md) `_(aeneas-rekkas, high)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts` imports (lines 10-31) contain no `SqlTransaction`, unlike `packages/oauth/src/OAuth.ts:28`, which does. `verification.consume` (line 630), `accounts.updateCredentialHash` (line 655), and `sessions.revokeAll` (line 664) are three independent, unwrapped effects. `packages/oauth/src/OAuth.ts:684` already demonstrates the `sqlTransaction.withTransaction(...)` pattern for an analogous create+link commit, so this fix is mechanical and precedented. Status → ready-for-agent.

**Resolved (2026-09-19):** `confirmReset` now wraps `verification.consume`, `accounts.updateCredentialHash`, and `sessions.revokeAll` in `SqlTransaction.withTransaction`, mirroring `OAuth.ts`'s own create+link precedent (ticket 16) — the `Password` plugin now imports and provides `SqlTransaction` at every composition site (production, HTTP handler paths, and every test/feature-world layer). Only the transaction's own `SqlError` dies; `TokenConsumed`/`WeakPassword` still reach the caller as themselves, and (as a structural consequence of the wrap) a `WeakPassword` rejection now rolls the token consumption back too under a real SQL backend, rather than burning a single-use token on a rejected password. RRC-002's companion `verifyEmail`/`signUp` gaps closed alongside this — see that finding's own comment. Note: the in-memory test composition's own `SqlTransaction.layerNoop` is a documented no-op passthrough (nothing to roll back for a `Ref`-backed store), so this fix's atomicity guarantee is only observable under a real `layerSql` backend — consistent with every other `SqlTransaction` usage already in this codebase, none of which have a dedicated rollback test either. Full monorepo typecheck and test suite (606 tests) pass with no behavior change under the in-memory composition.

**Cross-reference (2026-09-19):** [`TIR-004`](TIR-004-token-introspection-revocation-specialist.md) (same source file, same underlying defect) was resolved as a duplicate of this fix — no separate change needed.
