// @awthaq/roles — RolesAdminApi (YL-009)
//
// The contract of the opt-in `RolesAdmin` plugin: read the catalog, read a user's
// global roles, assign and revoke. Every endpoint is guarded by qadi's Path B
// (`RequirePermission`), so the plugin dogfoods enforcement instead of hand-rolling
// a check: `roles:read` to look, `roles:manage` to change (manage implies read).
// Those are permissions the application grants through its own `Roles` catalog
// (`role({ name: "platform:admin", permissions: [rolesManage] })`), which is exactly
// how a platform-authority capability should be handed out (ADR-EA-025).

import { Api } from "@awthaq/api";
import { anyOf, hasPermission, permission } from "@qadi/core";
import { RequirePermission, RequiredPermission, requiresPermission } from "@qadi/http";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** The permission that lets a subject read the catalog and any user's roles. */
export const rolesRead = permission("roles", "read");

/** The permission that lets a subject assign and revoke roles; implies reading. */
export const rolesManage = permission("roles", "manage");

const mayRead = anyOf([hasPermission(rolesRead), hasPermission(rolesManage)]);
const mayManage = hasPermission(rolesManage);

/** RRM-003: the role name is not in this deployment's catalog. */
export class UnknownRole extends Schema.TaggedError<UnknownRole>()(
  "UnknownRole",
  { roleName: Schema.String },
  { httpApiStatus: 422 },
) {}

export const UserIdParams = Schema.Struct({ userId: Schema.String });
export type UserIdParams = typeof UserIdParams.Type;

export const AssignmentParams = Schema.Struct({ userId: Schema.String, roleName: Schema.String });
export type AssignmentParams = typeof AssignmentParams.Type;

export const AssignRolePayload = Schema.Struct({ role: Schema.String });
export type AssignRolePayload = typeof AssignRolePayload.Type;

/** One role of the catalog: its name, the permissions it grants directly, and the roles it inherits. */
export class RoleDto extends Schema.Class<RoleDto>("RoleDto")({
  name: Schema.String,
  permissions: Schema.Array(Schema.String),
  inherits: Schema.Array(Schema.String),
}) {}

export class UserRolesDto extends Schema.Class<UserRolesDto>("UserRolesDto")({
  userId: Schema.String,
  roles: Schema.Array(Schema.String),
}) {}

export const RolesAdminGroup = HttpApiGroup.make("rolesAdmin")
  .add(
    HttpApiEndpoint.get("catalog", "/roles/catalog", { success: Schema.Array(RoleDto) }).pipe(
      (endpoint) =>
        endpoint.annotate(
          RequiredPermission,
          requiresPermission(endpoint, { permission: rolesRead, policy: mayRead }),
        ),
    ),
  )
  .add(
    HttpApiEndpoint.get("userRoles", "/roles/users/:userId", {
      params: UserIdParams,
      success: UserRolesDto,
    }).pipe((endpoint) =>
      endpoint.annotate(
        RequiredPermission,
        requiresPermission(endpoint, { permission: rolesRead, policy: mayRead }),
      ),
    ),
  )
  .add(
    HttpApiEndpoint.post("assign", "/roles/users/:userId/assignments", {
      params: UserIdParams,
      payload: AssignRolePayload,
      success: UserRolesDto,
      error: UnknownRole,
    }).pipe((endpoint) =>
      endpoint.annotate(
        RequiredPermission,
        requiresPermission(endpoint, { permission: rolesManage, policy: mayManage }),
      ),
    ),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/roles/users/:userId/assignments/:roleName", {
      params: AssignmentParams,
      success: HttpApiSchema.Empty(204),
    }).pipe((endpoint) =>
      endpoint.annotate(
        RequiredPermission,
        requiresPermission(endpoint, { permission: rolesManage, policy: mayManage }),
      ),
    ),
  )
  // `CsrfProtection` last so it runs first: a forged cross-site request is rejected before
  // any session or permission work.
  .middleware(RequirePermission)
  .middleware(Api.CsrfProtection);

export const RolesAdminApi = HttpApi.make("auth").add(RolesAdminGroup);
