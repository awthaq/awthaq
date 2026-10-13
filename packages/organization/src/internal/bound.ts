// @awthaq/organization — the grant ceiling, enforced in one place (package-private)
//
// RRM-001: `requested` (and, when re-roling, what the target holds now) must fit the bound. The
// authorized interface derives a `Ceiling` from the caller; a trusted source (SCIM's configured
// role, the application) passes `Unbounded`, the explicit and greppable choice.

import * as Effect from "effect/Effect";
import * as OrganizationActor from "../OrganizationActor.ts";
import * as OrganizationErrors from "../OrganizationErrors.ts";
import * as PermissionEngine from "../PermissionEngine.ts";

export const requireWithin = (
  bound: OrganizationActor.Bound,
  requested: PermissionEngine.Statements,
  current?: PermissionEngine.Statements,
) =>
  OrganizationActor.Bound.$match(bound, {
    Unbounded: () => Effect.void,
    Ceiling: ({ statements }) =>
      PermissionEngine.canGrant(requested, statements) &&
      (current === undefined || PermissionEngine.canGrant(current, statements))
        ? Effect.void
        : Effect.fail(new OrganizationErrors.RolePermissionEscalation()),
  });
