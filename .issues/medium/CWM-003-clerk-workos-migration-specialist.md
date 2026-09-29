---
ID: "CWM-003"
Title: "removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session"
Level: medium
Category: "correctness"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1206"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-003 — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session

`MEDIUM` · `correctness` · `organization` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **resolved**

## Summary

The full removeMember body (lines 1186-1219) — and identically leave (1262-1293) — deletes the membership row, publishes auth.organization.memberRemoved, and runs hooks, but never clears the target's ActiveContextRecord (whose activeOrganizationId still names the org) and never calls Sessions. Clerk revokes the org binding from the member's session immediately. The blast radius here is contained — getActiveMember re-checks membership and fails with NoActiveOrganization (lines 1329-1339), and qadi attributes re-derive from live membership — but the stale active-context row persists for the life of the session, organization-scoped UI reading the raw ActiveContextDto (endpoint /organization/active) will still display a removed org as 'active', and the event-based deprovisioning recipe a migration would wire is the only revocation path. For the SCIM deprovisioning scenario in the persona's rubric, this stale-pointer behavior compounds the missing auto-revocation.

## Evidence

Source: `packages/organization/src/Organization.ts:1206`

```
yield* members
            .remove(targetUserId, organizationId)
            .pipe(
```

## Recommended fix

In removeMember/leave (and organization delete's cascade), unset the removed user's active organization/team when it points at the affected org — activeContext already has the session-keyed store to do this in one write. Optionally emit a dedicated memberRemoved-carries-stale-context note or fold active-context clearing into the afterRemove hook's documented default so integrators get Clerk-equivalent semantics without custom code.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-active-context-lifecycle`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1564`. Fix: Clear active-context pointers (and team memberships) whenever the membership/team/org they point at goes away, and re-validate on read. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** removeMember and leave now go through dropMembership: one SqlTransaction that removes the membership, calls activeContext.clearOrganizationForUser and the new teams.removeUserFromOrganizationTeams (decrementing each memberCount), then publishes auth.organization.teamMemberRemoved + runs AfterRemoveTeamMember per team after commit (N9: team-member in qadi no longer answers for a removed member). delete_ clears activeContext.clearOrganization and removeTeam clearTeam inside their transactions (closes OHS-007). getActive re-validates org/team membership on read and lazily clears stale pointers. Tests: Organization.test.ts 'active context lifecycle (CWM-003)' x5, OrganizationQadi.test.ts 'a removed member is no longer team-member', ActiveContextRecords.test.ts; all red before. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 871 pass, test:bdd green, spec:verify:strict PASS, oxlint clean.
