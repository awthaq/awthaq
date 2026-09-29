---
ID: "MW-006"
Title: "Operational CLI is an empty stub; migrations apply only in-process at app startup"
Level: medium
Category: "dx"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:8"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-006 — Operational CLI is an empty stub; migrations apply only in-process at app startup

`MEDIUM` · `dx` · `cli` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **resolved**

## Summary

The CLI's own header promises doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — all absent. Concretely, schema changes reach production only via Migrator.make inside the application's Layer (README.md:76-78 quickstart pattern), which couples migration execution to app deploy, gives SREs no way to inspect pending/failed migrations, and makes the migration tracking table observable only by SQL by hand. At operating scale this is the difference between a managed rollout and a startup-crash loop on a bad migration.

## Evidence

Source: `packages/cli/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Ship a minimal `awthaq migrations status|apply` and `awthaq routes` first (both read from Auth.make's built.migrations/manifest, no application import needed beyond the DB url), keeping the programmatic path as the default.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-003` — CLI is an empty placeholder — no schema/migration tooling exists](high/BE-003-bereket-engida.md) `_(bereket-engida, high)_`
- [`CTA-001` — CLI package has zero auth surface and its planned command set contains no login command](high/CTA-001-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-002` — CLI package is an empty placeholder — no login flow exists to consume a future device flow](high/DAG-002-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ELC-008` — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder](info/ELC-008-effect-layer-context-architect.md) `_(effect-layer-context-architect, info)_`
- [`ERS-008` — CLI package is an empty placeholder: no runtime-adjacent tooling exists](info/ERS-008-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, info)_`
- [`FAMS-010` — No bulk user-import tooling; the planned CLI import command is unimplemented](medium/FAMS-010-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`RRM-011` — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder](info/RRM-011-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-manifest-tooling`. Duplicate of `BE-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
