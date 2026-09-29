---
ID: "RRM-007"
Title: "Default admin tier is permission-identical to owner"
Level: low
Category: "security"
Status: resolved
Package: "organization"
Source: "packages/organization/src/PermissionEngine.ts:32"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-007 — Default admin tier is permission-identical to owner

`LOW` · `security` · `organization` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

defaultStatements gives admin exactly owner's five resource/action groups (compare lines 25-31), including organization:delete and full role CRUD, so the two-tier built-in hierarchy is decorative: the only real distinction is the literal-name owner-invariant checks (wouldViolateOwnerInvariant, Organization.ts:1199, 1235) and creatorRole. A model whose second tier can do everything the first can, including delete the organization and mint arbitrary dynamic roles, is convenience-driven rather than least-privilege and invites accidental over-grant.

## Evidence

Source: `packages/organization/src/PermissionEngine.ts:32`

```
  admin: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
```

## Recommended fix

Either strip organization:delete and role create/update/delete from the admin default so owner is meaningfully above it, or collapse to a single privileged built-in role and let applications layer tiers explicitly via permissionStatements.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-005` — Admin role is permission-identical to owner, defanging the last-owner invariant](medium/OHS-005-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `org-role-escalation-guards`. Duplicate of `OHS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/organization/src/PermissionEngine.ts:32`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `OHS-005-organization-hierarchy-specialist` — closed by its fix (see that issue's Resolved comment).
