---
ID: "RRM-003"
Title: "Assigned role names absent from the catalog are silently dropped"
Level: medium
Category: "correctness"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:134"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-003 — Assigned role names absent from the catalog are silently dropped

`MEDIUM` · `correctness` · `roles` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

An assigned name that is not in the configured catalog contributes nothing, with no error at assign time and no warning at resolve time — a typo'd or renamed role grants zero permissions invisibly. The failure-safe direction is right (grant less, never more), but @qadi/core's own resolveRoleGraph explicitly fixed this exact defect class: "Dropping is right; doing it silently was not" (Role.ts:251-256, warning plus onUnknownParent hook). Roles.test.ts:49-58 instead pins the silence as correct behavior.

## Evidence

Source: `packages/roles/src/Roles.ts:134`

```
const found = catalog.get(name);
            return found === undefined ? [] : [found];
```

## Recommended fix

Validate roleName against the catalog in assign (typed UnknownRole error, mirroring BEH-EA-012-style fail-early) or emit a one-per-resolve warning like @qadi/core does; update the test to assert the signal.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-006` — Global role assignments are memory-only; better-auth's user.role column has no durable home](high/BAM-006-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`MTI-007` — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models](medium/MTI-007-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- [`PCS-003` — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke](medium/PCS-003-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`RRM-004` — Duplicate catalog role names silently collapse, last wins](low/RRM-004-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`RRM-005` — Roles.assign/revoke emit no audit events and take no authorization gate](medium/RRM-005-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `roles-catalog-validation`. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:194`. Fix: Validate assignments against the catalog at assign time and make resolve-time drift observable. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** RolesShape.assign is Effect<void, UnknownRole> (Data.TaggedError {roleName}) and rejects names absent from the catalog on both layers; subjectResolver logs awthaq.roles.unknownAssignedRole (userId, roleName) for each dropped stored name; new RolesShape.listUnknownAssignments (memory: filter; sql: role NOT IN catalog) for startup/doctor checks. The old test pinning silent ignore was rewritten. Tests: Roles.test.ts 'assign of a name outside the catalog fails UnknownRole and stores nothing'; RolesSql.test.ts 'a stored name later removed from the catalog logs a warning at resolve and is listed' + 'assign of a name outside the catalog fails UnknownRole and writes no row'. BEH-EA-139 text updated. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 923 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
