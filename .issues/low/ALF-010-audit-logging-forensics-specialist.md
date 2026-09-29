---
ID: "ALF-010"
Title: "No retention policy or mechanism exists for any audit data"
Level: low
Category: "compliance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:58"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-010 — No retention policy or mechanism exists for any audit data

`LOW` · `compliance` · `sql` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

The sql package's entire migration set is five operational tables (users, accounts, sessions, verification_tokens, verification_reservations, CoreMigrations.ts:58-192) — no audit table and no retention machinery; a repo-wide search finds no prune/purge/retention code in any package. The bus keeps events for the process lifetime only, while admin_impersonation rows (with admin-authored reasons and, via invitations, emails) persist forever with no expiry or purge path. This is double-edged for forensics: unbounded retention of impersonation narratives is its own liability, and there is no queryable time-range API over history, so even the data that is retained cannot be efficiently reconstructed under a legal-hold or investigation window.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:58`

```
      pg: () => sql`
        CREATE TABLE users (
```

## Recommended fix

Define retention per event class in the spec (e.g. impersonation records ≥1 year, sign-in telemetry 90 days), implement a scoped sweep in the ALF-001 AuditLog layer, and expose list-by-time-range/purge operations so operators can both investigate and defensibly delete.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-009` — No residency, region, or subprocessor hooks; data location is undocumented deployer choice](info/CSG-009-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, info)_`
- [`DRS-001` — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change](high/DRS-001-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`PPS-002` — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set](medium/PPS-002-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`
- [`PPS-009` — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres](info/PPS-009-postgres-performance-specialist.md) `_(postgres-performance-specialist, info)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `retention-sweeps`. Already fixed by commit 6bd3f1d. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:303`. Fix: Extend ticket 30's `Retention` service (CSG-003) with per-event-class audit retention. The default is retain-forever (forensics-safe), and operators opt in to purge windows. Add the missing occurredAt index. (effort M). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Per-event-class audit retention, default retain-forever (ADR-EA-031, ADR-EA-029). RetentionConfig.auditLog = { default: Option<Duration> (none), rules: [{ tags, keepFor }] } (a rules array instead of the dossier's byEventTag record, so several tags can share a window and no string-keyed cast is needed); Retention.sweep issues one AuditLog.purge per rule and one for the default over every tag no rule names. AuditLog.purge({ before, eventTags?, exceptTags? }) in both layers (SQL: AuditLogRepository.deleteOccurredBefore, bounded batches). Core migration 26 adds the missing auth_audit_log occurredAt index (IF NOT EXISTS), serving list ranges and the sweep; the CoreMigrations/Migrations tests no longer hard-code the migration count. Tests: Retention.test.ts ('kept for ever unless a window is configured', per-tag window, default with exceptions) and the sql contract case. admin_impersonation is deliberately NOT given a retention contribution: purging ended rows would break its hash chain (ADR-EA-031). Note for merge: the migration id (26) may need renumbering after other programs' migrations.
