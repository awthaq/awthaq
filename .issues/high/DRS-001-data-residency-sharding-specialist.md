---
ID: "DRS-001"
Title: "No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:59"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-001 — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change

`HIGH` · `architecture` · `sql` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **ready-for-agent**

## Summary

All five core tables (users :59, accounts :82, sessions :115, verification_tokens :148, verification_reservations :184) declare no organizationId, tenantId, or region column — the only ownership edge anywhere is accounts.userId/sessions.userId, and verification rows carry the userId only as free text inside identifier (e.g. 'verify-email:<userId>', packages/core/src/Verification.ts:71). A residency requirement of the form 'this tenant's or region's rows must live in region X' has no column to partition or predicate on, and no index to prune with. The org plugin's tables do carry organizationId, but core user data — the bulk of regulated PII — is structurally unattributable.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:59`

```
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
```

## Recommended fix

Introduce an explicit, indexed tenancy column (tenantId or homeRegion) on every user-data table as a forward-only migration before the first residency customer, sourced at write time from the issuing context. Even a nullable default-'' column establishes the partition key contract; retrofitting it after scale is a table rewrite.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-010` — No retention policy or mechanism exists for any audit data](low/ALF-010-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CSG-009` — No residency, region, or subprocessor hooks; data location is undocumented deployer choice](info/CSG-009-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, info)_`
- [`PPS-002` — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set](medium/PPS-002-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`
- [`PPS-009` — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres](info/PPS-009-postgres-performance-specialist.md) `_(postgres-performance-specialist, info)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/sql/src/CoreMigrations.ts:59` (pg `CREATE TABLE users (`) matches the quoted evidence exactly, and a grep for `organizationId`/`tenantId`/`region` across the file returns zero hits. All five core tables lack any tenancy column. Choosing the tenancy model (column name, population strategy, indexing) is a schema-design decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Multi-tenant composition model, per-org OAuth connections & tenant/shard key schema](../../.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md) — Resolved via an opaque, ambient `tenantId` column (indexed, nullable, `Context.Reference`-populated, zero-cost when unused) on all five core tables, plus optional Postgres RLS policies as structural defense-in-depth beneath the application-level stamping. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `tenancy-residency`. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:58`. Fix: Implement ticket 18's decision: an opaque, nullable, indexed tenant column on every core table, stamped from an ambient `TenantContext` Context.Reference (default `Option.none()`, zero-cost for single-tenant), with optional Postgres RLS policies underneath. (effort XL). Full dossier: `.plan/slices/05-sql.md`.
