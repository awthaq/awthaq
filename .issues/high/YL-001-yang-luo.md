---
ID: "YL-001"
Title: "Role assignments are memory-only, breaking the repo's own storage-adapter convention"
Level: high
Category: "architecture"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:56"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-001 — Role assignments are memory-only, breaking the repo's own storage-adapter convention

`HIGH` · `architecture` · `roles` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **resolved**

## Summary

Every other record type in the monorepo ships a layerMemory/layerSql pair over one Shape (Users.ts, Accounts.ts, Sessions.ts, Verification.ts, and all six organization record types), but the RBAC plugin's only state is an in-process Ref; its own header admits it: SQL persistence for role assignments is deferred. In any multi-instance deployment, assign on node A is invisible to node B, and every restart silently revokes every role — authorization state that does not survive a deploy is a major gap for an auth runtime, even though the deferral is honestly documented (Roles.ts:15-19).

## Evidence

Source: `packages/roles/src/Roles.ts:56`

```
const state = yield* Ref.make(HashMap.empty<Users.UserId, ReadonlyArray<string>>());
```

## Recommended fix

Add Roles.layerSql over a role_assignments table (userId, roleName, unique pair) following the exact Users.layerSql template; keep the Shape unchanged so applications swap layers, not call sites, and add the reservation/uniqueness design the header already scopes.

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

**Validation (2026-09-19):** CONFIRMED — `packages/roles/src/Roles.ts:56` matches the evidence exactly; grep for `layerSql`/`layerMemory` exports in the file finds none — only one `Ref`-backed implementation exists, exposed via the `Roles` `AuthPlugin.Service`, exactly as the header comment (`Roles.ts:15-19`) admits. `Users.layerSql` provides a directly reusable template. Mechanical, well-scoped addition. Status → ready-for-agent.

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 1331cd5. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:249`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
