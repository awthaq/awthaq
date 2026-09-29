---
ID: "MTI-010"
Title: "getInvitation serves cross-tenant invitation data with no auth binding, and the invitation id doubles as the emailed token"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/Organization.ts:1601"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-010 — getInvitation serves cross-tenant invitation data with no auth binding, and the invitation id doubles as the emailed token

`MEDIUM` · `security` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **ready-for-agent**

## Summary

getInvitation is a bare findById — no caller, no email binding, no membership check (Organization.ts:1600-1608); the SQL lookup is WHERE id = ${id} alone (InvitationRecords.ts:239). Meanwhile the same id is emailed as the capability token (data: { token: record.id, organizationId, role }, Organization.ts:1421). So one value is simultaneously a REST resource identifier usable by any authenticated principal to read invitee email, inviter id, org id, role, status, and expiry (InvitationDto, OrganizationApi.ts:275-285), and a bearer-style secret transmitted in email. Anyone who obtains an invite link (mail forwarding, logs, browser history, referrer leakage) can query the invitation's details, and accept/reject are protected only by the caller's email matching — which couples invitation security to email uniqueness rather than a separate secret.

## Evidence

Source: `packages/organization/src/Organization.ts:1601`

```
const getInvitation: OrganizationShape["getInvitation"] = (invitationId) =>
        invitations.findById(invitationId).pipe(
```

## Recommended fix

Split the capability from the identifier: issue a separate high-entropy token carried by the email and required by accept/reject/get, keep the REST id for internal references, and bind getInvitation to the caller's email like accept does.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-tenant-read-isolation`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1963`. Fix: Bind getInvitation to the invitee (or an org member with invitation rights) and split the emailed capability token from the REST id. (effort L). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
