---
ID: "TIR-004"
Title: "Password-reset revocation is not transactional, violating BEH-EA-117"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:657"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-004 — Password-reset revocation is not transactional, violating BEH-EA-117

`HIGH` · `security` · `password` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **resolved**

## Summary

spec/behaviors/15-password.md BEH-EA-117 requires confirmReset to 'consume the reset token and revoke every other session for the account in the same transaction that sets the new password'. The code runs three independent effects - verification.consume (line 630), accounts.updateCredentialHash (line 657), sessions.revokeAll (line 664) - with no SqlTransaction.withTransaction wrapper, even though the port built for exactly this (ticket 16, packages/ports/src/SqlTransaction.ts) exists in the repo. A process crash or persistence failure after the credential hash lands but before revokeAll leaves every pre-compromise session live against the new password - the exact attacker-retention scenario BEH-EA-117 exists to close. This is a cross-checked docs-vs-code divergence, not a doc-only nit.

## Evidence

Source: `packages/password/src/Password.ts:657`

```
yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
```

## Recommended fix

Wrap the consume + updateCredentialHash + revokeAll sequence in SqlTransaction.withTransaction (layerSql for SQL compositions, layerNoop for memory) and note the SqlError channel in the flow; the memory composition is already atomic per Ref.modify.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token revocation & introspection
- Full dossier: [`token-introspection-revocation-specialist`](../../.reports/token-introspection-revocation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `confirmReset` (`packages/password/src/Password.ts:618-664`) runs `verification.consume`, `accounts.updateCredentialHash` (evidence quote matches line 657 exactly), and `sessions.revokeAll` as three independent, unwrapped effects; `SqlTransaction.withTransaction` (`packages/ports/src/SqlTransaction.ts`) exists and is already used in `packages/oauth/src/OAuth.ts:412` but is not imported by `Password.ts`. Fix is a mechanical wrap using an existing, precedented port. Status → ready-for-agent.

**Resolved (2026-09-19):** Already fully closed by [`ARF-001`](ARF-001-account-recovery-flow-specialist.md)'s own resolution (same source file, same underlying defect — three independent commits in `confirmReset`) from earlier in this effort: `confirmReset` now wraps `verification.consume` + the weak-password check + `accounts.updateCredentialHash` + `sessions.revokeAll` in a single `sqlTransaction.withTransaction(...)` (`Password.ts:853-896`), mirroring `OAuth.ts`'s own precedent. Verified current: read the live code directly rather than re-deriving from the tracker comment alone. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.
