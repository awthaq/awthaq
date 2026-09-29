---
ID: "MTI-008"
Title: "GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check"
Level: medium
Category: "security"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1094"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-008 — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check

`MEDIUM` · `security` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

The service get is a bare existence lookup and the HTTP handler (Organization.ts:602-609) never even resolves the principal — the group's required Authentication middleware (OrganizationApi.ts:710) is the only gate. Any authenticated user of the deployment can read any tenant's OrganizationDto: name, slug, logo, free-form metadata (OrganizationApi.ts:241-248), and createdAt. metadata is an application-defined string and commonly carries tenant-specific configuration or notes. The mismatch with list (membership-scoped, 1089-1092) and getFull (requireMembership, 1096-1099) shows the intent; get is the odd one out, and it also doubles as a cheap cross-tenant existence oracle (404 vs 200) that pairs badly with MTI-009.

## Evidence

Source: `packages/organization/src/Organization.ts:1094`

```
const get: OrganizationShape["get"] = (organizationId) => requireOrganization(organizationId);
```

## Recommended fix

Require membership for get (or restrict its response to a public projection — id, name, slug only — behind an explicit config flag). If unauthenticated org resolution for invite landing pages is needed, expose a dedicated minimal endpoint that returns only public fields.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-tenant-read-isolation`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1448`. Fix: Require membership for GET /organization/:organizationId, answering 404 to non-members. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** OrganizationShape.get(caller, organizationId) now requires membership (non-member -> OrganizationNotFound); handler passes the principal. Tests: AuthHttp.test.ts 'GET /organization/:id answers a non-member 404 and a member the DTO', Organization.test.ts checkSlug/list/get. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test all pass (one unrelated ports PasswordHasher scrypt timing flake under machine load, green on rerun), test:bdd green, spec:verify:strict PASS, oxlint clean.
