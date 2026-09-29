---
ID: "ESR-008"
Title: "Package README and quality-metrics JSON contradict the shipped implementation"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/README.md:3"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-008 — Package README and quality-metrics JSON contradict the shipped implementation

`MEDIUM` · `docs` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **ready-for-agent**

## Summary

The README describes `@awthaq/sql` as a planned, unimplemented package, yet the package ships 1,088 source lines (Models, Repositories, a 9-migration Migrator set) plus 877 test lines run against two real drivers. `.quality-metrics/sql.json` is equally stale — it measures `fileCount: 1, totalLoc: 9` against a placeholder `index.ts`. Any engineer, auditor, or dashboard consuming either artifact gets a false picture of the persistence stratum, the package this audit's contract calls 'schema + queries'.

## Evidence

Source: `packages/sql/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet.
```

## Recommended fix

Regenerate the README to describe the implemented Models/Repositories/CoreMigrations surface (the header comments in `index.ts` are already accurate source material), and re-run the metrics collection for the `sql` package.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 76/100), domain: SQL persistence layer
- Full dossier: [`effect-sql-repository-specialist`](../../.reports/effect-sql-repository-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-docs-operations`. Evidence at HEAD ec065a7: `packages/sql/README.md:3`. Fix: Rewrite the package README as the operations home for the persistence stratum. The docs-only findings in this slice (ERAS-006, PPS-004, PPS-009, SSMS-006, NAM-007, CSG-006, CSG-009, SAM-006) land as sections of it. Refresh or delete the stale metrics JSON. (effort M). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
