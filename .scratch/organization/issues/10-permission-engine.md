# 10 — Permission engine (statement-based authorization core)

**What to build:** the self-contained, statement-based permission engine
`spec.md`'s "Roles & permissions" section describes — a pure domain module
computing a member's effective permission set from the role name(s) they
hold, checking a requested action against it, and exposing the
"can't grant a permission you don't already hold" guard as a reusable
primitive dynamic-role creation (ticket 15) will call directly.

**Blocked by:** 09.

**Status:** done

- [x] Default statements exist matching `spec.md`: `organization:[update,delete]`,
      `member:[create,update,delete]`, `invitation:[create,cancel]`,
      `team:[create,update,delete]`, granted to `owner`/`admin`; `member`
      gets read-only
- [x] `OrganizationConfig` lets an application extend/override these
      default statements with its own custom static roles
- [x] Given a set of role names (a membership's `role` array) plus whatever
      custom/dynamic roles exist for that organization, the engine computes
      the union of every held role's permissions
- [x] A `hasPermission(effectivePermissions, resource, action)`-shaped check
      (naming the implementer's choice) is exposed and unit-tested directly
      — no HTTP endpoint of its own yet, later tickets call into it
- [x] The "requested permission set ⊆ caller's own effective permission set"
      guard is exposed as its own reusable check, unit-tested with both a
      passing and a rejecting case
- [x] `packages/organization/test/PermissionEngine.test.ts` (or equivalent)
      covers every case above directly, no HTTP layer needed

## Result

Done. `PermissionEngine.ts` is a pure, service-free module (no
`Context.Service`, no Effect service tag): `defaultStatements` (the three
built-in roles), `effectivePermissions(roleNames, statementsByRole)` (union
over held roles, an unrecognized role name simply contributes nothing
rather than throwing — a dynamic role can be deleted out from under a
membership that still names it), `hasPermission(permissions, resource,
action)`, `canGrant(requested, granterPermissions)` (ticket 15's
self-escalation guard), and `statementsByRoleFrom(customStatements,
dynamicStatements?)` merging built-in + `OrganizationConfig.permissionStatements`
+ (later) dynamic org roles into one lookup map. `Organization.ts` calls
this directly inside `requirePermission` for every gated endpoint — no
network or qadi round trip. Covered by 7 unit tests in
`PermissionEngine.test.ts`, all passing with no service/layer machinery.
