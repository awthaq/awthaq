// @awthaq/roles — RolesAdmin (YL-009, decision: opt-in plugin, Path-B guarded)
//
// `Roles` stays a contract-less trusted primitive (`Auth.make([Roles])` is
// unchanged); an application that wants role administration over HTTP adds this
// second plugin — `Auth.make([Roles.Roles, RolesAdmin.RolesAdmin])` — instead of
// writing its own endpoints. It owns no table (it drives `Roles`), and it does no
// authorization itself: every endpoint carries qadi's `RequiredPermission`
// annotation behind `RequirePermission` (see `RolesAdminApi.ts`), so the caller must
// hold `roles:read` / `roles:manage` in the `Roles` catalog. The application provides
// `RequirePermissionLive` (Path B) as it would for any qadi-guarded group.
//
// The actor recorded on `auth.roles.assigned` / `auth.roles.revoked` (RRM-005) is
// the authenticated subject qadi resolved for the request (`CurrentSubject`), never
// a value the client sends. A non-user subject (an API key, say) leaves it unset.

import type { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import { AuthPlugin } from "@awthaq/core";
import type { AuthSubject } from "@qadi/core";
import { CurrentSubject, permissionKey } from "@qadi/core";
import type { RequirePermission } from "@qadi/http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Roles from "./Roles.ts";
import * as RolesAdminApi from "./RolesAdminApi.ts";

/**
 * The middleware services the application provides for this plugin's group: qadi's Path B
 * `RequirePermissionLive` and `Api.CsrfProtection`. (Naming them here also lets the compiler
 * name them in this module's inferred layer types.)
 */
export type RolesAdminMiddleware = RequirePermission | Api.CsrfProtection;

const USER_SUBJECT_PREFIX = "user:";

/** The user id behind a `user:<id>` subject; `undefined` for any other kind of subject. */
const actorOf = (subject: AuthSubject): Users.UserId | undefined =>
  subject.id.startsWith(USER_SUBJECT_PREFIX)
    ? Users.UserId(subject.id.slice(USER_SUBJECT_PREFIX.length))
    : undefined;

export interface RolesAdminShape {
  readonly catalog: Effect.Effect<ReadonlyArray<RolesAdminApi.RoleDto>>;
  readonly userRoles: (userId: Users.UserId) => Effect.Effect<RolesAdminApi.UserRolesDto>;
  readonly assign: (
    actor: AuthSubject,
    userId: Users.UserId,
    roleName: string,
  ) => Effect.Effect<RolesAdminApi.UserRolesDto, RolesAdminApi.UnknownRole>;
  readonly revoke: (
    actor: AuthSubject,
    userId: Users.UserId,
    roleName: string,
  ) => Effect.Effect<void>;
}

export const RolesAdminHandlers = HttpApiBuilder.group(
  RolesAdminApi.RolesAdminApi,
  "rolesAdmin",
  Effect.fnUntraced(function* (handlers) {
    const admin = yield* RolesAdmin;
    return handlers.handleAll({
      catalog: () => admin.catalog,
      userRoles: ({ params }: { params: RolesAdminApi.UserIdParams }) =>
        admin.userRoles(Users.UserId(params.userId)),
      assign: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: RolesAdminApi.UserIdParams;
        payload: RolesAdminApi.AssignRolePayload;
      }) {
        const subject = yield* CurrentSubject;
        return yield* admin.assign(subject, Users.UserId(params.userId), payload.role);
      }),
      revoke: Effect.fnUntraced(function* ({ params }: { params: RolesAdminApi.AssignmentParams }) {
        const subject = yield* CurrentSubject;
        yield* admin.revoke(subject, Users.UserId(params.userId), params.roleName);
      }),
    });
  }),
);

export class RolesAdmin extends AuthPlugin.Service<RolesAdmin, RolesAdminShape>()("rolesAdmin", {
  apiVersion: 1,
  contract: RolesAdminApi.RolesAdminApi,
}) {
  static readonly layer = AuthPlugin.layer(RolesAdmin, {
    dependsOn: [Roles.Roles],
    handlers: RolesAdminHandlers,
    make: Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const config = yield* Roles.RolesConfig;

      const userRoles: RolesAdminShape["userRoles"] = (userId) =>
        roles
          .listRoleNames(userId)
          .pipe(Effect.map((names) => new RolesAdminApi.UserRolesDto({ userId, roles: names })));

      const catalog = Effect.succeed(
        config.catalog.map(
          (role) =>
            new RolesAdminApi.RoleDto({
              name: role.name,
              permissions: role.permissions.map(permissionKey),
              inherits: role.inherits.map((parent) => parent.name),
            }),
        ),
      );

      const assign: RolesAdminShape["assign"] = (actor, userId, roleName) =>
        roles.assign(userId, roleName, { actorId: actorOf(actor) }).pipe(
          Effect.catchTag("Roles/UnknownRole", (unknown) =>
            Effect.fail(new RolesAdminApi.UnknownRole({ roleName: unknown.roleName })),
          ),
          Effect.andThen(userRoles(userId)),
        );

      const revoke: RolesAdminShape["revoke"] = (actor, userId, roleName) =>
        roles.revoke(userId, roleName, { actorId: actorOf(actor) });

      return RolesAdmin.of({ catalog, userRoles, assign, revoke });
    }),
  });
}
