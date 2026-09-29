---
ID: "MTI-009"
Title: "Cross-tenant denials answer 403, contradicting the repo's own BEH-EA-147 enumeration guidance"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/OrganizationApi.ts:55"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-009 — Cross-tenant denials answer 403, contradicting the repo's own BEH-EA-147 enumeration guidance

`MEDIUM` · `security` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **ready-for-agent**

## Summary

spec/behaviors/19-qadi-bridge-path-a.md:68-81 (BEH-EA-147) fixes as a REQUIREMENT that a cross-tenant denial MUST become 404, 'because a 403 confirms the ID exists.' The organization plugin's own OrganizationPermissionDenied maps to 403 (OrganizationApi.ts:51-56), so probing GET /organization/:id/full, update, or delete against another tenant's existing org id yields 403 (exists, not yours) versus 404 (never existed) — precisely the enumeration leak BEH-EA-147 was written to close, one stratum over. MembershipNotFound for setActive is correctly 404, showing the codebase can follow its own rule.

## Evidence

Source: `packages/organization/src/OrganizationApi.ts:55`

```
/** A `PermissionEngine` rejection on any of this plugin's own mutating endpoints. */
...
  { httpApiStatus: 403 },
```

## Recommended fix

Map OrganizationPermissionDenied to 404 on read paths (or make requireMembership return OrganizationNotFound), reserving 403 for authenticated-and-member-but-insufficient-statement denials, and note the deviation explicitly if the team decides 403 is intentional for the plugin's self-contained surface.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-tenant-read-isolation`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationApi.ts:53`. Fix: Answer 404 OrganizationNotFound whenever the caller is not a member (BEH-EA-147); keep 403 only for members who lack a statement. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
