# 05 — Dynamic per-org custom roles and permissions

**Type:** grilling
**Status:** resolved
**Blocked by:** 02, 03

## Question

Lock the `organization_role` (dynamic access control) schema and
semantics, resolving the open half of ticket 02's question 4 (does a
custom role's `permission` field reach qadi as data):

- `organization_role` fields, `permission` serialization format
- create/delete/update/list/get-role endpoints and their own authorization
  (per ticket 02's answer — likely "cannot self-grant beyond own
  permissions," matching better-auth)
- `maximumRolesPerOrganization` config
- How a member's assigned custom role's permissions actually get checked —
  by an app policy reading resolver/attribute data ticket 02 wires up, by a
  dedicated `Organization`-owned `hasPermission`-equivalent primitive, or
  both

## Answer

Resolved directly by `/to-spec`, folded into `.scratch/organization/spec.md`'s
"Implementation Decisions" (§ Dynamic access control). Summary:
`organization_role` (id/organizationId/role-name-unique-per-org/permission-map/
timestamps), opt-in via `OrganizationConfig.dynamicAccessControl.enabled`
(default off, fully built). create/delete/update/list/get gated by the same
statement engine ticket 02 resolved; a caller can never grant a dynamic role
a permission they don't already hold themselves.
`maximumRolesPerOrganization` config knob. Permissions stay internal to the
statement engine — not separately exposed to qadi (see ticket 02's answer).
