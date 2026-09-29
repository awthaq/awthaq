---
ID: "RRM-005"
Title: "Roles.assign/revoke emit no audit events and take no authorization gate"
Level: medium
Category: "compliance"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:64"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-005 — Roles.assign/revoke emit no audit events and take no authorization gate

`MEDIUM` · `compliance` · `roles` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

The global role-mutation surface is two bare service methods with no caller identity, no permission check, and no AuthEvents emission; any code holding the Roles service can grant or revoke any role with no trace. Contrast the organization plugin, which publishes auth.organization.roleCreated/roleUpdated events on its equivalent mutations (Organization.ts:1661-1665, 1725-1729). For an auth runtime whose PRD leans on audit events, global role changes being invisible to the event bus and hook system is a real audit gap, not a style nit.

## Evidence

Source: `packages/roles/src/Roles.ts:64`

```
assign: (userId, roleName) =>
      Ref.update(state, (map) => {
```

## Recommended fix

Publish auth.roles.assigned/revoked events through core's AuthEvents and shape assign/revoke to take an actor (or read CurrentPrincipal) so the event records who changed what.

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
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `roles-audit-and-admin`. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:70`. Fix: Publish auth.roles.assigned/revoked (durably audited) on real state changes, recording the actor. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** core AuthEvents gains auth.roles.assigned/auth.roles.revoked {userId, roleName, actorUserId?} and AuditLog.actorOf returns the actor (not the target); Roles assign/revoke take optional { actorId } and publish only on a real state change (memory: Ref.modify flag; sql: INSERT ... ON CONFLICT DO NOTHING RETURNING / DELETE ... RETURNING); Roles.layer/layerSql now require AuthEvents. The authorization gate for who may call assign stays out of the service (trusted primitive, documented) — see YL-009. Tests: Roles.test.ts 'Roles audit events (RRM-005)' x2 and RolesSql.test.ts 'assign/revoke publish only on a real change, recording the actor'. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 923 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
