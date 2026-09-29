---
ID: "PPS-002"
Title: "Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set"
Level: medium
Category: "performance"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:233"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-002 — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set

`MEDIUM` · `performance` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **ready-for-agent**

## Summary

The pagination query (packages/sql/src/Repositories.ts:383-388) filters on "userId", range-scans ("createdAt", id) via an OR predicate, and sorts ORDER BY "createdAt" ASC, id ASC. With only sessions_user_id on ("userId"), Postgres can use the index for the filter but must then fetch every session row for the user and sort them before applying LIMIT — for a user with thousands of sessions every page pays an O(n) sort, and the OR form prevents the planner from using a single index-scan stop condition. The behavior spec (BEH-EA-036) is right to mandate keyset pagination, but the shipped index does not back it.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:233`

```
pg: () => sql`CREATE INDEX sessions_user_id ON sessions("userId")`,
```

## Recommended fix

Add a composite index ("userId", "createdAt", id) on sessions — created CONCURRENTLY on live deployments — and express the cursor as a row-comparison predicate (("userId", "createdAt", id) > ($1, $2, $3) semantics) so one index scan both filters and satisfies the ORDER BY with no sort node; keep the single-column index only if the bulk DELETEs still need it.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Postgres performance
- Full dossier: [`postgres-performance-specialist`](../../.reports/postgres-performance-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-010` — No retention policy or mechanism exists for any audit data](low/ALF-010-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CSG-009` — No residency, region, or subprocessor hooks; data location is undocumented deployer choice](info/CSG-009-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, info)_`
- [`DRS-001` — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change](high/DRS-001-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`PPS-009` — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres](info/PPS-009-postgres-performance-specialist.md) `_(postgres-performance-specialist, info)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-list-liveness-and-pagination`. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:231`. Fix: Add a partial composite index that matches the page query's filter and order, and rewrite the cursor as a row-value comparison. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
