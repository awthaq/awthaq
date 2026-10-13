// @awthaq/organization — OrganizationRoles
//
// Dynamic access control as a system interface (ADR-EA-040): an organization's own roles, stored as
// data. Every mutation takes an explicit `Actor` and the `Bound` of what its source may confer; who may
// manage roles at all (`role:create|read|update|delete`) is the authorized layer's. What a role operation
// means lives here once: the feature gate (`dynamicAccessControl.enabled`), the reserved names (RZS-005),
// `Bound` over the statements (RRM-001), `maximumRolesPerOrganization`, the veto point, the write, the
// event and the observe point.

import { AuthEvents, Errors, HookPoint } from "@awthaq/core";
import { Defects, Tenant } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as OrganizationActor from "./OrganizationActor.ts";
import { OrganizationConfig } from "./OrganizationConfig.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationErrors from "./OrganizationErrors.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import { requireWithin } from "./internal/bound.ts";
import { limitsOf } from "./internal/limits.ts";

export type Role = OrgRoleRecords.OrgRoleRecord;

export interface OrganizationRolesShape {
  /** `dynamicAccessControl.enabled` in force for this fiber (per-tenant config). */
  readonly requireEnabled: Effect.Effect<void, OrganizationErrors.DynamicAccessControlDisabled>;
  readonly list: (
    organizationId: string,
  ) => Effect.Effect<
    ReadonlyArray<Role>,
    OrganizationErrors.DynamicAccessControlDisabled | Errors.StoreUnavailable
  >;
  readonly find: (
    organizationId: string,
    roleId: string,
  ) => Effect.Effect<
    Role,
    | OrganizationErrors.DynamicAccessControlDisabled
    | OrganizationErrors.OrgRoleNotFound
    | Errors.StoreUnavailable
  >;
  /** RZS-005 reserved names, the `Bound` over `permission`, `maximumRolesPerOrganization`, the veto, a unique name. */
  readonly create: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly role: string;
      readonly permission: PermissionEngine.Statements;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    Role,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.DynamicAccessControlDisabled
    | OrganizationErrors.ReservedOrgRoleName
    | OrganizationErrors.RolePermissionEscalation
    | OrganizationErrors.RoleLimitReached
    | OrganizationErrors.OrgRoleNameTaken
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly update: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly roleId: string;
      readonly permission: PermissionEngine.Statements;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    Role,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.DynamicAccessControlDisabled
    | OrganizationErrors.OrgRoleNotFound
    | OrganizationErrors.RolePermissionEscalation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly remove: (
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string; readonly roleId: string },
  ) => Effect.Effect<
    void,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.DynamicAccessControlDisabled
    | OrganizationErrors.OrgRoleNotFound
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
}

export class OrganizationRoles extends Context.Service<OrganizationRoles, OrganizationRolesShape>()(
  "awthaq/plugin/organization/Roles",
) {
  static readonly layer = Layer.effect(
    OrganizationRoles,
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
      const builtConfig = yield* OrganizationConfig;
      const configNow = Tenant.configInForce(OrganizationConfig, builtConfig);
      const beforeCreate = yield* OrganizationHooks.BeforeCreateRole;
      const afterCreate = yield* OrganizationHooks.AfterCreateRole;
      const beforeUpdate = yield* OrganizationHooks.BeforeUpdateRole;
      const afterUpdate = yield* OrganizationHooks.AfterUpdateRole;
      const beforeDelete = yield* OrganizationHooks.BeforeDeleteRole;
      const afterDelete = yield* OrganizationHooks.AfterDeleteRole;

      const requireEnabled: OrganizationRolesShape["requireEnabled"] = Effect.flatMap(
        configNow,
        (orgConfig) =>
          orgConfig.dynamicAccessControl.enabled
            ? Effect.void
            : Effect.fail(new OrganizationErrors.DynamicAccessControlDisabled()),
      );

      /** EP-003: suspension reads as not found; then the feature gate. */
      const gate = (organizationId: string) =>
        directory.requireActive(organizationId).pipe(Effect.andThen(requireEnabled));

      const requireRole = (organizationId: string, roleId: string) =>
        orgRoles.findById(organizationId, roleId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationErrors.OrgRoleNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const list: OrganizationRolesShape["list"] = (organizationId) =>
        requireEnabled.pipe(Effect.andThen(orgRoles.listByOrganization(organizationId)));

      const find: OrganizationRolesShape["find"] = (organizationId, roleId) =>
        requireEnabled.pipe(Effect.andThen(requireRole(organizationId, roleId)));

      const create: OrganizationRolesShape["create"] = Effect.fnUntraced(function* (actor, input) {
        const { organizationId, bound } = input;
        yield* gate(organizationId);
        const orgConfig = yield* configNow;
        // RZS-005/N8: a dynamic role never takes a built-in tier's name or an application-defined
        // static role's name.
        if (
          PermissionEngine.isBuiltInRole(input.role) ||
          Object.hasOwn(orgConfig.permissionStatements, input.role)
        ) {
          return yield* new OrganizationErrors.ReservedOrgRoleName();
        }
        yield* requireWithin(bound, input.permission);
        const count = yield* orgRoles.countByOrganization(organizationId);
        if (count >= (yield* limitsOf(orgConfig, organizationId)).maximumRolesPerOrganization) {
          return yield* new OrganizationErrors.RoleLimitReached();
        }
        const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateRole)(
          beforeCreate.run({ actor, organizationId, role: input.role }),
        );
        const record = yield* orgRoles
          .create({ organizationId, role: vetoed.role, permission: input.permission })
          .pipe(
            Effect.catchTag("OrgRoleRecordNameTaken", () =>
              Effect.fail(new OrganizationErrors.OrgRoleNameTaken()),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.roleCreated",
          organizationId,
          role: record.role,
        });
        yield* afterCreate.run({ actor, organizationId, role: record.role, roleId: record.id });
        return record;
      });

      const update: OrganizationRolesShape["update"] = Effect.fnUntraced(function* (actor, input) {
        const { organizationId, roleId, permission, bound } = input;
        yield* gate(organizationId);
        yield* requireRole(organizationId, roleId);
        yield* requireWithin(bound, permission);
        yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateRole)(
          beforeUpdate.run({ actor, organizationId, roleId }),
        );
        const updated = yield* orgRoles
          .update(organizationId, roleId, permission)
          .pipe(
            Effect.catchTag("OrgRoleRecordNotFound", () =>
              Defects.invariantViolation(
                "RowVanished",
                "awthaq: org role vanished between check and write",
              ),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.roleUpdated",
          organizationId,
          role: updated.role,
        });
        yield* afterUpdate.run({ actor, organizationId, roleId });
        return updated;
      });

      const remove: OrganizationRolesShape["remove"] = Effect.fnUntraced(function* (actor, input) {
        const { organizationId, roleId } = input;
        yield* gate(organizationId);
        const existing = yield* requireRole(organizationId, roleId);
        yield* HookPoint.aborted(OrganizationHooks.BeforeDeleteRole)(
          beforeDelete.run({ actor, organizationId, roleId }),
        );
        yield* orgRoles
          .remove(organizationId, roleId)
          .pipe(
            Effect.catchTag("OrgRoleRecordNotFound", () =>
              Defects.invariantViolation(
                "RowVanished",
                "awthaq: org role vanished between check and write",
              ),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.roleDeleted",
          organizationId,
          role: existing.role,
        });
        yield* afterDelete.run({ actor, organizationId, roleId });
      });

      return OrganizationRoles.of({ requireEnabled, list, find, create, update, remove });
    }),
  );
}
