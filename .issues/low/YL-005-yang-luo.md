---
ID: "YL-005"
Title: "Assigned role names missing from the catalog are dropped silently"
Level: low
Category: "correctness"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:132"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-005 — Assigned role names missing from the catalog are dropped silently

`LOW` · `correctness` · `roles` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **resolved**

## Summary

assign('edtor') (typo) or assign of a role removed from the catalog is accepted and stored, then yields nothing at resolution time — the subject just lacks the permissions, with no error, event, or log at either assign or resolve. Fail-closed, but it makes catalog drift invisible: a renamed role turns every existing assignment into a no-op across the fleet. Casbin surfaces unknown policy loading errors loudly; here the mismatch is structurally unobservable.

## Evidence

Source: `packages/roles/src/Roles.ts:132`

```
            const matched = names.flatMap((name) => {
              const found = catalog.get(name);
              return found === undefined ? [] : [found];
```

## Recommended fix

Make assign validate against the catalog and fail with a typed error (or log a warning on resolve-time misses), and add a listUnassigned operation or startup check that reports stored names absent from the configured catalog.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Authorization modeling
- Full dossier: [`yang-luo`](../../.reports/yang-luo/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `roles-catalog-validation`. Duplicate of `RRM-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:194`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
