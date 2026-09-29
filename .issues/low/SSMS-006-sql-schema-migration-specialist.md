---
ID: "SSMS-006"
Title: "Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations"
Level: low
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:9"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-006 — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations

`LOW` · `architecture` · `sql` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

The framework Migrator wraps the whole pending batch in one transaction (cross-checked: node_modules/effect/src/unstable/sql/Migrator.ts:308, sql.withTransaction(run)), which is excellent for atomicity on a fresh database but means any future index added to a populated users/sessions/verification_tokens table must be built with a full write lock - CREATE INDEX CONCURRENTLY cannot run inside a transaction, and there is no out-of-band escape hatch in the wiring. The codebase already anticipates the adjacent hazard honestly: the comment at CoreMigrations.ts:203-212 works through what happens when users_email_unique meets pre-existing duplicate emails. For an auth runtime whose tables grow unboundedly (sessions, verification history), the first post-GA index will be an availability event unless planned.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:9`

```
// ticket 00's survey — a forward-only runner, `effect_sql_migrations`
// tracking table by default, whole batch in one transaction).
```

## Recommended fix

Document an expand-phase runbook now: new indexes on populated tables ship out-of-band via CONCURRENTLY (with a stub no-op migration recording the step), or extend Migrator options to mark specific migrations as non-transactional.

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
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`
- [`SAM-003` — User model cannot represent anonymous or phone-only Supabase users](high/SAM-003-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-docs-operations`. Evidence at HEAD ec065a7: `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/sql/Migrator.ts:308`. Fix: Document an expand-phase runbook and adopt `IF NOT EXISTS` for every new index migration, so an operator can pre-build with CONCURRENTLY out of band and the recorded migration becomes a no-op. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Every CREATE [UNIQUE] INDEX in CoreMigrations is now IF NOT EXISTS with the convention documented at the top of CoreMigrations.ts; packages/sql/README.md 'Migrating a populated database' runbook (CONCURRENTLY out of band, expand/contract). Test packages/sql/test/CoreMigrations.test.ts: an index pre-created out of band does not break the recorded migration (red without IF NOT EXISTS) + a source scan that every index statement uses IF NOT EXISTS.
