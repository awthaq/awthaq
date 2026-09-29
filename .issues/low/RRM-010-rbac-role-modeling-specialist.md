---
ID: "RRM-010"
Title: "Empty default catalog silently disables the roles plugin"
Level: low
Category: "dx"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:47"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-010 — Empty default catalog silently disables the roles plugin

`LOW` · `dx` · `roles` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

RolesConfig is a Context.Reference with a defaultValue of an empty catalog, so an application that composes Roles.layer but forgets Roles.config([...]) gets a fully 'working' plugin whose subjects always resolve zero roles and zero permissions — every permission-gated policy denies with no error, warning, or manifest signal. This is the fail-closed default of BEH-EA-017 working as designed for the slot, but for this specific reference the empty set is a plausible misconfiguration rather than a meaningful default.

## Evidence

Source: `packages/roles/src/Roles.ts:47`

```
  { defaultValue: (): RolesConfigShape => ({ catalog: [] }) },
```

## Recommended fix

Keep the type-legal default but log a warning (or fail) at layer build when the catalog is empty, and surface catalog size in the plugin manifest so doctor-style tooling (BEH-EA-201) can flag it.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-006` — Global role assignments are memory-only; better-auth's user.role column has no durable home](high/BAM-006-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`MTI-007` — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models](medium/MTI-007-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- [`PCS-003` — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke](medium/PCS-003-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`RRM-003` — Assigned role names absent from the catalog are silently dropped](medium/RRM-003-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-004` — Duplicate catalog role names silently collapse, last wins](low/RRM-004-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`RRM-005` — Roles.assign/revoke emit no audit events and take no authorization gate](medium/RRM-005-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `roles-catalog-validation`. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:51`. Fix: Keep the fail-closed default but make the misconfiguration loud. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Building Roles.layer/layerSql with an empty catalog logs awthaq.roles.emptyCatalog once at build (fail-closed default unchanged); RolesConfig doc comment says Roles.config([...]) is required for any effect. Tests: Roles.test.ts 'building Roles.layer without any catalog logs awthaq.roles.emptyCatalog' and 'a configured catalog does not log ...'. README content is part of the authz-docs-truthfulness rewrite. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 923 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
