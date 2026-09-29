---
ID: "TS-008"
Title: "Role assignments are never validated against the policy catalog; drift is silent"
Level: low
Category: "security"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:133"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-008 — Role assignments are never validated against the policy catalog; drift is silent

`LOW` · `security` · `roles` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **resolved**

## Summary

assign() accepts any roleName string without checking the qadi role catalog, and resolution silently drops names with no catalog entry. Directionally fail-closed (an unknown role grants nothing, and the default empty catalog denies everything), which is the right bias — but the data/policy join has no observability: a typo'd assignment ("admn") or a role renamed in the catalog produces users who silently hold nothing, with no assign-time error, no resolution-time log, and an admin UI (none exists) that would still list the assignment as held. In a policy-as-code posture this is the data-plane analogue of an unvalidated policy reference: errors surface as unexplained denials far from their cause.

## Evidence

Source: `packages/roles/src/Roles.ts:133`

```
const matched = names.flatMap((name) => {
  const found = catalog.get(name);
  return found === undefined ? [] : [found];
});
```

## Recommended fix

Validate roleName against the catalog at assign() and fail (or log a warning) on unknown names; on the resolution side, surface dropped unknown names on the decision trace once TS-003's sink exists.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Authorization architecture
- Full dossier: [`torin-sandall`](../../.reports/torin-sandall/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-006` — Global role assignments are memory-only; better-auth's user.role column has no durable home](high/BAM-006-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`MTI-007` — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models](medium/MTI-007-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- [`PCS-003` — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke](medium/PCS-003-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`RRM-003` — Assigned role names absent from the catalog are silently dropped](medium/RRM-003-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-004` — Duplicate catalog role names silently collapse, last wins](low/RRM-004-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`RRM-005` — Roles.assign/revoke emit no audit events and take no authorization gate](medium/RRM-005-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `roles-catalog-validation`. Duplicate of `RRM-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:41`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `RRM-003-rbac-role-modeling-specialist` — closed by its fix (see that issue's Resolved comment).
