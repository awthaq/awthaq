---
ID: "CSG-009"
Title: "No residency, region, or subprocessor hooks; data location is undocumented deployer choice"
Level: info
Category: "architecture"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:224"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-009 — No residency, region, or subprocessor hooks; data location is undocumented deployer choice

`INFO` · `architecture` · `sql` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **ready-for-agent**

## Summary

The only locality abstraction in the persistence stratum is SQL dialect (pg/sqlite) inside migrations; there are no region, partition, or tenant-placement hooks anywhere in packages/ (a repo-wide grep for residency/region returns documentation hits only). Storage location is entirely the deployer's choice via the injected SqlClient, which is a defensible headless-framework stance, but it is nowhere stated, and research/00-questions.md:74 still lists 'deletion cascades (GDPR erasure)' as an open question. A residency requirement (e.g. EU data localization) would need per-tenant SqlClient routing that today's single-client repository signatures do not anticipate.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:224`

```
      pg: () => sql`CREATE INDEX accounts_user_id ON accounts("userId")`,
```

## Recommended fix

State the data-location model explicitly in spec/overview.md (deployer-controlled via SqlClient), and if multi-region is roadmap-worthy, plan it as a SqlClient-routing seam rather than per-table logic.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-010` — No retention policy or mechanism exists for any audit data](low/ALF-010-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`DRS-001` — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change](high/DRS-001-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`PPS-002` — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set](medium/PPS-002-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`
- [`PPS-009` — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres](info/PPS-009-postgres-performance-specialist.md) `_(postgres-performance-specialist, info)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `tenancy-residency`. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:222`. Fix: Document the data-location model. Point multi-region at the seams that exist or are decided: the injected SqlClient, DRS-001's tenant column, and ADR-EA-005's `LayerMap.Service` for per-tenant/per-region SqlClient routing. Don't add per-table logic. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
