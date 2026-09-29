---
ID: "RRM-001"
Title: "Role-assignment paths bypass the canGrant escalation guard"
Level: high
Category: "security"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1240"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-001 — Role-assignment paths bypass the canGrant escalation guard

`HIGH` · `security` · `organization` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

updateMemberRole (HTTP PATCH /organization/:organizationId/members/:userId, OrganizationApi.ts:482) gates only on the member:update statement, then writes an arbitrary role array straight into the membership (UpdateMemberRolePayload.role is Schema.Array(Schema.String), OrganizationApi.ts:209). Its sibling role-definition paths createRole/updateRole do enforce PermissionEngine.canGrant's subset rule (Organization.ts:1641, 1712), but assignment does not: a custom or dynamic role that carries member:update (constructible through the supported config surface, since owner holds member:create) can set any member — including itself — to ["owner"] or to any dynamic role name, acquiring statements its holder never had. addMember (Organization.ts:1296) takes role with no permission gate at all.

## Evidence

Source: `packages/organization/src/Organization.ts:1240`

```
yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "member", "update");
```

## Recommended fix

Compute effectivePermissionsOf(targetRoleNames) in updateMemberRole/addMember and fail with RolePermissionEscalation unless canGrant(targetStatements, granterPermissions) holds, reusing the guard already proven on createRole/updateRole.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/organization/src/Organization.ts:1240` matches the evidence exactly; `updateMemberRole` gates only on `requirePermission(..., "member", "update")` with no `PermissionEngine.canGrant` check, while `createRole` (line 1641) and `updateRole` (line 1712) do call `canGrant`. `addMember` (line 1296-1316) indeed has no permission gate at all, though it is only reachable via `OrganizationShape` (no HTTP endpoint in `OrganizationApi.ts` calls it), so the practical exposure is narrower than `updateMemberRole`'s directly HTTP-reachable escalation. Fix reuses the existing `effectivePermissionsOf`/`canGrant` pattern already proven in the same file. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-role-escalation-guards`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1598`. Fix: Apply PermissionEngine.canGrant to every role-assignment path, reject unknown role names, and forbid modifying a member who out-privileges the caller. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.

**Resolved (2026-09-29):** Every role-assignment path now applies the same guard `createRole`/`updateRole` already had (`packages/organization/src/Organization.ts`: `requireGrantable`, `requireOutranks`, `requireKnownRoles`). `updateMemberRole` (after the veto hook, since a tap may rewrite the role) requires the caller to hold every statement it confers (`PermissionEngine.canGrant` → `RolePermissionEscalation`), to not out-lose against the member it is changing, and to name only known roles (new `UnknownOrgRole`, HTTP 422). `addMember` (trusted, caller-less: SCIM/import) still bypasses the grant guard by design but rejects unknown role names. `OrganizationApi` endpoint error unions and the `OrganizationShape` types updated. TDD: `packages/organization/test/Organization.test.ts` 'RRM-001/RRM-002: role assignment respects canGrant' (5 of 7 confirmed red before the fix; 2 are no-over-blocking guards). One pre-existing test added a member to a not-yet-created dynamic role and was reordered accordingly. Gates: typecheck, test (819), test:bdd (104), spec:verify:strict, oxlint on the package green. Deferred: the AuthHttp wire-level 403 test and `spec/models/14-organization.md` (still a 'Planned' stub — covered by the spec-status-banner-sweep workstream).
