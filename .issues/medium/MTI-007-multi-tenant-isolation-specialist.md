---
ID: "MTI-007"
Title: "Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models"
Level: medium
Category: "architecture"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:35"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-007 — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models

`MEDIUM` · `architecture` · `roles` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

Role assignments are keyed by userId alone (Roles.ts:35-37, in-memory state at 56) and flatten into AuthSubject.roles/permissions globally (Roles.ts:4-7). The organization plugin's PermissionEngine, by contrast, is strictly per-org (effectivePermissionsOf takes organizationId, Organization.ts:984-990). A qadi policy that mixes subject roles with org relations — the natural thing an application does after reading the qadi bridge — grants a 'support-admin' role assigned for one tenant's workflow the same authority in every other tenant, with no mechanism to scope role assignments to an organization. Nothing in the roles plugin's surface or docs marks the assignments as deliberately deployment-global.

## Evidence

Source: `packages/roles/src/Roles.ts:35`

```
readonly assign: (userId: Users.UserId, roleName: string) => Effect.Effect<void>;
```

## Recommended fix

Either add an optional scope (organizationId) to role assignment and expose scoped roles through the SubjectResolver, or document loudly in Roles.ts and the spec that roles are platform-global and must never encode tenant authority — steering tenant authority exclusively to organization roles and qadi org relations.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-006` — Global role assignments are memory-only; better-auth's user.role column has no durable home](high/BAM-006-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`PCS-003` — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke](medium/PCS-003-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`RRM-003` — Assigned role names absent from the catalog are silently dropped](medium/RRM-003-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-004` — Duplicate catalog role names silently collapse, last wins](low/RRM-004-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`RRM-005` — Roles.assign/revoke emit no audit events and take no authorization gate](medium/RRM-005-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-model-boundaries`. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:41`. Fix: Decide and codify the authority split between global Roles and per-organization roles (see Decisions); the recommended option is a documented, test-pinned contract plus naming guidance, not a third mechanism. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option A per plan; user may revisit. New spec/decisions/017-global-roles-vs-organization-roles.md (ADR-EA-017, indexed and traced; number 017 was free at this base, other programs may also claim it), appendix 02 gains a platform-vs-tenant worked example (anyOf hasRole('platform:support') / hasRelationship('member:update')), Roles.ts header states the split. Naming guidance is advisory: the dossier's optional Roles.config guard rejecting catalog names owner/admin/member was NOT adopted (it would break existing catalogs and the plugin's own fixtures, and the confusion it prevents is one of reading — the two role stores are never merged); revisit if wanted. No third mechanism built; option C (resource-scoped AttributeResolver in ../qadi) left for a second consumer. Gates: spec:verify:strict PASS, tsc/tests unaffected (comment-only source change).
