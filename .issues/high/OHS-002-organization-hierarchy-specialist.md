---
ID: "OHS-002"
Title: "Organization deletion cascade runs five repository calls with no transaction"
Level: high
Category: "correctness"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1152"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-002 — Organization deletion cascade runs five repository calls with no transaction

`HIGH` · `correctness` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **resolved**

## Summary

delete_ wipes memberships, invitations, teams, and dynamic roles in four sequential repository calls before deleting the org row, and a package-wide search finds zero uses of SqlClient.withTransaction. Each layerSql removeAll is its own statement set (removeAllTeamsForOrganization alone is two statements, TeamRecords.ts:507-513), so a failure mid-sequence — or the Effect.die('organization vanished between check and write') if the final delete misses — leaves a partially cascaded organization (e.g. org alive with every team and membership already gone). The memory layers happen to be atomic per call, but the SQL layers, which production uses, are not. The same pattern repeats in removeTeam: delete team row, then a second, separate membership DELETE (TeamRecords.ts:495-503).

## Evidence

Source: `packages/organization/src/Organization.ts:1152`

```
yield* members.removeAllForOrganization(organizationId);
          yield* invitations.removeAllForOrganization(organizationId);
          yield* teams.removeAllTeamsForOrganization(organizationId);
```

## Recommended fix

Wrap the org-delete and team-delete cascades in SqlClient.withTransaction at the SQL layer (or add a single transactional cascade operation per repository), so the cascade commits or rolls back as one unit; keep the hooks outside the transaction boundary.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `delete_` (packages/organization/src/Organization.ts:1139-1166) runs four sequential, unwrapped repository calls (`members.removeAllForOrganization`, `invitations.removeAllForOrganization`, `teams.removeAllTeamsForOrganization`, `orgRoles.removeAllForOrganization`, lines 1152-1155) before `orgs.delete`, and a package-wide grep for `withTransaction` in `packages/organization/` returns zero matches. `removeAllTeamsForOrganization` (TeamRecords.ts:505-514) and `removeTeam` (TeamRecords.ts:495-503) each issue two separate, unwrapped SQL statements, confirming the same non-transactional pattern. `withTransaction` is an established pattern elsewhere in the codebase (e.g. packages/ports/src/SqlTransaction.ts, packages/core/src/Accounts.ts), so the fix is mechanical. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-write-atomicity-and-uniqueness`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1506`. Fix: Make the organization-delete and team-delete cascades (and each multi-statement TeamRecords SQL op) commit or roll back as one unit via the existing SqlTransaction port. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.

**Resolved (2026-09-29):** Organization.layer now requires SqlTransaction (@awthaq/ports); delete_ wraps members/invitations/teams/roles/org deletes in sqlTransaction.withTransaction (hooks/events after commit) and removeTeam wraps teams.removeTeam; every multi-statement TeamRecords.layerSql op (removeTeam, removeAllTeamsForOrganization, addTeamMember, removeTeamMember, new removeUserFromOrganizationTeams) is its own sql.withTransaction (savepoint when nested; BEH-EA-035 got a bounded-exception note). Test compositions provide SqlTransaction.layerNoop. Tests: new packages/organization/test/OrganizationSql.test.ts (real sqlite + migrations + SqlTransaction.layerSql; trigger-injected failure on the final organization_org delete leaves every table untouched — proven red with layerNoop swapped in) and TeamRecords.test.ts 'TeamRecords (layerSql) atomicity' x3 (red against the old TeamRecords: team row lost / orphan membership / stale row). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 853 pass, test:bdd green, spec:verify:strict PASS, oxlint clean.
