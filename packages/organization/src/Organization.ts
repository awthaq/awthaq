// @awthaq/organization — Organization
//
// spec.md. `Auth.make([Organization])` composes: `dependsOn` is left unset
// on `AuthPlugin.layer` — `Users`/`AuthEvents` are core domain services this
// plugin's own `make` Effect simply `yield*`s directly, the same
// established convention `@awthaq/admin`'s own `Admin.ts` documents.
//
// This plugin never depends on `@awthaq/qadi` (stratum ordering,
// mirroring `Admin.ts`'s own header comment) — its own endpoint gating is
// entirely self-contained via `PermissionEngine.ts`, not a qadi round trip.
// Ticket 18 (a later phase) adds this plugin's own qadi `Layer`
// contributions (`Organization.relationships`/`Organization.attributes`)
// as a separate, additive export — this file does not need to anticipate
// their shape.

import { Api } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  HookPoint,
  Users,
} from "@awthaq/core";
import { Defects, Mailer, SqlTransaction } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as InvitationRecords from "./InvitationRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationActor from "./OrganizationActor.ts";
import * as OrganizationApi from "./OrganizationApi.ts";
import * as OrganizationAuthority from "./OrganizationAuthority.ts";
import { OrganizationConfig } from "./OrganizationConfig.ts";
import * as OrganizationHandlers from "./OrganizationHandlers.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import { organizationMigrations } from "./OrganizationMigrations.ts";
import { organizationErasure, organizationExport } from "./OrganizationPersonalData.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationInvitations from "./OrganizationInvitations.ts";
import * as OrganizationMembers from "./OrganizationMembers.ts";
import * as OrganizationSystem from "./OrganizationSystem.ts";
import * as OrganizationTeams from "./OrganizationTeams.ts";
import type { OrganizationShape } from "./OrganizationShape.ts";
import { limitsOf as resolveLimits } from "./internal/limits.ts";
import { ownsEmail } from "./internal/invitee.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";

// ---- cross-organization witnesses (plan 05, ADR-EA-018 decision 10) ----------------------
//
// Every records method that reads or writes across organizations takes a `CrossTenant` witness,
// minted here with the reason it is sound, so the justification lives next to the call (the regex
// guard `TenantScoping.test.ts` kept it in an allowlist far from the code). A method keyed by an
// organization id takes no witness: the key is the scope.

// The plugin's configuration, its authorized interface, its handlers and its personal-data parts
// live in their own files; re-exported so `Organization.<name>` keeps resolving.
export * from "./OrganizationConfig.ts";
export type { OrganizationShape } from "./OrganizationShape.ts";
export { organizationErasure, organizationExport } from "./OrganizationPersonalData.ts";

// EP-001 (ADR-EA-018): the opt-in tenant middleware, reachable as `Organization.tenantMiddleware`.
export {
  layer as tenantMiddleware,
  layerWithConfig as tenantMiddlewareWithConfig,
  layerWithConfigAndRls as tenantMiddlewareWithConfigAndRls,
  layerWithRls as tenantMiddlewareWithRls,
} from "./TenantMiddleware.ts";

/**
 * What `contributes` requires beyond the plugin's own records: the erasure and export registries
 * (a composition without them does not compile). Named here so the layer's inferred type can be
 * emitted, which needs both namespaces in scope.
 */
export type PersonalDataRegistries = Erasure.ErasureRegistry | DataExport.DataExportRegistry;

// ---- plugin ---------------------------------------------------------------------

export class Organization extends AuthPlugin.Service<Organization, OrganizationShape>()(
  "organization",
  {
    apiVersion: 1,
    contract: OrganizationApi.OrganizationApi,
    migrations: organizationMigrations,
    config: [ConfigDescriptor.make(OrganizationConfig)],
    tables: {
      organization_org: AuthPlugin.Table.keyed("id"),
      organization_membership: AuthPlugin.Table.keyed("organizationId"),
      organization_invitation: AuthPlugin.Table.keyed("organizationId"),
      organization_team: AuthPlugin.Table.keyed("organizationId"),
      organization_team_membership: AuthPlugin.Table.derived("organization_team", "teamId"),
      organization_team_closure: AuthPlugin.Table.derived("organization_team", "descendantId"),
      organization_role: AuthPlugin.Table.keyed("organizationId"),
      organization_active_context: AuthPlugin.Table.derived("sessions", "sessionId"),
      organization_oauth_connection: AuthPlugin.Table.keyed("organizationId"),
      organization_oauth_connection_domain: AuthPlugin.Table.keyed("organizationId"),
    },
  },
) {
  static readonly layer = AuthPlugin.layer(Organization, {
    ports: [Mailer.Mailer, SqlTransaction.SqlTransaction],
    exposes: { services: OrganizationSystem.services, layer: OrganizationSystem.layer },
    handlers: OrganizationHandlers.make(Organization),
    contributes: Layer.mergeAll(organizationErasure, organizationExport),
    make: Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const members = yield* MembershipRecords.MembershipRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
      const teams = yield* TeamRecords.TeamRecords;
      // ADR-EA-040: the plugin's system interfaces, built beneath this `make` by `exposes`.
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const teamSystem = yield* OrganizationTeams.OrganizationTeams;
      const memberSystem = yield* OrganizationMembers.OrganizationMembers;
      const invitationSystem = yield* OrganizationInvitations.OrganizationInvitations;
      const users = yield* Users.Users;
      // OHS-002: the cascades below commit or roll back as one unit. `layerNoop`
      // for an in-memory composition, `layerSql` over the real client otherwise.
      // EP-007 (ADR-EA-018): the configuration in force is decided per operation, not frozen at
      // layer build. A `provideService(OrganizationConfig, ...)` in the *calling* fiber (the tenant
      // middleware does this from a `TenantConfig`) overrides for that request; with none, the
      // build-time value applies exactly as before — so `Layer.provide(Organization.config(...))`
      // keeps meaning what it always meant.
      const builtConfig = yield* OrganizationConfig;
      const configNow = Effect.contextWith((context: Context.Context<never>) =>
        Effect.succeed(Context.getOrUndefined(context, OrganizationConfig) ?? builtConfig),
      );
      const beforeCreateRole = yield* OrganizationHooks.BeforeCreateRole;
      const afterCreateRole = yield* OrganizationHooks.AfterCreateRole;
      const beforeUpdateRoleHook = yield* OrganizationHooks.BeforeUpdateRole;
      const afterUpdateRoleHook = yield* OrganizationHooks.AfterUpdateRole;
      const beforeDeleteRole = yield* OrganizationHooks.BeforeDeleteRole;
      const afterDeleteRole = yield* OrganizationHooks.AfterDeleteRole;

      const effectivePermissionsOf = authority.effectivePermissions;

      /**
       * `teamId`, when given, widens the check for the `team` resource with the
       * caller's team-scoped roles (`OrganizationAuthority.teamAuthority`) — org-level statements are
       * always the default, a team role only ever adds.
       */
      const requirePermission = (
        callerId: Users.UserId,
        organizationId: string,
        resource: string,
        action: string,
        teamId?: string,
      ) =>
        Effect.gen(function* () {
          // PERS-005: every PermissionEngine denial leaves a durable who/what/why.
          const denied = (reason: "notMember" | "missingStatement") =>
            events.publish({
              _tag: "auth.organization.permissionDenied",
              organizationId,
              userId: callerId,
              resource,
              action,
              reason,
            });
          const membership = yield* members.findByUserAndOrg(callerId, organizationId);
          if (Option.isNone(membership)) {
            yield* denied("notMember");
            return yield* Effect.fail(new OrganizationApi.OrganizationNotFound());
          }
          const orgEffective = yield* effectivePermissionsOf(organizationId, membership.value);
          const effective =
            teamId !== undefined && resource === "team"
              ? PermissionEngine.mergeStatements(
                  orgEffective,
                  yield* authority.teamAuthority(callerId, organizationId, teamId),
                )
              : orgEffective;
          if (!PermissionEngine.hasPermission(effective, resource, action)) {
            yield* denied("missingStatement");
            return yield* Effect.fail(new OrganizationApi.OrganizationPermissionDenied());
          }
          return membership.value;
        });

      /** Fails `OrganizationNotFound` (MTI-009) if the caller isn't a member — no statement check, for read endpoints any member may use. */
      const requireMembership = (callerId: Users.UserId, organizationId: string) =>
        members.findByUserAndOrg(callerId, organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrganizationNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      /**
       * EP-003 (ADR-EA-018): a suspended organization answers exactly like an
       * unknown one (MTI-009 — a denial never reveals a tenant), for members and
       * outsiders alike; only the platform administrator's surface reads it.
       * `list` still returns it, flagged `suspended`, so a member sees why.
       */
      const requireOrganization = directory.requireActive;

      /** EP-006: the static limits with this organization's `limitsFor` overrides merged over them. */
      const limitsOf = (organizationId: string) =>
        Effect.flatMap(configNow, (orgConfig) => resolveLimits(orgConfig, organizationId));

      // ---- organizations: authorization on top of `OrganizationDirectory` ---------------------

      const create: OrganizationShape["create"] = Effect.fnUntraced(function* ({
        caller,
        name,
        slug,
        logo,
        metadata,
        homeRegion,
      }) {
        const callerId = Users.UserId(caller.ref.id);
        // Who may create at all is authorization; the region, the quota, the veto and the
        // organization with its creator's membership are the Directory's.
        const allowed = yield* (yield* configNow).allowUserToCreateOrganization(callerId);
        if (!allowed) return yield* new OrganizationApi.OrganizationCreationNotAllowed();
        return yield* directory.create(OrganizationActor.user(caller), {
          owner: callerId,
          name,
          slug,
          logo,
          metadata,
          homeRegion,
        });
      });

      const checkSlug: OrganizationShape["checkSlug"] = directory.isSlugAvailable;

      const list: OrganizationShape["list"] = (caller) =>
        directory.listForUser(Users.UserId(caller.ref.id));

      const get: OrganizationShape["get"] = Effect.fnUntraced(function* (caller, organizationId) {
        const record = yield* requireOrganization(organizationId);
        yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
        return record;
      });

      const getFull: OrganizationShape["getFull"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const record = yield* requireOrganization(organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          const memberRows = yield* memberSystem.list(organizationId, {
            limit: input?.membersLimit,
            offset: input?.membersOffset,
          });
          const invitationRows = yield* invitationSystem.listPendingForOrganization(organizationId);
          return { organization: record, members: memberRows, invitations: invitationRows };
        },
      );

      const update: OrganizationShape["update"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "organization",
            "update",
          );
          return yield* directory.update(OrganizationActor.user(caller), {
            organizationId,
            ...input,
          });
        },
      );

      const delete_: OrganizationShape["delete"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "organization",
            "delete",
          );
          yield* directory.delete(OrganizationActor.user(caller), { organizationId });
        },
      );

      // ---- members: authorization on top of `OrganizationMembers` ----------------------------
      //
      // Visibility (MTI-009), the `member:*` statements and the caller's grant ceiling are decided
      // here; the owner invariant, role names, the veto, the transaction and the events are the
      // module's, once, for every caller (SCIM and SAML included).

      const listMembers: OrganizationShape["listMembers"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          return yield* memberSystem.list(organizationId, input);
        },
      );

      const removeMember: OrganizationShape["removeMember"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId) {
          yield* requireOrganization(organizationId);
          // MTI-009: a non-member learns nothing about who else is in the organization.
          const callerId = Users.UserId(caller.ref.id);
          yield* requireMembership(callerId, organizationId);
          // D4: the statement check comes first, so a caller without `member:delete` cannot probe
          // whether a member is the last owner.
          yield* requirePermission(callerId, organizationId, "member", "delete");
          yield* memberSystem.remove(OrganizationActor.user(caller), {
            organizationId,
            userId: targetUserId,
          });
        },
      );

      const updateMemberRole: OrganizationShape["updateMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId, role) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requireMembership(callerId, organizationId);
          const granter = yield* requirePermission(callerId, organizationId, "member", "update");
          const { membership } = yield* memberSystem
            .setRoles(OrganizationActor.user(caller), {
              organizationId,
              userId: targetUserId,
              roles: role,
              bound: OrganizationActor.Bound.Ceiling({
                statements: yield* effectivePermissionsOf(organizationId, granter),
              }),
              ifAbsent: "fail",
            })
            .pipe(
              // Only `ifAbsent: "add"` can raise these.
              Effect.catchTags({ AlreadyMember: Effect.die, MembershipLimitReached: Effect.die }),
            );
          return membership;
        },
      );

      const leave: OrganizationShape["leave"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          // PV-300 (MTI-009): a non-member leaving is answered exactly like an unknown id.
          yield* requireMembership(callerId, organizationId);
          yield* memberSystem.remove(OrganizationActor.user(caller), {
            organizationId,
            userId: callerId,
          });
        },
      );

      const activeOrganizationOf = (caller: Api.UserPrincipal) =>
        activeContext.findBySessionId(caller.sessionId).pipe(
          Effect.map(Option.flatMap((row) => row.activeOrganizationId)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.NoActiveOrganization()),
              onSome: Effect.succeed,
            }),
          ),
        );

      /** EP-003: the active-context paths read memberships directly, so they check suspension themselves. */
      const isSuspended = (organizationId: string) =>
        directory
          .find(organizationId)
          .pipe(
            Effect.map((found) => Option.isSome(found) && Option.isSome(found.value.suspendedAt)),
          );

      const getActiveMember: OrganizationShape["getActiveMember"] = Effect.fnUntraced(
        function* (caller) {
          const organizationId = yield* activeOrganizationOf(caller);
          if (yield* isSuspended(organizationId)) {
            return yield* Effect.fail(new OrganizationApi.NoActiveOrganization());
          }
          const membership = yield* members.findByUserAndOrg(
            Users.UserId(caller.ref.id),
            organizationId,
          );
          if (Option.isNone(membership))
            return yield* Effect.fail(new OrganizationApi.NoActiveOrganization());
          return membership.value;
        },
      );

      const getActiveMemberRole: OrganizationShape["getActiveMemberRole"] = (caller) =>
        getActiveMember(caller).pipe(Effect.map((membership) => membership.role));

      const setActive: OrganizationShape["setActive"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          const callerId = Users.UserId(caller.ref.id);
          if (organizationId === null) {
            return yield* activeContext.unsetOrganization(caller.sessionId, callerId);
          }
          const membership = yield* members.findByUserAndOrg(callerId, organizationId);
          if (Option.isNone(membership) || (yield* isSuspended(organizationId)))
            return yield* Effect.fail(new OrganizationApi.MembershipNotFound());
          // MTI-001: the membership record is the witness the setter requires.
          return yield* activeContext.setOrganization(caller.sessionId, membership.value);
        },
      );

      /**
       * CWM-003: the stored pointers are re-validated on read — a row whose
       * organization/team the user no longer belongs to (a membership removed
       * around this plugin, or a row that predates the `userId` column, which
       * the cascade could not find) reads as cleared, and is cleared for real.
       */
      const revalidateActive = Effect.fnUntraced(function* (
        caller: Api.UserPrincipal,
        row: ActiveContextRecords.ActiveContextRecord,
      ) {
        const callerId = Users.UserId(caller.ref.id);
        let stale = false;
        if (Option.isSome(row.activeOrganizationId)) {
          const membership = yield* members.findByUserAndOrg(
            callerId,
            row.activeOrganizationId.value,
          );
          if (Option.isNone(membership)) {
            yield* activeContext.unsetOrganization(caller.sessionId, callerId);
            yield* activeContext.unsetTeam(caller.sessionId, callerId);
            stale = true;
          }
        }
        if (!stale && Option.isSome(row.activeTeamId)) {
          const onTeam = yield* teams.findTeamMembership(row.activeTeamId.value, callerId);
          if (Option.isNone(onTeam)) {
            yield* activeContext.unsetTeam(caller.sessionId, callerId);
            stale = true;
          }
        }
        if (!stale) return row;
        const refreshed = yield* activeContext.findBySessionId(caller.sessionId);
        return Option.getOrElse(refreshed, () => row);
      });

      const getActive: OrganizationShape["getActive"] = Effect.fnUntraced(function* (caller) {
        const existing = yield* activeContext.findBySessionId(caller.sessionId);
        if (Option.isSome(existing)) return yield* revalidateActive(caller, existing.value);
        const now = yield* DateTime.now;
        const empty: ActiveContextRecords.ActiveContextRecord = {
          sessionId: caller.sessionId,
          userId: Option.some(caller.ref.id),
          activeOrganizationId: Option.none(),
          activeTeamId: Option.none(),
          updatedAt: now,
        };
        return empty;
      });

      // ---- invitations: authorization on top of `OrganizationInvitations` -------------------
      //
      // Who may invite (`invitation:create`, and the grant ceiling the invitation may confer) and who may
      // cancel (`invitation:cancel`, after MTI-009) is decided here; the capability token, expiry, limits,
      // the transaction, hooks and events are the module's. The invitee's own acts (accept, reject) are not
      // an authorization decision: the emailed token plus the invitee's address are the capability.

      const invite: OrganizationShape["invite"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          const inviter = yield* requirePermission(
            callerId,
            organizationId,
            "invitation",
            "create",
          );
          return yield* invitationSystem.create(OrganizationActor.user(caller), {
            organizationId,
            inviterId: callerId,
            email: input.email,
            role: input.role,
            teamId: input.teamId,
            resend: input.resend,
            bound: OrganizationActor.Bound.Ceiling({
              statements: yield* effectivePermissionsOf(organizationId, inviter),
            }),
          });
        },
      );

      const acceptInvitation: OrganizationShape["acceptInvitation"] = (
        caller,
        invitationId,
        token,
      ) => invitationSystem.accept({ invitationId, token, userId: Users.UserId(caller.ref.id) });

      const rejectInvitation: OrganizationShape["rejectInvitation"] = (
        caller,
        invitationId,
        token,
      ) => invitationSystem.reject({ invitationId, token, userId: Users.UserId(caller.ref.id) });

      const cancelInvitation: OrganizationShape["cancelInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          // MTI-009: a non-member must not be able to tell an existing invitation (or its status) from
          // an unknown one, so membership is checked before the pending check and answers the
          // unknown-invitation error.
          const callerId = Users.UserId(caller.ref.id);
          const found = yield* invitationSystem.find(invitationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrganizationApi.InvitationNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const callerMembership = yield* members.findByUserAndOrg(callerId, found.organizationId);
          if (Option.isNone(callerMembership)) {
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          }
          if (found.status !== "pending") {
            return yield* Effect.fail(new OrganizationApi.InvitationNotPending());
          }
          yield* requirePermission(callerId, found.organizationId, "invitation", "cancel").pipe(
            // Membership was just proven; a racing removal reads as "no such invitation".
            Effect.catchTag("OrganizationNotFound", () =>
              Effect.fail(new OrganizationApi.InvitationNotFound()),
            ),
          );
          // D6: the veto runs after the authorization above.
          yield* invitationSystem.cancel(OrganizationActor.user(caller), { invitationId });
        },
      );

      /** True iff `callerId` is the invitee (email match) or a member of the invitation's organization holding `invitation:create`. */
      const mayReadInvitation = (
        callerId: Users.UserId,
        record: InvitationRecords.InvitationRecord,
      ) =>
        Effect.gen(function* () {
          const membership = yield* members.findByUserAndOrg(callerId, record.organizationId);
          if (Option.isSome(membership)) {
            const effective = yield* effectivePermissionsOf(
              record.organizationId,
              membership.value,
            );
            if (PermissionEngine.hasPermission(effective, "invitation", "create")) return true;
          }
          const user = yield* users
            .findById(callerId)
            .pipe(Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)));
          return user !== undefined && ownsEmail(user, record.email);
        });

      const getInvitation: OrganizationShape["getInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          const found = yield* invitationSystem.find(invitationId);
          if (Option.isNone(found))
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          const allowed = yield* mayReadInvitation(Users.UserId(caller.ref.id), found.value);
          if (!allowed) return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          return found.value;
        },
      );

      const getInvitationByToken: OrganizationShape["getInvitationByToken"] = Effect.fnUntraced(
        function* (caller, token) {
          const found = yield* invitationSystem.findByToken(token);
          if (Option.isNone(found))
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          const user = yield* users
            .findById(Users.UserId(caller.ref.id))
            .pipe(Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)));
          if (user === undefined || !ownsEmail(user, found.value.email)) {
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          }
          return found.value;
        },
      );

      const listInvitationsForOrganization: OrganizationShape["listInvitationsForOrganization"] = (
        caller,
        organizationId,
      ) =>
        requireOrganization(organizationId).pipe(
          Effect.flatMap(() => requireMembership(Users.UserId(caller.ref.id), organizationId)),
          Effect.flatMap(() => invitationSystem.listForOrganization(organizationId)),
        );

      const listInvitationsForUser: OrganizationShape["listInvitationsForUser"] = (caller) =>
        invitationSystem.listForUser(Users.UserId(caller.ref.id));

      // ---- dynamic access control -----------------------------------------------

      const requireDynamicAccessControlEnabled = Effect.flatMap(configNow, (orgConfig) =>
        orgConfig.dynamicAccessControl.enabled
          ? Effect.void
          : Effect.fail(new OrganizationApi.DynamicAccessControlDisabled()),
      );

      const createRole: OrganizationShape["createRole"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          const callerId = Users.UserId(caller.ref.id);
          const membership = yield* requirePermission(callerId, organizationId, "role", "create");

          // RZS-005/N8: a dynamic role never takes a built-in tier's name or an
          // application-defined static role's name.
          if (
            PermissionEngine.isBuiltInRole(input.role) ||
            Object.hasOwn((yield* configNow).permissionStatements, input.role)
          ) {
            return yield* Effect.fail(new OrganizationApi.ReservedOrgRoleName());
          }

          const granterPermissions = yield* effectivePermissionsOf(organizationId, membership);
          if (!PermissionEngine.canGrant(input.permission, granterPermissions)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }

          const count = yield* orgRoles.countByOrganization(organizationId);
          if (count >= (yield* limitsOf(organizationId)).maximumRolesPerOrganization) {
            return yield* Effect.fail(new OrganizationApi.RoleLimitReached());
          }

          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateRole)(
            beforeCreateRole.run({
              actor: OrganizationActor.user(caller),
              organizationId,
              role: input.role,
            }),
          );

          const record = yield* orgRoles
            .create({ organizationId, role: vetoed.role, permission: input.permission })
            .pipe(
              Effect.catchTag("OrgRoleRecordNameTaken", () =>
                Effect.fail(new OrganizationApi.OrgRoleNameTaken()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.roleCreated",
            organizationId,
            role: record.role,
          });
          yield* afterCreateRole.run({
            actor: OrganizationActor.user(caller),
            organizationId,
            role: record.role,
            roleId: record.id,
          });
          return record;
        },
      );

      const listRoles: OrganizationShape["listRoles"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "role", "read");
          return yield* orgRoles.listByOrganization(organizationId);
        },
      );

      const requireOrgRole = (organizationId: string, roleId: string) =>
        orgRoles.findById(organizationId, roleId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrgRoleNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const getRole: OrganizationShape["getRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "role", "read");
          return yield* requireOrgRole(organizationId, roleId);
        },
      );

      const updateRole: OrganizationShape["updateRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId, permission) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          const membership = yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "role",
            "update",
          );
          yield* requireOrgRole(organizationId, roleId);

          const granterPermissions = yield* effectivePermissionsOf(organizationId, membership);
          if (!PermissionEngine.canGrant(permission, granterPermissions)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }

          yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateRole)(
            beforeUpdateRoleHook.run({
              actor: OrganizationActor.user(caller),
              organizationId,
              roleId,
            }),
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
          yield* afterUpdateRoleHook.run({
            actor: OrganizationActor.user(caller),
            organizationId,
            roleId,
          });
          return updated;
        },
      );

      const deleteRole: OrganizationShape["deleteRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId) {
          yield* requireOrganization(organizationId);
          yield* requireDynamicAccessControlEnabled;
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "role", "delete");
          const existing = yield* requireOrgRole(organizationId, roleId);
          yield* HookPoint.aborted(OrganizationHooks.BeforeDeleteRole)(
            beforeDeleteRole.run({ actor: OrganizationActor.user(caller), organizationId, roleId }),
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
          yield* afterDeleteRole.run({
            actor: OrganizationActor.user(caller),
            organizationId,
            roleId,
          });
        },
      );

      // ---- teams: authorization on top of `OrganizationTeams` ------------------------
      //
      // Every method below is a guard plus a delegate: MTI-009 visibility, the `teams.enabled` gate
      // in PV-300 order, `requirePermission` (with its PERS-005 denial event) and, for a roster
      // role, the caller's grant ceiling as a `Bound`. What a team operation means (quotas, the
      // last-team rule, vetoes, the transaction, events) lives in `OrganizationTeams`, once, for
      // every caller (SCIM Groups included).

      /**
       * PV-300 (MTI-009): the membership gate comes *before* the feature gate. A
       * non-member must get `OrganizationNotFound` whether or not teams are enabled,
       * or `TeamsDisabled` (403) versus `OrganizationNotFound` (404) tells an outsider
       * which organization ids exist.
       */
      const requireTeamsFor = (callerId: Users.UserId, organizationId: string) =>
        requireMembership(callerId, organizationId).pipe(Effect.andThen(teamSystem.requireEnabled));

      /**
       * OHS-004: what the caller may confer on a team roster is what their organization roles
       * and their team roles on this team (or an ancestor) grant, merged.
       */
      const teamCeiling = Effect.fnUntraced(function* (
        granter: MembershipRecords.MembershipRecord,
        organizationId: string,
        teamId: string,
      ) {
        return OrganizationActor.Bound.Ceiling({
          statements: PermissionEngine.mergeStatements(
            yield* effectivePermissionsOf(organizationId, granter),
            yield* authority.teamAuthority(granter.userId, organizationId, teamId),
          ),
        });
      });

      const createTeam: OrganizationShape["createTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, name, parentId) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requireTeamsFor(callerId, organizationId);
          // OHS-004: a nested team needs `team:create` on its parent (a team role held
          // on the parent or an ancestor suffices); a root team needs it org-level.
          yield* requirePermission(callerId, organizationId, "team", "create", parentId);
          const { team } = yield* teamSystem
            .create(OrganizationActor.user(caller), { organizationId, name, parentId })
            .pipe(
              // Only an `initialMembers` roster can raise these; this method has none.
              Effect.catchTags({
                MembershipNotFound: Effect.die,
                TeamMemberLimitReached: Effect.die,
              }),
            );
          return team;
        },
      );

      const moveTeam: OrganizationShape["moveTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, parentId) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requireTeamsFor(callerId, organizationId);
          // OHS-004: authority over the team *and* over its destination — a move can
          // hand a subtree to another team's leads, so the target's own authority is
          // required too; the root is org-level.
          yield* requirePermission(callerId, organizationId, "team", "update", teamId);
          yield* requirePermission(
            callerId,
            organizationId,
            "team",
            "update",
            Option.getOrUndefined(parentId),
          );
          return yield* teamSystem.move(OrganizationActor.user(caller), {
            organizationId,
            teamId,
            parentId,
          });
        },
      );

      // OHS-001: relatives are read like `listTeams` — member-only, never public.
      const listTeamAncestors: OrganizationShape["listTeamAncestors"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          return yield* teamSystem.ancestors(organizationId, teamId);
        },
      );

      const listTeamDescendants: OrganizationShape["listTeamDescendants"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          return yield* teamSystem.descendants(organizationId, teamId);
        },
      );

      const listTeams: OrganizationShape["listTeams"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          // MTI-002: any authenticated principal could otherwise enumerate another tenant's team
          // names and counts — `requireTeamsFor` makes the read member-only.
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          return yield* teamSystem.list(organizationId);
        },
      );

      const listUserTeams: OrganizationShape["listUserTeams"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          return yield* teamSystem.listForUser(organizationId, Users.UserId(caller.ref.id));
        },
      );

      const updateTeam: OrganizationShape["updateTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, name) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requireTeamsFor(callerId, organizationId);
          yield* requirePermission(callerId, organizationId, "team", "update", teamId);
          return yield* teamSystem.rename(OrganizationActor.user(caller), {
            organizationId,
            teamId,
            name,
          });
        },
      );

      const removeTeam: OrganizationShape["removeTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requireTeamsFor(callerId, organizationId);
          yield* requirePermission(callerId, organizationId, "team", "delete", teamId);
          yield* teamSystem.remove(OrganizationActor.user(caller), { organizationId, teamId });
        },
      );

      const listTeamMembers: OrganizationShape["listTeamMembers"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          // MTI-002: a team roster is personal data about another tenant's staff — member-only.
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          return yield* teamSystem.members(organizationId, teamId);
        },
      );

      const addTeamMember: OrganizationShape["addTeamMember"] = Effect.fnUntraced(function* (
        caller,
        organizationId,
        teamId,
        targetUserId,
        role = ["member"],
      ) {
        yield* requireOrganization(organizationId);
        const callerId = Users.UserId(caller.ref.id);
        yield* requireTeamsFor(callerId, organizationId);
        const granter = yield* requirePermission(
          callerId,
          organizationId,
          "team",
          "update",
          teamId,
        );
        return yield* teamSystem.addMember(OrganizationActor.user(caller), {
          organizationId,
          teamId,
          userId: targetUserId,
          role,
          bound: yield* teamCeiling(granter, organizationId, teamId),
        });
      });

      const updateTeamMemberRole: OrganizationShape["updateTeamMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId, role) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requireTeamsFor(callerId, organizationId);
          const granter = yield* requirePermission(
            callerId,
            organizationId,
            "team",
            "update",
            teamId,
          );
          return yield* teamSystem.setMemberRole(OrganizationActor.user(caller), {
            organizationId,
            teamId,
            userId: targetUserId,
            role,
            bound: yield* teamCeiling(granter, organizationId, teamId),
          });
        },
      );

      const removeTeamMember: OrganizationShape["removeTeamMember"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requireTeamsFor(callerId, organizationId);
          yield* requirePermission(callerId, organizationId, "team", "update", teamId);
          yield* teamSystem.removeMember(OrganizationActor.user(caller), {
            organizationId,
            teamId,
            userId: targetUserId,
          });
        },
      );

      const setActiveTeam: OrganizationShape["setActiveTeam"] = Effect.fnUntraced(
        function* (caller, teamId) {
          const callerId = Users.UserId(caller.ref.id);
          if (teamId === null) {
            return yield* activeContext.unsetTeam(caller.sessionId, callerId);
          }
          const membership = yield* teams.findTeamMembership(teamId, callerId);
          if (Option.isNone(membership)) {
            return yield* Effect.fail(new OrganizationApi.TeamMembershipNotFound());
          }
          // MTI-001: the team-membership record is the witness the setter requires.
          return yield* activeContext.setTeam(caller.sessionId, membership.value);
        },
      );

      return Organization.of({
        create,
        checkSlug,
        list,
        get,
        getFull,
        update,
        delete: delete_,
        listMembers,
        removeMember,
        updateMemberRole,
        leave,
        getActiveMember,
        getActiveMemberRole,
        setActive,
        getActive,
        invite,
        acceptInvitation,
        rejectInvitation,
        cancelInvitation,
        getInvitation,
        getInvitationByToken,
        listInvitationsForOrganization,
        listInvitationsForUser,
        createRole,
        listRoles,
        getRole,
        updateRole,
        deleteRole,
        createTeam,
        moveTeam,
        listTeamAncestors,
        listTeamDescendants,
        listTeams,
        listUserTeams,
        updateTeam,
        removeTeam,
        listTeamMembers,
        addTeamMember,
        updateTeamMemberRole,
        removeTeamMember,
        setActiveTeam,
      });
    }),
  });
}
