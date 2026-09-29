---
ID: "PCS-003"
Title: "Roles plugin mutates assignments silently: no AuthEvent on assign/revoke"
Level: medium
Category: "architecture"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:71"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-003 — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke

`MEDIUM` · `architecture` · `roles` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **resolved**

## Summary

assign and revoke are bare Ref.update calls; the module imports no AuthEvents at all, in stark asymmetry with Organization which publishes on every mutation. Revocation is still immediate for decisions because the SubjectResolver override re-reads the Ref on every resolve (Roles.ts:131) and the qadi key contains the rebuilt subject — but that safety is incidental to the current uncached architecture. Any future consumer that caches per user id (a decision cache variant, a client-side subject cache fed by an out-of-band push, an API-gateway policy cache) gets zero signal that a role was revoked, and the persona's core requirement — event-driven invalidation tied to the actual mutation, not TTL — cannot be implemented for roles facts.

## Evidence

Source: `packages/roles/src/Roles.ts:71`

```
revoke: (userId, roleName) =>
  Ref.update(state, (map) =>
```

## Recommended fix

Publish auth.role.assigned / auth.role.revoked (with userId and roleName) from assign/revoke, mirroring Organization's event discipline, so an invalidation subscriber can cover both fact sources uniformly.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: decision caching
- Full dossier: [`permission-caching-specialist`](../../.reports/permission-caching-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-006` — Global role assignments are memory-only; better-auth's user.role column has no durable home](high/BAM-006-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`MTI-007` — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models](medium/MTI-007-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- [`RRM-003` — Assigned role names absent from the catalog are silently dropped](medium/RRM-003-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-004` — Duplicate catalog role names silently collapse, last wins](low/RRM-004-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`RRM-005` — Roles.assign/revoke emit no audit events and take no authorization gate](medium/RRM-005-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `roles-audit-and-admin`. Duplicate of `RRM-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:77`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
