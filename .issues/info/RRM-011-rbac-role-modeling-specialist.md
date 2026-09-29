---
ID: "RRM-011"
Title: "Seed-admin path (BEH-EA-206) is absent — cli is a placeholder"
Level: info
Category: "dx"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:10"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-011 — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder

`INFO` · `dx` · `cli` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

BEH-EA-206 requires 'seed admin' to create or promote one account through the same Users/Roles domain services, never raw SQL, and to refuse when an administrative account already exists unless forced; BEH-EA-208 requires every command to read Auth.make's manifest without running the application. None of it exists: packages/cli is an honest export-{} placeholder, and no default 'admin' role name is even defined for the roles catalog. The spec design is sound from a modeling standpoint — routing seeding through typed services inherits password hashing, uniqueness, and role-graph validation, and gating on Roles being installed correctly derives 'admin' from BEH-EA-137 — but it is entirely unimplemented and untested.

## Evidence

Source: `packages/cli/src/index.ts:10`

```
export {};
```

## Recommended fix

When implementing cli.ts, model seed admin as Users.create + Roles.assign with a typed AdminExists error refusable by --force, and add contract tests asserting the refuse-unless-forced invariant and the Roles-required dependency.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-003` — CLI is an empty placeholder — no schema/migration tooling exists](high/BE-003-bereket-engida.md) `_(bereket-engida, high)_`
- [`CTA-001` — CLI package has zero auth surface and its planned command set contains no login command](high/CTA-001-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-002` — CLI package is an empty placeholder — no login flow exists to consume a future device flow](high/DAG-002-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ELC-008` — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder](info/ELC-008-effect-layer-context-architect.md) `_(effect-layer-context-architect, info)_`
- [`ERS-008` — CLI package is an empty placeholder: no runtime-adjacent tooling exists](info/ERS-008-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, info)_`
- [`FAMS-010` — No bulk user-import tooling; the planned CLI import command is unimplemented](medium/FAMS-010-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`MW-006` — Operational CLI is an empty stub; migrations apply only in-process at app startup](medium/MW-006-matias-woloski.md) `_(matias-woloski, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-manifest-tooling`. Duplicate of `BE-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BE-003-bereket-engida` — closed by its fix (see that issue's Resolved comment).
