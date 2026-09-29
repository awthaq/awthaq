---
ID: "EP-006"
Title: "Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded"
Level: medium
Category: "security"
Status: ready-for-human
Package: "organization"
Source: "packages/organization/src/Organization.ts:68"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-006 — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded

`MEDIUM` · `security` · `organization` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **ready-for-human**

## Summary

Every org knob (membershipLimit 100, invitationLimit 100, dynamicAccessControl, teams) is one `Context.Reference` for the whole composition — the same for every organization, with no per-org override in the implementation (`LayerMap` appears only in spec prose). Worse for SaaS exposure, the defaults lean open where a multi-tenant operator would want closed: any authenticated user may create organizations (`Effect.succeed(true)`) and each may own infinitely many (`organizationLimit: POSITIVE_INFINITY`). A single misbehaving account can mint unlimited tenant shells.

## Evidence

Source: `packages/organization/src/Organization.ts:68`

```
  allowUserToCreateOrganization: () => Effect.succeed(true),
  organizationLimit: Number.POSITIVE_INFINITY,
```

## Recommended fix

Invert the risky defaults (create-org denied unless configured; a finite organizationLimit) and add per-organization overrides of the quota fields once per-tenant configuration lands — the shape already supports it because every limit is read through the reference at decision time.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-008` — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check](medium/MTI-008-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-config-and-tenancy`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:67`. Fix: Add per-organization quota overrides and set a finite default organizationLimit (pending the default decision). (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-human.
