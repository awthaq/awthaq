# 04 — Teams schema and behavior

**Type:** grilling
**Status:** resolved
**Blocked by:** 03

## Question

Lock team/teamMember schema and CRUD, plus the map's own richer-than-better-auth
decision that a `"team-member"` relation is distinct from org-level
`"member"` in the `RelationshipResolver` contribution (ticket 02 covers the
resolver-wiring mechanism itself; this ticket covers what teams themselves
look like):

- `organization_team`/`organization_team_membership` fields
- create/list/update/remove-team, add/remove-team-member,
  list-teams/list-team-members/list-user-teams
- `maximumTeams`/`maximumMembersPerTeam`/`allowRemovingAllTeams` config and
  enforcement points
- Whether team membership implies org membership automatically, or must be
  granted independently
- Whether the owner invariant (ticket 03) has a team-level analog (better-auth's
  `allowRemovingAllTeams` already covers "can the last team be removed";
  confirm effect-auth's default)

## Answer

Resolved directly by `/to-spec`, folded into `.scratch/organization/spec.md`'s
"Implementation Decisions" (§ Teams). Summary: `organization_team` +
`organization_team_membership`, opt-in via `OrganizationConfig.teams.enabled`
(default off, fully built). Team membership requires prior organization
membership. `maximumTeams`/`maximumMembersPerTeam`/`allowRemovingAllTeams`
(default false) match better-auth's own defaults. `"team-member"` is a
distinct `RelationshipResolver` relation from org-level `"member"` (spec's
qadi contribution section) — richer than better-auth, which has no
per-team resource ACL.
