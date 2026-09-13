# 16 — Teams core

**What to build:** `organization_team`/`organization_team_membership` and
their full CRUD, opt-in via `OrganizationConfig.teams.enabled`, plus wiring
ticket 13's active-context table's `activeTeamId` for real via
`setActiveTeam`.

**Blocked by:** 10, 12, 13.

**Status:** done

- [x] `organization_team` table/persistence module: `id`, `name`,
      `organizationId`, `memberCount`, timestamps; `organization_team_membership`:
      `id`, `teamId`, `userId`, `createdAt`; both layers
- [x] `createTeam`/`listTeams`/`updateTeam`/`removeTeam`,
      `addTeamMember`/`removeTeamMember` (adding a team member requires the
      target already be a member of the team's own organization —
      rejected with a typed error otherwise), `listTeamMembers`,
      `listUserTeams`
- [x] `setActiveTeam(teamId | null)` now genuinely writes ticket 13's
      `organization_active_context.activeTeamId`; rejects if the caller
      isn't a member of the named team
- [x] `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams`
      (default `false` — blocks removing an organization's last team)
      config knobs enforced
- [x] Team CRUD gated by ticket 10's permission engine
      (`team:create`/`update`/`delete`)
- [x] Publishes `auth.organization.teamCreated`/`updated`/`deleted`/
      `teamMemberAdded`/`teamMemberRemoved` audit events
- [x] Domain + wire-level tests: full team CRUD, add/remove team member
      (including the "must already be an org member" rejection),
      `allowRemovingAllTeams` blocking the last team's removal,
      `setActiveTeam` round trip

## Result

Done. `TeamRecords.ts` persists both `organization_team` (id/name/organizationId/
memberCount/timestamps) and `organization_team_membership` (id/teamId/userId/
createdAt) in one module, both layers. `memberCount` is a durable counter
(matching better-auth's own design) incremented/decremented directly on
`addTeamMember`/`removeTeamMember` rather than recomputed via `COUNT`.
`removeTeam` cascades its own team-membership rows; `removeAllTeamsForOrganization`
(new, used by `Organization.delete`'s cascade — a gap the checklist didn't
explicitly ask for but `spec.md`'s own CRUD section requires: "delete...
cascades to remove its memberships, invitations, teams, and dynamic roles")
cascades both tables for every team in an organization.

`Organization.ts` gains `createTeam`/`listTeams`/`listUserTeams`/`updateTeam`/
`removeTeam`/`listTeamMembers`/`addTeamMember`/`removeTeamMember`/`setActiveTeam`,
all gated by `TeamsDisabled` first (opt-in, default off) then the permission
engine (`team:create`/`update`/`delete`) where mutating. `addTeamMember`
requires the target already hold an `organization_membership` row
(`MembershipNotFound` otherwise) and respects `maximumMembersPerTeam`.
`removeTeam` enforces `allowRemovingAllTeams` (default `false`) by rejecting
when it would remove an organization's last team. `setActiveTeam` writes
`ActiveContextRecords.setTeam` (already present since ticket 13, unused until
now) and rejects with a new `TeamMembershipNotFound` error when the caller
isn't a member of the named team. Five new `auth.organization.team*`
events added to `AuthEvents.ts`'s closed union.

**Scoping note**: `listUserTeams` returns only the *caller's own* teams
within an organization — better-auth's own richer version (research ticket
00) lets an admin query another user's teams too (gated by `member:update`),
but neither `spec.md` nor this ticket's checklist required that nuance, so
it was scoped to the simpler, self-only shape (consistent with
`getActiveMember`'s own self-only pattern) rather than silently guessed at.

Covered by `TeamRecords.test.ts` (both layers: create/find, list/count by
org, update/remove with cascade, `removeAllTeamsForOrganization` scoped to
one org, memberCount maintenance, `listTeamsByUser`), `Organization.test.ts`
(teams-disabled rejection, full CRUD, add/remove-member org-membership
requirement, `allowRemovingAllTeams` blocking the last team, `setActiveTeam`
round trip and non-member rejection), and a wire-level create→add→
setActiveTeam→remove test in `AuthHttp.test.ts`.
