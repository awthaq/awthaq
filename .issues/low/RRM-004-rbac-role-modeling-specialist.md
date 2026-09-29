---
ID: "RRM-004"
Title: "Duplicate catalog role names silently collapse, last wins"
Level: low
Category: "correctness"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:122"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-004 — Duplicate catalog role names silently collapse, last wins

`LOW` · `correctness` · `roles` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

Building the catalog lookup with new Map makes a repeated role name silently overwrite the earlier definition, so one of two disagreeing definitions of the same name wins with nothing said. @qadi/core's resolveRoleGraph treats exactly this case as a hard failure on the grounds that "silently picking one is a guess this library should not make" (Role.ts:262-267); the roles plugin re-introduces the defect its own dependency rejected.

## Evidence

Source: `packages/roles/src/Roles.ts:122`

```
const catalog = new Map(rolesConfig.catalog.map((role) => [role.name, role] as const));
```

## Recommended fix

Fail layer construction on duplicate catalog names (throw at Roles.layer build time), matching resolveRoleGraph's semantics for repeated definition names.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-006` — Global role assignments are memory-only; better-auth's user.role column has no durable home](high/BAM-006-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`MTI-007` — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models](medium/MTI-007-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- [`PCS-003` — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke](medium/PCS-003-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`RRM-003` — Assigned role names absent from the catalog are silently dropped](medium/RRM-003-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-005` — Roles.assign/revoke emit no audit events and take no authorization gate](medium/RRM-005-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `roles-catalog-validation`. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:184`. Fix: Fail Roles layer construction on duplicate catalog names by validating through qadi's own resolveRoleGraph. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Roles.ts validatedCatalog runs at layer build in both rolesMake/rolesMakeSql and subjectResolverMake: a repeated catalog role name dies at build naming the duplicates (was: silently collapsed, last wins). Implemented as an explicit duplicate check rather than through resolveRoleGraph because the catalog holds by-value Roles (no cycles possible) while resolveRoleGraph takes name-referenced definitions. Test: Roles.test.ts 'Roles.layer with two catalog entries named editor fails to build, naming editor'. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 923 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
