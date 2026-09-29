---
ID: "PPS-009"
Title: "jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres"
Level: info
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:155"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-009 — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres

`INFO` · `architecture` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **resolved**

## Summary

A grep for jsonb/JSONB across packages, spec, and features finds nothing; verification_tokens.payload and organization metadata columns are plain TEXT with JSON serialized by the app (Models.ts uses fromJsonString). For opaque, app-validated payloads this is a defensible dual-dialect choice (SQLite has no jsonb), and it keeps the single-DDL-per-migration pattern via onDialectOrElse honest. The cost is Postgres-specific: no GIN indexing, no DB-side JSON validation, and no in-place partial updates if any future feature needs to query payload contents. Recorded as an informed absence, not a defect.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:155`

```
payload TEXT NOT NULL
```

## Recommended fix

If any payload ever needs server-side querying (e.g. two-factor metadata), add a pg branch storing JSONB with a GIN index while keeping the SQLite TEXT branch; otherwise document TEXT-as-canonical as a deliberate decision in ADR form so it is not rediscovered as a bug later.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Postgres performance
- Full dossier: [`postgres-performance-specialist`](../../.reports/postgres-performance-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-010` — No retention policy or mechanism exists for any audit data](low/ALF-010-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CSG-009` — No residency, region, or subprocessor hooks; data location is undocumented deployer choice](info/CSG-009-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, info)_`
- [`DRS-001` — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change](high/DRS-001-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`PPS-002` — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set](medium/PPS-002-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-docs-operations`. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:155`. Fix: Record 'opaque JSON is TEXT on every dialect' as a deliberate decision. Plan no jsonb migration until a server-side query need exists. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ADR-EA-004 revision 1.1 Consequences record 'opaque JSON is TEXT on every dialect' (verification_tokens.payload, auth_audit_log.payload, users.metadata, organization metadata) with the JSONB-when-queried trigger; README Schema conventions links it. spec:verify:strict passes.
