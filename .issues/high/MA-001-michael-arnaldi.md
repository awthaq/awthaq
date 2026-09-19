---
ID: "MA-001"
Title: "Password.signUp commits three writes with no transactional boundary the codebase already has a port for"
Level: high
Category: "architecture"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:486"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-001 — Password.signUp commits three writes with no transactional boundary the codebase already has a port for

`HIGH` · `architecture` · `password` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **resolved**

## Summary

signUp chains users.create (line 481) → accounts.link (line 486) → sessions.issue (line 494) as three independent effects with no SqlTransaction wrap. A failure between create and link leaves a real, credential-less, unverifiable User row (in the SQL backend, a row that also permanently occupies the unique email); a failure after link leaves a user with a credential but no session, and the memory backend's three sequential Ref.update calls are equally non-atomic. This is precisely the orphaned-user gap @awthaq/oauth already fixed: OAuth.ts:672-673 documents 'create and link now commit together via SqlTransaction — the clearest atomicity gap this codebase had'. The port (SqlTransaction.layerSql/layerNoop) exists, is provided by TestAuth, and Password simply never imports it — a cross-plugin discipline failure, not a missing capability.

## Evidence

Source: `packages/password/src/Password.ts:486`

```
        yield* accounts
          .link({
            userId: user.id,
```

## Recommended fix

Wrap the create/link (and ideally issue) sequence in sqlTransaction.withTransaction in Password.signUp, as OAuth.ts does; make @awthaq/ports' SqlTransaction a required RIn of any plugin whose make performs multi-write flows, and add a BDD step asserting a mid-flow failure leaves no User row.

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

**Validation (2026-09-19):** CONFIRMED — `Password.ts:481-494` chains `users.create` → `accounts.link` (evidence at line 486 matches) → `sessions.issue` with no `SqlTransaction` wrap; `grep SqlTransaction packages/password/src/Password.ts` returns nothing. By contrast, `OAuth.ts:412,673-683` explicitly wraps `users.create`+`accounts.link` in `sqlTransaction.withTransaction`, with a comment calling this "the clearest atomicity gap this codebase had." The port (`SqlTransaction.layerSql`/`layerNoop`) exists and is proven out in OAuth's own plugin, so mirroring that pattern in Password.signUp is a well-scoped mechanical change. Status → ready-for-agent.

**Resolved (2026-09-19):** Already fully closed by [`RRC-002`](RRC-002-read-replica-consistency-specialist.md)'s own resolution (same file, same defect class) from earlier in this effort: `signUp` (`Password.ts:643-662`) now wraps `users.create` + `accounts.link` + `sessions.issue` in `sqlTransaction.withTransaction`, exactly this finding's recommended fix, with a doc comment explicitly citing BEH-EA-113's "MUST create the user and session in one transaction." Verified current against the live code. No new change needed — closing as a duplicate resolution.
