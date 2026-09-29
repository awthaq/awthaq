---
ID: "OHS-005"
Title: "Admin role is permission-identical to owner, defanging the last-owner invariant"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/PermissionEngine.ts:32"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-005 — Admin role is permission-identical to owner, defanging the last-owner invariant

`MEDIUM` · `correctness` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **ready-for-agent**

## Summary

defaultStatements gives admin the exact same five-resource statement set as owner (lines 25-38), including organization:['update','delete'] and full role management — so an organization can satisfy wouldViolateOwnerInvariant (Organization.ts:1176-1184, which blocks removing the last owner) while every actual owner is gone and admins retain unrestricted deletion and role-grant power. The invariant the code carefully guards is decorative: it counts role names, not capability. Relatedly, invite (Organization.ts:1374-1448) grants whatever role the caller names — including owner — with no canGrant subset check, unlike updateRole/createRole which do enforce one (line 1712).

## Evidence

Source: `packages/organization/src/PermissionEngine.ts:32`

```
  admin: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
```

## Recommended fix

Differentiate admin from owner (drop organization:delete or role CRUD from admin's defaults), or redefine the owner invariant over effective capabilities; and run the invitation's requested role statements through PermissionEngine.canGrant against the inviter's effective permissions.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RRM-007` — Default admin tier is permission-identical to owner](low/RRM-007-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-role-escalation-guards`. Evidence at HEAD ec065a7: `packages/organization/src/PermissionEngine.ts:25`. Fix: Make owner strictly above admin (better-auth parity: only owner may delete the organization), which also makes RRM-001's canGrant stop admins from minting owners. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
