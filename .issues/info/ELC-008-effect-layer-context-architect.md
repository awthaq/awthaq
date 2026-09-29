---
ID: "ELC-008"
Title: "Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder"
Level: info
Category: "dx"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:8"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-008 — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder

`INFO` · `dx` · `cli` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **resolved**

## Summary

The package header promises `plugin list --graph` — exactly the Layer-graph visualization this architecture needs as it grows past seven plugins — but nothing consumes the manifest Auth.make already produces (buildManifest emits id/apiVersion/tables/dependsOn per plugin, Auth.ts:351-358). The dependency graph is currently legible only by reading Validate<P> types and source comments; there is no static artifact an operator or reviewer can diff as plugins are added.

## Evidence

Source: `packages/cli/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

When M6 lands, make the first cli module read Auth.make's manifest (no runtime needed) and render the dependsOn graph, so composition drift shows up in review before it shows up at boot.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-003` — CLI is an empty placeholder — no schema/migration tooling exists](high/BE-003-bereket-engida.md) `_(bereket-engida, high)_`
- [`CTA-001` — CLI package has zero auth surface and its planned command set contains no login command](high/CTA-001-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-002` — CLI package is an empty placeholder — no login flow exists to consume a future device flow](high/DAG-002-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ERS-008` — CLI package is an empty placeholder: no runtime-adjacent tooling exists](info/ERS-008-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, info)_`
- [`FAMS-010` — No bulk user-import tooling; the planned CLI import command is unimplemented](medium/FAMS-010-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`MW-006` — Operational CLI is an empty stub; migrations apply only in-process at app startup](medium/MW-006-matias-woloski.md) `_(matias-woloski, medium)_`
- [`RRM-011` — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder](info/RRM-011-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-manifest-tooling`. Duplicate of `BE-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
