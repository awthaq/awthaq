---
ID: "RZS-006"
Title: "Split-brain: plugin endpoint gating uses PermissionEngine statements while qadi sees only the built-in role triad"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/Organization.ts:1004"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-006 — Split-brain: plugin endpoint gating uses PermissionEngine statements while qadi sees only the built-in role triad

`MEDIUM` · `correctness` · `organization` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **ready-for-agent**

## Summary

The organization plugin authorizes its own endpoints from PermissionEngine's statement merge over built-in + custom static + dynamic roles (Organization.ts:969-990, 992-1009), while its qadi relationship export answers only member/admin/owner derived from the membership role array (OrganizationQadi.ts:94-110). A dynamic or custom role that grants statements therefore produces no qadi-visible relation, and conversely the admin/owner relations say nothing about statement grants. Two authorization models read the same membership row under different vocabularies with no composition rule: a hasRelationship-based application policy and the plugin's own requirePermission can disagree about the same principal on the same organization. The plugin's header comment (OrganizationQadi.ts:11-36) documents how it worked around qadi's AttributeResolver shape, but not this divergence, which is a standing consistency obligation for every future plugin that contributes resolvers.

## Evidence

Source: `packages/organization/src/Organization.ts:1004`

```
const effective = yield* effectivePermissionsOf(organizationId, membership.value);
          if (!PermissionEngine.hasPermission(effective, resource, action)) {
```

## Recommended fix

Derive qadi relations and PermissionEngine statements from one source (e.g. express built-in roles as relations over the statement table, or generate relations per granted resource/action), or explicitly document that qadi consumers see only the built-in role triad and that custom/dynamic roles are invisible to hasRelationship — and add a test pinning whichever contract is chosen.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-qadi-relationships`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1355`. Fix: Derive every org relation qadi sees from the same functions the plugin's own gating uses, so a qadi policy and requirePermission can never disagree. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
