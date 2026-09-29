---
ID: "SSMS-005"
Title: "No shipped wiring ever runs coreMigrations"
Level: medium
Category: "dx"
Status: resolved
Package: "sql"
Source: "packages/sql/src/index.ts:10"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-005 — No shipped wiring ever runs coreMigrations

`MEDIUM` · `dx` · `sql` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

coreMigrations is only ever executed by the two test suites (packages/sql/test/Repositories.test.ts:34, Repositories.postgres.test.ts:67); CoreMigrations.ts:49 merely documents that it is 'ready to pass straight to Migrator.make'. No server, example, or CLI layer composes Migrator.make with coreMigrations (plus Auth.make's renumbered plugin migrations), so a deployer assembling @awthaq from packages must hand-wire migration application or ship an empty database. The schema and its records exist; the deployment entry point that makes them load-bearing does not.

## Evidence

Source: `packages/sql/src/index.ts:10`

```
// Planned next: migration records/linker input (BEH-EA-037/038).
```

## Recommended fix

Land BEH-EA-037/038: a shipped layer (or CLI verb) that runs one Migrator.make call over coreMigrations concatenated with Auth.make(...).migrations, so migration application is a property of the framework rather than of each consumer's main.ts.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `migration-wiring`. Duplicate of `BE-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/index.ts:10`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
