---
ID: "SSMS-009"
Title: "No tenant column anywhere in the core schema"
Level: info
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:59"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-009 — No tenant column anywhere in the core schema

`INFO` · `architecture` · `sql` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

All five core tables key only on id/userId/identifier; there is no tenant, organization, or region discriminator in the shipped DDL. Tenancy in this codebase lives in the organization plugin's own tables (which themselves have no production migrations - see SSMS-001), and deployment wiring assumes one DATABASE_URL. This is a coherent single-tenant-per-database posture, but it should be a stated decision, because retrofitting a tenant column into users/accounts/sessions after GA is precisely the expensive expand/contract sequence this persona exists to avoid.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:59`

```
CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
```

## Recommended fix

Record the isolation model (schema-per-tenant vs shared-schema) as an ADR before the first external deployment; if shared-schema multi-tenancy is ever on the table, ship the tenant column in the initial expand wave while tables are still small.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-010` — No retention policy or mechanism exists for any audit data](low/ALF-010-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CSG-009` — No residency, region, or subprocessor hooks; data location is undocumented deployer choice](info/CSG-009-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, info)_`
- [`DRS-001` — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change](high/DRS-001-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`PPS-002` — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set](medium/PPS-002-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`
- [`PPS-009` — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres](info/PPS-009-postgres-performance-specialist.md) `_(postgres-performance-specialist, info)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `tenancy-residency`. Duplicate of `DRS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:59`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
