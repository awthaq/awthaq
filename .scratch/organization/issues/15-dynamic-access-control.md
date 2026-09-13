# 15 — Dynamic access control (custom org roles)

**What to build:** `organization_role` and create/delete/update/list/get
for org-defined custom roles, opt-in via `OrganizationConfig.dynamicAccessControl.enabled`.

**Blocked by:** 10, 12.

**Status:** done

- [x] `organization_role` table/persistence module: `id`, `organizationId`,
      `role` (name, unique per organization), `permission` (serialized
      resource→actions map, same shape as ticket 10's static statements),
      timestamps; both layers
- [x] `createRole`/`deleteRole`/`updateRole`/`listRoles`/`getRole`, gated by
      ticket 10's permission engine (creating/managing dynamic roles
      requires the equivalent of `owner`/`admin`-only `ac:create`/`ac:read`)
- [x] A caller can never create or update a dynamic role granting a
      permission they don't already hold themselves — reuses ticket 10's
      self-escalation guard directly, rejecting with a typed error
      otherwise
- [x] `dynamicAccessControl.maximumRolesPerOrganization` config (number or
      predicate, default unlimited) enforced on `createRole`
- [x] A membership's `role` array (ticket 12) may reference a dynamic role
      name; ticket 10's permission-union computation now also looks up
      `organization_role` for any role name it doesn't recognize as a
      built-in
- [x] Publishes `auth.organization.roleCreated`/`updated`/`deleted` audit
      events
- [x] Domain + wire-level tests: create/update/delete/list a custom role;
      self-escalation rejected; a member holding a custom role's effective
      permissions include it; `maximumRolesPerOrganization` enforced

## Result

Done. `OrgRoleRecords.ts` persists `organization_role`
(id/organizationId/role-name-unique-per-org/permission-map/timestamps),
both layers, with `layerSql` mapping a unique-constraint violation to
`OrgRoleNameTaken` the same way `OrganizationRecords.ts` maps a slug
collision. `Organization.ts`'s `statementsByRole`/`effectivePermissionsOf`
now fold in every dynamic role an organization has defined (when
`dynamicAccessControl.enabled`) alongside the static defaults/config
statements ticket 10 already built — `PermissionEngine.statementsByRoleFrom`'s
`dynamicStatements` parameter (anticipated in ticket 10's own landing) is
exactly what this plugs into, no reshaping needed.
`createRole`/`listRoles`/`getRole`/`updateRole`/`deleteRole` are gated by
the same permission engine (`role:create`/`read`/`update`/`delete`,
granted to owner/admin by default); every operation first checks
`dynamicAccessControl.enabled` (`DynamicAccessControlDisabled` otherwise).
`createRole`/`updateRole` reuse `PermissionEngine.canGrant` directly against
the caller's own effective permissions — a caller can never grant a
dynamic role a permission they don't hold. `maximumRolesPerOrganization`
enforced on `createRole`. Covered by `OrgRoleRecords.test.ts` (both layers,
including cross-organization name reuse) and `Organization.test.ts`
(disabled-by-default rejection, full CRUD round trip, self-escalation
rejection, a member holding a custom role successfully using its granted
permission, `maximumRolesPerOrganization`) plus a wire-level
create→list→delete test in `AuthHttp.test.ts`.

**Follow-up fix (applied directly, outside the delegated implementation pass)**: ticket 16's own `## Result` flagged that `OrgRoleRecords` had no `removeAllForOrganization` and `Organization.delete`'s cascade never cleaned up dynamic roles, despite `spec.md`'s CRUD section requiring it ("cascades to remove its memberships, invitations, teams, and dynamic roles"). Added `removeAllForOrganization` to `OrgRoleRecordsShape` (both layers, mirroring `MembershipRecords`'/`InvitationRecords`' own identical method), wired it into `Organization.ts`'s `delete_` cascade alongside the other three, and added a covering test (`Organization.test.ts`: "delete cascades dynamic roles").
