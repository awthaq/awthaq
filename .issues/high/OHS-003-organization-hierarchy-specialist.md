---
ID: "OHS-003"
Title: "Duplicate team membership corrupts the durable memberCount and capacity caps"
Level: high
Category: "correctness"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/TeamRecords.ts:224"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-003 — Duplicate team membership corrupts the durable memberCount and capacity caps

`HIGH` · `correctness` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **ready-for-agent**

## Summary

Neither Organization.addTeamMember (Organization.ts:1865-1881) nor the invitation-acceptance team add (Organization.ts:1540-1542) checks findTeamMembership before writing, and addTeamMember then unconditionally increments memberCount (memory: line 233 'memberCount: team.value.memberCount + 1'; SQL: adjustMemberCount(teamId, 1), line 525). In the memory layer the second add silently overwrites the same `${teamId}:${userId}` key while counting it twice; in the SQL layer every insert uses a fresh uuidv7 id and organization_team_membership has only `id TEXT PRIMARY KEY` with no UNIQUE(teamId, userId) (test DDL, TeamRecords.test.ts:33-36), so two rows for one member are stored. memberCount — explicitly designed as the durable counter enforcing maximumMembersPerTeam (Organization.ts:1875) — then over-counts, permanently shrinking usable team capacity, and the SQL removeTeamMember's WHERE teamId+userId delete would remove both rows while decrementing once.

## Evidence

Source: `packages/organization/src/TeamRecords.ts:224`

```
const memberships = HashMap.set(
            s.memberships,
            membershipKeyOf(input.teamId, input.userId),
```

## Recommended fix

Guard both team-add paths with findTeamMembership (return the existing record or a typed AlreadyMember error), and add UNIQUE(teamId, userId) to organization_team_membership so the database backs the invariant.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-001` — Team model is flat: no parent pointers, closure structure, or hierarchy queries](high/OHS-001-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, high)_`
- [`OHS-004` — Team membership carries no role; no per-team permission override exists](medium/OHS-004-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, medium)_`
- [`OHS-008` — Count queries load full row sets instead of using COUNT](low/OHS-008-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `addTeamMember` (Organization.ts:1865-1891) and the invitation-acceptance team add (Organization.ts:1540-1542) both call `teams.addTeamMember` with no preceding `findTeamMembership` check. `TeamRecords.ts` memory layer's `addTeamMember` (lines 214-239) unconditionally does `memberCount: team.value.memberCount + 1` and overwrites the same `HashMap` key on a duplicate add (double-counting the same membership); the SQL layer's `addTeamMember` (lines 516-527) always inserts a fresh row via `adjustMemberCount(+1)` (line 525/444-448). `organization_team_membership`'s only schema definition, the test DDL (packages/organization/test/TeamRecords.test.ts:32-39), declares only `id TEXT PRIMARY KEY` with no `UNIQUE(teamId, userId)` — and there is no separate migrations directory for this table, so no stronger constraint exists elsewhere. All claims confirmed as described. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-write-atomicity-and-uniqueness`. Evidence at HEAD ec065a7: `packages/organization/src/TeamRecords.ts:223`. Fix: Back the one-membership-per-(team,user) invariant with a UNIQUE index plus typed already-member errors on both team-add paths, so memberCount can no longer over-count. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.
