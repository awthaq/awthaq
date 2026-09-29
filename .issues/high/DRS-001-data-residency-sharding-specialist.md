---
ID: "DRS-001"
Title: "No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change"
Level: high
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:59"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-001 — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change

`HIGH` · `architecture` · `sql` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **resolved**

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

**Resolved (2026-09-29):** Tenant attribution column, ambient TenantContext and opt-in Postgres RLS (ADR-EA-018, BEH-EA-230..233 - NOTE for the orchestrator: BEH-EA-230..237, ADR-EA-018 and core migration ids 24-25 may collide with concurrent programs; renumber at integration). Landed: @awthaq/ports Tenant.ts (TenantContext Context.Reference<Option<string>> default none, withTenant/withoutTenant), re-exported by @awthaq/core Tenant.ts (ports, not core, because @awthaq/sql sits below core and its repositories are the stamping choke point); core migrations 24 (nullable "tenantId" TEXT on users/accounts/sessions/verification_tokens/verification_reservations/auth_audit_log) and 25 (indexes: ("tenantId","userId") on sessions and verification_tokens, "tenantId" on the rest); Models tenantIdField (select+insert only, no JSON and no update variant); every repository insert path stamps input.tenantId ?? ambient ?? NULL (Users insert/insertIfAbsent, Accounts, Sessions, Verification insert/upsertLive, VerificationReservations.claim, AuditLog.insert); UserRecord.tenantId and SessionView.tenantId (memory twins stamp too); TenantScope.enableRls/disableRls (idempotent, FORCE, fail-open when no tenant set, opt-in includeDirectory) and TenantScope.withTenant (set_config transaction-local on Postgres, ambient-only on SQLite). Deviations recorded in the ADR: "tenantId" not tenant_id (schema is quoted camelCase); RLS as idempotent functions not numbered migrations (the core ledger is forward-only); makeModels now has an explicit return type because the six-entity union exceeded TS7056. Tests: sql contract "every insert path stamps the ambient tenantId, NULL when none" (SQLite, file, real Postgres), Postgres RLS suite (cross-tenant read/update/forged insert denied inside withTenant as a non-owner role, fail-open without a tenant), core Users/Sessions tenant cases (memory + SQL). Gates: typecheck, full test 1926 passed, test:bdd, spec:verify:strict, Postgres 16 run of the pg suites.
