---
ID: "YL-009"
Title: "Roles plugin exposes no management API surface for administration"
Level: info
Category: "dx"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:85"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-009 — Roles plugin exposes no management API surface for administration

`INFO` · `dx` · `roles` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **resolved**

## Summary

The roles catalog is static Layer config (Roles.config(catalog)) and assign/revoke/listRoleNames exist only as service methods; there is no HTTP contract, no admin endpoint, and (with the cli package an export-{} placeholder) no CLI to manage assignments. Every grant or revoke must be written in application code, so the RBAC plane is a library primitive rather than an operable subsystem — a deliberate roadmap deferral, but it caps the authorization story's completeness and pushes every integrator to invent their own role-admin endpoints.

## Evidence

Source: `packages/roles/src/Roles.ts:85`

```
  // BEH-EA-018/roadmap M3: no HTTP contract of its own — this plugin's whole
  // job is the `SubjectResolver` override, per this module's own header
```

## Recommended fix

When the admin plane lands, add an AuthApi group for role assignment CRUD guarded by hasRole('admin')-style policies through the same SubjectResolver, so the plugin's own administration dogfoods the enforcement path it currently never exercises.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `roles-audit-and-admin`. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:211`. Fix: Ship an opt-in RolesAdmin plugin (pending decision) whose endpoints are guarded by qadi Path B, dogfooding enforcement. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option 2 per plan; user may revisit. New opt-in RolesAdmin plugin in @awthaq/roles (id rolesAdmin, dependsOn Roles, no tables): GET /roles/catalog, GET /roles/users/:userId, POST /roles/users/:userId/assignments, DELETE /roles/users/:userId/assignments/:roleName; UnknownRole -> 422. Guarded by qadi Path B (RequirePermission + RequiredPermission annotations on every endpoint, roles:read to look, roles:manage to change, manage implies read; the app grants them through its own Roles catalog); CsrfProtection outermost. The actor on auth.roles.assigned/revoked is derived from CurrentSubject ('user:<id>'), never the client. Roles stays contract-less (Auth.make([Roles]) unchanged; Auth.make([Roles, RolesAdmin]) composes, tested). This is the repo's first real RequirePermission consumer (test uses RequirePermissionLive + SubjectExtractorLive + EvaluationServicesNone; AuthorizationAudit.auditAuthorizationAnnotations passes on the contract). Tests: packages/roles/test/RolesAdmin.test.ts (anonymous and plain subject 403, read-only 403 on change, admin assigns/revokes with the acting admin in the audit trail, 422, missing CSRF rejected first). Adds @qadi/http, @awthaq/server (dev), @effect/platform-node (dev) to packages/roles/package.json so pnpm-lock.yaml changed. Gates: tsc -b clean apart from packages/react, tsconfig.test clean, packages/roles 27 tests green.
