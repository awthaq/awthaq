---
ID: "MTI-005"
Title: "No index exists on the tenant key; count checks materialize every member row"
Level: medium
Category: "performance"
Status: resolved
Package: "organization"
Source: "packages/organization/src/MembershipRecords.ts:331"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-005 — No index exists on the tenant key; count checks materialize every member row

`MEDIUM` · `performance` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

Shipped migrations index only userId on core tables (CoreMigrations.ts:222-236); no migration anywhere indexes organizationId, and the org plugin ships no migrations at all (MTI-004), so at scale every isolation check — requirePermission's findByUserAndOrg, effectivePermissionsOf's statementsByRole (orgRoles.listByOrganization), addMember's countByOrganization, invite-accept's count — scans the membership table. countByOrganization and countOwners fetch every row and count in JavaScript, on hot paths (every addMember, every acceptInvitation). Tenant-keyed queries without tenant-key indexes are the classic shared-schema multi-tenant performance cliff, and here they are also the authorization fast path.

## Evidence

Source: `packages/organization/src/MembershipRecords.ts:331`

```
const countByOrganization: MembershipRecordsShape["countByOrganization"] = (organizationId) =>
      listByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => rows.length),
```

## Recommended fix

Index organization_membership(organizationId), (userId, organizationId), organization_role(organizationId), organization_team(organizationId), organization_invitation(organizationId) in the new migrations; implement countByOrganization/countOwners as COUNT(*) queries instead of row materialization.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MTI-003` — addMember can mint duplicate membership rows, corrupting the row every isolation check consults](medium/MTI-003-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `org-sql-count-queries`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1023`. Fix: Replace every row-materializing count in the SQL layers with COUNT(*) queries (the index half of this finding already shipped). (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** MembershipRecords.countByOrganization/countOwners (countOwners dialect-branched: sqlite json_each, pg role::jsonb @> '"owner"'), TeamRecords.countTeamsByOrganization, InvitationRecords.countPendingByInviter and OrgRoleRecords.countByOrganization are COUNT(*) under layerSql; remaining rows.length hits are memory layers only. Test: MembershipRecords.test.ts 'countOwners counts only memberships whose role array contains owner' (both layers, incl. lookalike role names). NOTE: the pg branch of countOwners is untested here (no Postgres in the sandbox). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 853 pass, test:bdd green, spec:verify:strict PASS, oxlint clean.
