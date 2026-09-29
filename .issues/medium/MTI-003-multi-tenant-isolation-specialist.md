---
ID: "MTI-003"
Title: "addMember can mint duplicate membership rows, corrupting the row every isolation check consults"
Level: medium
Category: "correctness"
Status: resolved
Package: "organization"
Source: "packages/organization/src/MembershipRecords.ts:306"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-003 — addMember can mint duplicate membership rows, corrupting the row every isolation check consults

`MEDIUM` · `correctness` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

Organization.addMember (Organization.ts:1296-1316) checks the org exists and the membership limit, but never checks findByUserAndOrg before members.create — unlike invite, which carefully handles alreadyMember (Organization.ts:1396-1411). The SQL create is a bare INSERT with no UniqueViolation mapping (MembershipRecords.ts:297-308, contrast OrganizationRecords' slug handling at 248-252) and no shipped migration declares UNIQUE(userId, organizationId), so concurrent addMember calls or addMember racing an invitation accept produce two rows for the same (userId, organizationId). Every tenant decision — requirePermission, requireMembership, attributesFor, getActiveMember — flows through findByUserAndOrgQuery, a SqlSchema.findOneOption that receives two rows; the isolation anchor row is then corrupt or the check defects. This is exactly the constraint the missing migrations should have guaranteed.

## Evidence

Source: `packages/organization/src/MembershipRecords.ts:306`

```
        role: JSON.stringify(input.role),
        createdAt: now,
      }).pipe(Effect.orDie);
```

## Recommended fix

Ship the organization_membership migration with UNIQUE(userId, organizationId), map UniqueViolation in the SQL create to a typed AlreadyMember error, and add an early findByUserAndOrg duplicate check in addMember for a friendly error path.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MTI-005` — No index exists on the tenant key; count checks materialize every member row](medium/MTI-005-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-write-atomicity-and-uniqueness`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1660`. Fix: Add UNIQUE(userId, organizationId) to organization_membership, a typed already-member error at the records layer, and an early duplicate check in addMember. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** MembershipRecords: MembershipRecordAlreadyExists (memory: atomic Ref.modify, sql: UniqueViolation mapped); migration organization_membership_unique_user_org (dedupe keeping MIN(id) + UNIQUE(userId, organizationId)); OrganizationApi.AlreadyMember (409); Organization.addMember pre-checks and catches the race; create() for a brand-new org dies on the impossible collision. Tests: MembershipRecords.test.ts both layers (red: overwrite/duplicate), Organization.test.ts 'addMember for an existing member fails AlreadyMember'. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 853 pass, test:bdd green, spec:verify:strict PASS, oxlint clean.
