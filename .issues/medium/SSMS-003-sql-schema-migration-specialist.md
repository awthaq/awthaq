---
ID: "SSMS-003"
Title: "verification findByIdentifier cannot use any index and scans an unbounded history table"
Level: medium
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:535"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-003 — verification findByIdentifier cannot use any index and scans an unbounded history table

`MEDIUM` · `performance` · `sql` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

The only index touching verification_tokens.identifier is partial - WHERE consumedAt IS NULL (CoreMigrations.ts:173-174) - and the planner may use a partial index only when the query's predicate implies the index predicate. findByIdentifier has no consumedAt IS NULL clause, so it degrades to a sequential scan plus a sort on every call. This is a hot auth path (token lookup), and the table grows without bound by design: consumed rows are retained forever so replays remain distinguishable (Models.ts:135-137, Repositories.ts:486-488). tryConsume and upsertLive are fine - their predicates/conlict target match the partial index - but findByIdentifier gets slower with every issued token.

## Evidence

Source: `packages/sql/src/Repositories.ts:535`

```
sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY "createdAt" DESC LIMIT 1`,
```

## Recommended fix

Add a plain index on verification_tokens(identifier) (or (identifier, createdAt DESC)) in a new migration; keep the partial unique index for the upsert conflict target.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `verification-store-hygiene`. Duplicate of `PPS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:644`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
