---
ID: "ESR-001"
Title: "AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens"
Level: medium
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:244"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-001 — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens

`MEDIUM` · `correctness` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **resolved**

## Summary

`update` reads the existing row (to obtain `providerId`/`userId` for the encryption AAD), encrypts the incoming tokens, then issues a second UPDATE statement — two autocommitted statements with no transaction. The consumer `Accounts.layerSql.updateCredentialHash` repeats the same read-then-write shape (packages/core/src/Accounts.ts:431-447), also unwrapped. If an OAuth token refresh and a password rehash race, the loser reads pre-refresh tokens and writes them back over the winner's freshly stored ones, silently orphaning credentials the provider has already invalidated. The stratum's own header says callers hold the transaction boundary, but no caller wraps this sequence either (only `unlink` uses `withTransaction`).

## Evidence

Source: `packages/sql/src/Repositories.ts:244`

```
const existing = yield* repo
          .findById(input.id)
          .pipe(Effect.catchTag("NoSuchElementError", Effect.die));
```

## Recommended fix

Either wrap the read-modify-write in `sql.withTransaction` inside the layer (or a port-level `SqlTransaction.withTransaction`), or better, eliminate the pre-read entirely by making AAD inputs (`providerId`, `userId`) part of the update request — both are immutable identity columns the caller already holds.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 76/100), domain: SQL persistence layer
- Full dossier: [`effect-sql-repository-specialist`](../../.reports/effect-sql-repository-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-20):** Fixed together with the identical, higher-severity [`PPS-001`](../high/PPS-001-postgres-performance-specialist.md) (same file, same evidence line, same defect — this finding's own second recommended option, eliminating the pre-read by making AAD part of the update request, is exactly what was implemented). See `PPS-001`'s resolution comment for full detail: `AccountsRepositoryShape.update` now takes `aad: {providerId, userId}` from the caller instead of an internal `findById`, and `Accounts.ts`'s `updateCredentialHash` wraps its own read-then-write in `sql.withTransaction`, closing the race this finding describes (a concurrent OAuth token refresh could otherwise lose to a password rehash reading pre-refresh tokens).
