---
"@awthaq/scim": patch
---

A SCIM `PUT` or `PATCH` is applied whole or not at all, and group listing has no cap (BEH-EA-348, BEH-EA-349).

- A group `PATCH` or `PUT` is interpreted and checked in full before any write, then runs in one unit of work: a team veto, a member limit, an `externalId` conflict or a store outage leaves the name, roster and mapping as they were.
- A SCIM deactivation commits the suspension and the session revocation together.
- A path-less `PATCH` object (`{ "displayName": "x", "members": [...] }`) applies every managed attribute, not just the first.
- A `PATCH` with several member operations changes the roster once, by its net effect.
- `GET /Groups` pages in the store; `displayName eq` and `externalId eq` find a group past the ten-thousandth, and only groups this connection provisioned.

Migration: none for most hosts. A host whose tap or subscriber counts `auth.organization.teamMember*` events or `After*TeamMember` calls per SCIM `PATCH` operation now sees one per net change. A host that relied on a partially applied `PATCH` now sees nothing applied. A `PATCH` `displayName` over 255 characters is now `400`.
