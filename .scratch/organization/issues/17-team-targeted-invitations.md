# 17 — Team-targeted invitations

**What to build:** wire ticket 14's already-accepted `teamId` field on
`invite` so accepting a team-targeted invitation actually joins the named
team, now that teams (ticket 16) exist.

**Blocked by:** 14, 16.

**Status:** done

- [x] `invite` with a `teamId` validates the team belongs to the target
      organization
- [x] `accept`ing a `teamId`-bearing invitation creates the organization
      membership (as ticket 14 already does) and adds the accepting user
      to the named team (ticket 16's `addTeamMember` path), respecting
      `maximumMembersPerTeam`
- [x] Domain + wire-level test: invite with a `teamId`, accept, confirm the
      resulting team membership exists

## Result

Done. `invite` now validates a `teamId` up front (`TeamsDisabled` if teams
aren't enabled, `TeamNotFound` if the team doesn't belong to the target
organization) before creating the invitation row. `acceptInvitation`
checks the team's `maximumMembersPerTeam` capacity *before* creating the
organization membership (so a full team fails the whole accept cleanly,
never leaving a dangling org-only membership), then — after the org
membership and invitation-accepted bookkeeping — adds the accepting user
to the named team via `TeamRecords.addTeamMember` and publishes
`auth.organization.teamMemberAdded`. Covered by a domain-level round-trip
test (`Organization.test.ts`: invite with `teamId` → accept → team
membership exists) and an unknown-`teamId` rejection test.
