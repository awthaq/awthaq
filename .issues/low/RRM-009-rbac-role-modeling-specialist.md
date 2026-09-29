---
ID: "RRM-009"
Title: "Roles docs and metrics still claim the package is an empty placeholder"
Level: low
Category: "docs"
Status: resolved
Package: "roles"
Source: "packages/roles/README.md:3"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-009 — Roles docs and metrics still claim the package is an empty placeholder

`LOW` · `docs` · `roles` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

Roles.ts (147 lines) implements BEH-EA-138/139/142/143 and ships a real layer, but the README says no source has shipped, the spec banner at spec/behaviors/18-roles-subject-resolver.md:15 repeats 'No code implementing it exists yet', and .quality-metrics/roles.json plus .quality-metrics/qadi.json report totalLoc 9 and 'only export {}' for packages that now hold ~450 source lines across real modules. Operators and future auditors reading any of these will wrongly conclude the RBAC surface is unbuilt.

## Evidence

Source: `packages/roles/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

## Recommended fix

Refresh the roles README, the spec file banner, and regenerate the roles/qadi quality-metrics JSON so documentation reflects the implemented SubjectResolver/bridge surface.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DTWS-002` — 20 of 21 package READMEs claim 'no line of source in this package has shipped yet' while shipping real source](high/DTWS-002-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-docs-truthfulness`. Evidence at HEAD ec065a7: `spec/behaviors/18-roles-subject-resolver.md:15`. Fix: Refresh the roles/qadi spec banner and quality metrics (README handled by DTWS-002). (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/behaviors/18-roles-subject-resolver.md: banner replaced by an implemented-with-deviations status (BEH-EA-138 enforcement point; BEH-EA-140/141 not implemented), revision 1.2; packages/roles and packages/qadi READMEs rewritten (DTWS-002). .quality-metrics/roles.json and qadi.json are NOT tracked (the directory is gitignored and generated locally), so there is nothing to commit — a local `pnpm quality:dashboard` metrics run regenerates them. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, tests/bdd green apart from load-induced timeouts in password/ports (machine load average ~170 from parallel agents; each green in isolation), spec:verify:strict PASS, oxlint clean.
