---
ID: "EP-005"
Title: "No branding or custom-domain surface beyond org logo/metadata fields"
Level: medium
Category: "api"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:457"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-005 — No branding or custom-domain surface beyond org logo/metadata fields

`MEDIUM` · `api` · `organization` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

The only branding-adjacent surface is `logo` and free-form `metadata` on the organization record — rendered straight into the DTO, consumed by nothing in the library. There are no custom domains, no per-tenant login-page or email-template hooks, and no domain-to-tenant resolution point in @awthaq/server. Universal-login-style branding (the thing tenants see) is entirely the host application's problem, which is defensible for a library but means the org record's branding fields are decorative today.

## Evidence

Source: `packages/organization/src/Organization.ts:457`

```
    logo: Option.getOrNull(record.logo),
    metadata: Option.getOrNull(record.metadata),
```

## Recommended fix

Either remove the illusion (document logo/metadata as host-owned data) or make them load-bearing: a server hook that resolves Host header → organization and exposes branding (logo, colors, display name) to login/email rendering, with the custom-domain → tenant mapping as a first-class table when the tenancy boundary lands.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-008` — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check](medium/MTI-008-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-config-and-tenancy`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:484`. Fix: Make the existing branding fields load-bearing where the plugin itself renders to tenants' users, and route custom-domain → tenant through ticket 18's TenantResolver. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Invitation mail data now carries organizationLogo next to organizationName (test captures the Mailer); TenantResolver.ts documents the Host-header/custom-domain recipe and packages/organization docs state logo/metadata are host-owned presentation data; no domain table (none until a real consumer exists). TenantResolver port + Organization.tenantMiddleware (BEH-EA-234) landed with this slice.
