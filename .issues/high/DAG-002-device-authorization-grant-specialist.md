---
ID: "DAG-002"
Title: "CLI package is an empty placeholder — no login flow exists to consume a future device flow"
Level: high
Category: "dx"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:10"
Auditor: "device-authorization-grant-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DAG-002 — CLI package is an empty placeholder — no login flow exists to consume a future device flow

`HIGH` · `dx` · `cli` · reported by **Device Authorization Grant Specialist** (`device-authorization-grant-specialist`)

Status: **resolved**

## Summary

The persona premise treats packages/cli as the input-constrained client the device flow targets, but the package exports nothing (line 8: 'Empty placeholder — awthaq is pre-implementation. No exported symbols yet.'). Its declared command set (doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import) contains no login command, so there is no CLI authentication UX at all today — a user cannot sign in from a terminal by any method, device flow or otherwise.

## Evidence

Source: `packages/cli/src/index.ts:10`

```
export {};
```

## Recommended fix

Treat 'awthaq login' as a distinct requirement from the manifest-inspection CLI: decide now whether it lives in @awthaq/cli behind a documented boundary exception (see DAG-003) or in @awthaq/client, and record the decision in the model doc so Phase 3 does not inherit an unexamined conflict.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 34/100), domain: Device Authorization Grant
- Full dossier: [`device-authorization-grant-specialist`](../../.reports/device-authorization-grant-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-003` — CLI is an empty placeholder — no schema/migration tooling exists](high/BE-003-bereket-engida.md) `_(bereket-engida, high)_`
- [`CTA-001` — CLI package has zero auth surface and its planned command set contains no login command](high/CTA-001-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`ELC-008` — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder](info/ELC-008-effect-layer-context-architect.md) `_(effect-layer-context-architect, info)_`
- [`ERS-008` — CLI package is an empty placeholder: no runtime-adjacent tooling exists](info/ERS-008-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, info)_`
- [`FAMS-010` — No bulk user-import tooling; the planned CLI import command is unimplemented](medium/FAMS-010-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`MW-006` — Operational CLI is an empty stub; migrations apply only in-process at app startup](medium/MW-006-matias-woloski.md) `_(matias-woloski, medium)_`
- [`RRM-011` — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder](info/RRM-011-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/cli/src/index.ts:10` is exactly `export {};`, the file's only statement, and the CLI's planned command set (line 3) has no login command. Same underlying gap as CTA-001; deciding where CLI login lives is a product/architecture decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [CLI login flow design vs. the BEH-EA-208 network-boundary prohibition](../../.scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md) — `login`/`logout`/`whoami` land in `@awthaq/cli` itself, with a `CredentialStore` port (OS keychain, encrypted-file fallback) for local token storage; the device-flow path now has a documented consumer, gated on the `DeviceAuthorization` plugin shipping. Status → ready-for-agent.

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-session-commands`. Duplicate of `CTA-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
