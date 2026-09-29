---
ID: "SEA-006"
Title: "Keyset pagination orders by (createdAt, id) but only a single-column userId index exists"
Level: low
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:234"
Auditor: "sqlite-embedded-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SEA-006 — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists

`LOW` · `performance` · `sql` · reported by **SQLite Embedded Auth Specialist** (`sqlite-embedded-auth-specialist`)

Status: **resolved**

## Summary

Sessions.listByUser filters by userId then sorts by (createdAt ASC, id ASC) with a keyset predicate (Repositories.ts:383-388), but migration 9 creates only sessions_user_id ON sessions(userId) (and migration 8 the accounts equivalent). SQLite will use the index for the WHERE and then sort each user's rows — fine for per-user page sizes (default 50, Repositories.ts:365), but the sort is redundant work on every page fetch, and the accounts table's listByUser has the same shape. A composite (userId, createdAt, id) index serves filter, order, and keyset seek from one structure, which matters more on SQLite where the sort competes with the single writer for the same connection time.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:234`

```
      sqlite: () => sql`CREATE INDEX sessions_user_id ON sessions(userId)`,
```

## Recommended fix

Replace the single-column indexes with composite ones (userId, createdAt, id) for sessions and (userId) plus the covering needs of accounts.listByUser; both dialect branches accept the same composite DDL.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Embedded SQLite Persistence
- Full dossier: [`sqlite-embedded-auth-specialist`](../../.reports/sqlite-embedded-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-010` — No retention policy or mechanism exists for any audit data](low/ALF-010-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CSG-009` — No residency, region, or subprocessor hooks; data location is undocumented deployer choice](info/CSG-009-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, info)_`
- [`DRS-001` — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change](high/DRS-001-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`PPS-002` — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set](medium/PPS-002-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`
- [`PPS-009` — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres](info/PPS-009-postgres-performance-specialist.md) `_(postgres-performance-specialist, info)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-list-liveness-and-pagination`. Duplicate of `PPS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:234`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
