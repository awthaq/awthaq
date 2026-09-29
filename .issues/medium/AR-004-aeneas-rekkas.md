---
ID: "AR-004"
Title: "Multi-tenancy is a plugin bolt-on, absent from the core identity model"
Level: medium
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:210"
Auditor: "aeneas-rekkas"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AR-004 — Multi-tenancy is a plugin bolt-on, absent from the core identity model

`MEDIUM` · `architecture` · `organization` · reported by **Aeneas Rekkas — Founder/CEO of Ory** (`aeneas-rekkas`)

Status: **resolved**

## Summary

Users, accounts, and sessions carry no tenant dimension anywhere in @awthaq/core (grep for tenantId/organizationId over core/src matches only organization event tags). Tenancy exists solely as the organization plugin: membership rows, a per-session 'active organization' pointer, and handler-internal membership checks. That is a sound WorkOS/Clerk-style B2B model, but it is not first-class tenancy in the Ory sense: identity-provider configuration is per-application not per-organization (the SSO model doc explicitly defers 'resolve the provider per tenant/organization', spec/models/09-sso.md), session policy cannot vary per tenant, and no data-layer tenant scoping exists for the core tables. A platform buyer cannot today run two fully isolated customer identity configurations on one deployment.

## Evidence

Source: `packages/organization/src/Organization.ts:210`

```
/** Upserts the caller's own session's active organization; `organizationId: null` unsets it.
```

## Recommended fix

Decide and document the tenancy line: either declare orgs-as-membership (single-tenant identity, like Kratos projects) as the v1 contract, or add an optional tenant/organizationId column to the core account model with per-tenant override points (provider config, session policy) so enterprise SSO per org becomes an additive migration rather than a schema break.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Platform & API posture
- Full dossier: [`aeneas-rekkas`](../../.reports/aeneas-rekkas/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-008` — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check](medium/MTI-008-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `org-config-and-tenancy`. Duplicate of `EP-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md:60`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
