// @awthaq/admin — AdminTenants
//
// EP-003 (wayfinder ticket 19 §3, ADR-EA-018, BEH-EA-237): the platform
// administrator's tenant-administration surface — list and read organizations,
// suspend and reinstate them — as an opt-in second plugin:
// `Auth.make([Organization, Admin, AdminTenants])`. `Admin` itself stays free of
// the organization plugin (`RolesAdmin` beside `Roles` is the same shape); this
// one `dependsOn: [Organization]` and reads its records.
//
// Every operation is behind `AdminConfig.canAdministerTenants` — fail-closed,
// the same predicate that lets `Admin.list`/`forceStop` reach across tenants —
// and a caller that fails it learns nothing about which organization ids exist
// (gate first, existence second). Suspension is a state on the organization
// record, enforced by the organization plugin's own access checks (its
// `requireOrganization` gate and qadi relationships); this plugin only flips it.

import { Api } from "@awthaq/api";
import { AuthEvents, AuthPlugin, Defects, Tenant, Users } from "@awthaq/core";
import { Organization, OrganizationRecords } from "@awthaq/organization";
import { makeSubject } from "@qadi/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { AdminConfig } from "./Admin.ts";
import * as AdminApi from "./AdminApi.ts";
import * as AdminTenantsApi from "./AdminTenantsApi.ts";

export interface OrganizationCursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

export interface OrganizationPage {
  readonly items: ReadonlyArray<OrganizationRecords.OrganizationRecord>;
  /** `None` on the last page. */
  readonly nextCursor: Option.Option<OrganizationCursor>;
}

export interface AdminTenantsShape {
  /** Every organization, keyset-paginated on `(createdAt, id)`. Errors: `AdminActionDenied` (gate). */
  readonly listOrganizations: (
    caller: Api.UserPrincipal,
    input?: {
      readonly cursor?: OrganizationCursor | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<OrganizationPage, AdminApi.AdminActionDenied>;
  readonly getOrganization: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    AdminApi.AdminActionDenied | AdminTenantsApi.AdminOrganizationNotFound
  >;
  /**
   * Suspends the organization: every organization-scoped operation and qadi relationship
   * through it is refused until `unsuspendOrganization`. Idempotent (the original
   * suspension time is kept); publishes `auth.admin.organizationSuspended`.
   */
  readonly suspendOrganization: (
    caller: Api.UserPrincipal,
    organizationId: string,
    input: { readonly reason?: string | undefined },
  ) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    AdminApi.AdminActionDenied | AdminTenantsApi.AdminOrganizationNotFound
  >;
  readonly unsuspendOrganization: (
    caller: Api.UserPrincipal,
    organizationId: string,
  ) => Effect.Effect<
    OrganizationRecords.OrganizationRecord,
    AdminApi.AdminActionDenied | AdminTenantsApi.AdminOrganizationNotFound
  >;
}

const toOrganizationDto = (
  record: OrganizationRecords.OrganizationRecord,
): AdminTenantsApi.TenantOrganizationDto =>
  new AdminTenantsApi.TenantOrganizationDto({
    id: record.id,
    name: record.name,
    slug: record.slug,
    homeRegion: Option.getOrNull(record.homeRegion),
    suspended: Option.isSome(record.suspendedAt),
    suspendedAt: Option.match(record.suspendedAt, {
      onNone: () => null,
      onSome: DateTime.formatIso,
    }),
    createdAt: DateTime.formatIso(record.createdAt),
  });

const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: admin.tenants group reached with a non-User principal: ${principal._tag}`,
    );
  }
  return principal;
});

export const AdminTenantsHandlers = HttpApiBuilder.group(
  AdminTenantsApi.AdminTenantsApi,
  "admin.tenants",
  Effect.fnUntraced(function* (handlers) {
    const tenants = yield* AdminTenants;
    return handlers.handleAll({
      listOrganizations: Effect.fnUntraced(function* ({
        query,
      }: {
        query: AdminTenantsApi.ListOrganizationsQuery;
      }) {
        const caller = yield* currentUserPrincipal;
        const page = yield* tenants.listOrganizations(caller, {
          cursor: query.cursor,
          limit: query.limit,
        });
        return new AdminTenantsApi.TenantOrganizationPageDto({
          items: page.items.map(toOrganizationDto),
          nextCursor: Option.getOrNull(page.nextCursor),
        });
      }),
      getOrganization: Effect.fnUntraced(function* ({
        params,
      }: {
        params: AdminTenantsApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        return toOrganizationDto(yield* tenants.getOrganization(caller, params.organizationId));
      }),
      suspendOrganization: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminTenantsApi.OrganizationIdParams;
        payload: AdminTenantsApi.SuspendOrganizationPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        return toOrganizationDto(
          yield* tenants.suspendOrganization(caller, params.organizationId, {
            reason: payload.reason,
          }),
        );
      }),
      unsuspendOrganization: Effect.fnUntraced(function* ({
        params,
      }: {
        params: AdminTenantsApi.OrganizationIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        return toOrganizationDto(
          yield* tenants.unsuspendOrganization(caller, params.organizationId),
        );
      }),
    });
  }),
);

/** ADR-EA-018: the default page size when a caller names no `limit`. */
const DEFAULT_PAGE_SIZE = 50;

export class AdminTenants extends AuthPlugin.Service<AdminTenants, AdminTenantsShape>()(
  "admin.tenants",
  {
    apiVersion: 1,
    contract: AdminTenantsApi.AdminTenantsApi,
  },
) {
  static readonly layer = AuthPlugin.layer(AdminTenants, {
    dependsOn: [Organization.Organization],
    handlers: AdminTenantsHandlers,
    make: Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      // EP-007: the tenant-administration gate is read per operation (see `Admin.layer`).
      const builtAdminConfig = yield* AdminConfig;
      const configNow = Tenant.configInForce(AdminConfig, builtAdminConfig);

      /** Gate first, existence second — a caller who fails the gate cannot probe which ids exist. */
      const authorize = Effect.fnUntraced(function* (
        caller: Api.UserPrincipal,
        action: string,
        organizationId: Option.Option<string>,
      ) {
        const adminConfig = yield* configNow;
        const allowed = yield* adminConfig.canAdministerTenants({
          admin: makeSubject({ id: caller.ref.id }),
          organizationId,
        });
        if (!allowed) {
          yield* events.publish({
            _tag: "auth.admin.actionDenied",
            adminUserId: Users.UserId(caller.ref.id),
            action,
          });
          return yield* Effect.fail(new AdminApi.AdminActionDenied());
        }
      });

      const existing = (organizationId: string) =>
        orgs.findById(organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new AdminTenantsApi.AdminOrganizationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const listOrganizations: AdminTenantsShape["listOrganizations"] = Effect.fnUntraced(
        function* (caller, input) {
          yield* authorize(caller, "listOrganizations", Option.none());
          const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
          const rows = yield* orgs.listPage({
            after: Option.fromNullishOr(input?.cursor),
            limit: limit + 1,
          });
          const items = rows.slice(0, limit);
          const last = items.at(-1);
          return {
            items,
            nextCursor:
              rows.length > limit && last !== undefined
                ? Option.some({ createdAt: last.createdAt, id: last.id })
                : Option.none(),
          };
        },
      );

      const getOrganization: AdminTenantsShape["getOrganization"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* authorize(caller, "getOrganization", Option.some(organizationId));
          return yield* existing(organizationId);
        },
      );

      const suspendOrganization: AdminTenantsShape["suspendOrganization"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* authorize(caller, "suspendOrganization", Option.some(organizationId));
          const current = yield* existing(organizationId);
          const suspended = Option.isSome(current.suspendedAt)
            ? current
            : yield* DateTime.now.pipe(
                Effect.flatMap((now) => orgs.setSuspended(organizationId, Option.some(now))),
                Effect.catchTag("OrganizationRecordNotFound", () =>
                  Effect.fail(new AdminTenantsApi.AdminOrganizationNotFound()),
                ),
              );
          yield* events.publish({
            _tag: "auth.admin.organizationSuspended",
            adminUserId: Users.UserId(caller.ref.id),
            organizationId,
            reason: input.reason?.trim() ?? null,
          });
          return suspended;
        },
      );

      const unsuspendOrganization: AdminTenantsShape["unsuspendOrganization"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* authorize(caller, "unsuspendOrganization", Option.some(organizationId));
          yield* existing(organizationId);
          const reinstated = yield* orgs
            .setSuspended(organizationId, Option.none())
            .pipe(
              Effect.catchTag("OrganizationRecordNotFound", () =>
                Effect.fail(new AdminTenantsApi.AdminOrganizationNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.admin.organizationUnsuspended",
            adminUserId: Users.UserId(caller.ref.id),
            organizationId,
          });
          return reinstated;
        },
      );

      return AdminTenants.of({
        listOrganizations,
        getOrganization,
        suspendOrganization,
        unsuspendOrganization,
      });
    }),
  });
}
