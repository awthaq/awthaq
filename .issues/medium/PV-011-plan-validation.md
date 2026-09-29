---
ID: "PV-011"
Title: "coreMigrations (ids 1-17) and index-numbered plugin migrations share effect_sql_migrations — running them separately silently skips plugin migrations"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Migrations.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-011 — coreMigrations (ids 1-17) and index-numbered plugin migrations share effect_sql_migrations — running them separately silently skips plugin migrations

`MEDIUM` · `correctness` · `sql` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

coreMigrations (ids 1-17) and index-numbered plugin migrations share effect_sql_migrations — running them separately silently skips plugin migrations. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N11).

## Evidence

Source: `packages/sql/src/Migrations.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: SSMS-005 → BE-003 / cli-manifest-tooling (P17).

## Comments

_Triage notes and discussion append here._
