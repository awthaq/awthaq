---
ID: "SSMS-008"
Title: "Session pagination lacks a composite index for its filter-plus-order shape"
Level: low
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:384"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-008 — Session pagination lacks a composite index for its filter-plus-order shape

`LOW` · `performance` · `sql` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

Migration 9 (CoreMigrations.ts:233) indexes sessions(userId) alone, which serves the equality filter, but every page of listByUser then sorts by (createdAt, id) - and the cursor variant additionally range-scans on that tuple. On a user with many sessions this is a per-page sort that a composite index would eliminate; sessions is one of the highest-churn tables in the system.

## Evidence

Source: `packages/sql/src/Repositories.ts:384`

```
? sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
```

## Recommended fix

Replace (or extend) the migration-9 index with sessions("userId", "createdAt", id), which serves the filter, the cursor range predicate, and the ordering without a sort.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-list-liveness-and-pagination`. Duplicate of `PPS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:233`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
