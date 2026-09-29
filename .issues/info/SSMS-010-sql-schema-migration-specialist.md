---
ID: "SSMS-010"
Title: "Stale quality metrics describe packages/sql as a 9-line placeholder"
Level: info
Category: "docs"
Status: resolved
Package: "—"
Source: ".quality-metrics/sql.json:42"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-010 — Stale quality metrics describe packages/sql as a 9-line placeholder

`INFO` · `docs` · `—` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

The per-package metric JSON for packages/sql reports fileCount 1, totalLoc 9, and names index.ts's placeholder era ('Placeholder keeps the module a valid ES module', line 73) - but the package is now three source files totalling 1103 lines plus two substantial test suites. Any dashboard or trend generated from .quality-metrics will materially misrepresent the schema/migration domain's size, test ratio, and Effect-idiom usage.

## Evidence

Source: `.quality-metrics/sql.json:42`

```
"fileCount": 1,
      "totalLoc": 9,
```

## Recommended fix

Regenerate .quality-metrics/sql.json from the current tree and add a CI staleness guard (e.g., fail when fileCount disagrees with a glob of src/*.ts).

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `quality-metrics-regeneration`. Duplicate of `DESS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `.quality-metrics/sql.json:42`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
