---
ID: "PV-010"
Title: "Plugin record stores use SQLite-only field types and cannot decode on Postgres (same defect as TS-001)"
Level: medium
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/{admin,jwt,organization,passkey,migrate-better-auth}"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-010 — Plugin record stores use SQLite-only field types and cannot decode on Postgres (same defect as TS-001)

`MEDIUM` · `correctness` · `sql` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

Plugin record stores use SQLite-only field types and cannot decode on Postgres (same defect as TS-001). Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N10).

## Evidence

Source: `packages/{admin,jwt,organization,passkey,migrate-better-auth}` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: TS-001-tim-smart → sql-dialect-neutral-models (P09).

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** Field types (`Models.dialectFields`/`resolveDialect`, mechanical row-schema moves) landed in the first P09 pass; on the merged tree the stores' Postgres DDL, queries and trigger bodies are identifier-quoted as well, and every plugin record-store suite (admin, jwt, organization incl. team hierarchy/roles/active context, passkey incl. user handles, roles, qadi claims, migrate-better-auth) passes on a real Postgres 16 via `pnpm run test:pg` (`TestSql.layer`; 329 tests / 18 files). See TS-001-tim-smart's follow-up for the upstream `regclass` migrator defect found on the way.

**Resolved (2026-09-29):** fixed under TS-001-tim-smart (P09: makeModels(dialect), plugin stores quoted and run on Postgres); see that issue's Resolved comment for files, tests and gates.
