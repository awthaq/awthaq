---
ID: "RRM-006"
Title: "Three disjoint role/permission models with no bridge between them"
Level: medium
Category: "architecture"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:56"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-006 — Three disjoint role/permission models with no bridge between them

`MEDIUM` · `architecture` · `roles` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

The system now carries three authorization vocabularies: @awthaq/roles' global user-to-roleNames store flattened through @qadi/core's role DAG, the organization plugin's per-org statement engine (PermissionEngine.Statements, resource-to-actions with owner/admin/member), and qadi policies proper. They do not compose: the roles resolver reads only its own global store (Roles.ts:131), so an organization owner holds zero qadi roles/permissions unless separately assigned globally, while OrganizationQadi answers org questions solely as relationship checks and subject-scoped attribute counts (OrganizationQadi.ts:23-35). The persona's boundary rule — role identity decoupled from permission evaluation — is met inside each model, but the seam between them is undocumented and will produce 'why does my org admin get denied' confusion.

## Evidence

Source: `packages/roles/src/Roles.ts:56`

```
const state = yield* Ref.make(HashMap.empty<Users.UserId, ReadonlyArray<string>>());
```

## Recommended fix

Document the intended split (global roles for app-level permissions, org statements for tenant mutations, qadi policies for attribute logic) in the roles package README, and consider an opt-in resolver composition that merges org membership roles into the subject's attributes for policy authoring.

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
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `authz-model-boundaries`. Duplicate of `MTI-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:191`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
