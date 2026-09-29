---
ID: "RRM-002"
Title: "Invitations mint any role with only invitation:create"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/Organization.ts:1378"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-002 — Invitations mint any role with only invitation:create

`MEDIUM` · `security` · `organization` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **ready-for-agent**

## Summary

The invite flow checks only invitation:create; the requested role array flows verbatim into the invitation record and then into members.create on acceptance (Organization.ts:1446, 1537). There is no canGrant subset check against the inviter's own effective statements, so once custom static or dynamic roles exist, a holder of invitation:create can provision a new member directly at any role tier — the same escalation class RRM-001 describes, reached through the invitation flow instead.

## Evidence

Source: `packages/organization/src/Organization.ts:1378`

```
yield* requirePermission(callerId, organizationId, "invitation", "create");
```

## Recommended fix

Apply the same canGrant(effectivePermissions(input.role), granterPermissions) check in invite before persisting the invitation, failing with RolePermissionEscalation.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-role-escalation-guards`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1740`. Fix: Run the same requireGrantable check (RRM-001) on the invitation's requested role before persisting it. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
