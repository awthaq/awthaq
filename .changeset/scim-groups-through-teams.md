---
"@awthaq/scim": minor
"@awthaq/qadi": patch
---

SCIM Groups are written through `OrganizationTeams` with a `Directory` actor (ADR-EA-040, BEH-EA-251) instead of the team records. A directory is now subject to what a member is subject to: `teams.enabled`, `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams`, the team veto points and the team observe points. The team, its initial members and the mapping are one transaction (the hand-made compensation for a link race is gone), a delete removes the team, its memberships, every session's active pointer to it and the mapping in one, and a PATCH or PUT roster change is one `applyRoster` unit. Group changes now publish the organization's `auth.organization.team*` events and fire `AfterAddTeamMember` / `AfterRemoveTeamMember`, so a long-lived qadi `DecisionCache` is cleared when a directory off-boards a member. `@awthaq/qadi`'s `DecisionCacheInvalidationLive` also taps `AfterMoveTeam` and `AfterUpdateTeamMemberRole`.

Migration: SCIM Groups need `OrganizationConfig.teams.enabled: true` (otherwise `403`). A directory-driven deployment that deletes every group sets `teams.allowRemovingAllTeams: true` (otherwise deleting the last team is `409`). `POST`/`PUT`/`PATCH`/`DELETE` on `/Groups` may now answer `403` (a quota, a veto, teams off) and `DELETE` also `403`; `ScimShape["deleteGroup"]` gains `ScimForbidden`. `Scim.layer` no longer requires `ActiveContextRecords` or `TeamRecords`; it requires the `OrganizationTeams` service that `Organization.layer` exposes.
