---
ID: "ERS-008"
Title: "CLI package is an empty placeholder: no runtime-adjacent tooling exists"
Level: info
Category: "dx"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:8"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-008 — CLI package is an empty placeholder: no runtime-adjacent tooling exists

`INFO` · `dx` · `cli` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **resolved**

## Summary

The package header promises doctor, plugin list --graph, routes, migration status/apply, openapi, seed admin, and import (line 3), but the package exports nothing. From the runtime lens this means no operational surface exists to inspect a composed layer graph, dry-run migration apply, or verify configuration before Layer.launch — the tooling an operator would use alongside the single runtime root in examples/memory-server. Honest absence, tracked here so the audit dashboard does not infer CLI runtime behavior.

## Evidence

Source: `packages/cli/src/index.ts:8`

```
Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

When cli.ts lands, ground the doctor command in the same Layer composition the example uses (build to a scope, report unprovided ports and Config errors) so runtime diagnosis never forks from the real construction path.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-003` — CLI is an empty placeholder — no schema/migration tooling exists](high/BE-003-bereket-engida.md) `_(bereket-engida, high)_`
- [`CTA-001` — CLI package has zero auth surface and its planned command set contains no login command](high/CTA-001-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-002` — CLI package is an empty placeholder — no login flow exists to consume a future device flow](high/DAG-002-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ELC-008` — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder](info/ELC-008-effect-layer-context-architect.md) `_(effect-layer-context-architect, info)_`
- [`FAMS-010` — No bulk user-import tooling; the planned CLI import command is unimplemented](medium/FAMS-010-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`MW-006` — Operational CLI is an empty stub; migrations apply only in-process at app startup](medium/MW-006-matias-woloski.md) `_(matias-woloski, medium)_`
- [`RRM-011` — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder](info/RRM-011-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-manifest-tooling`. Duplicate of `BE-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
