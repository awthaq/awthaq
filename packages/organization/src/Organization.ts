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
import { Defects, Hmac, Mailer, SqlTransaction } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import * as OrganizationMembers from "./OrganizationMembers.ts";
import * as OrganizationSystem from "./OrganizationSystem.ts";
import * as OrganizationTeams from "./OrganizationTeams.ts";
import type { OrganizationShape } from "./OrganizationShape.ts";
import { limitsOf as resolveLimits } from "./internal/limits.ts";
import { hexOf, NO_INVITATION_TOKEN_HASH } from "./internal/tokens.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";

// ---- cross-organization witnesses (plan 05, ADR-EA-018 decision 10) ----------------------
//
// Every records method that reads or writes across organizations takes a `CrossTenant` witness,
// minted here with the reason it is sound, so the justification lives next to the call (the regex
// guard `TenantScoping.test.ts` kept it in an allowlist far from the code). A method keyed by an
// organization id takes no witness: the key is the scope.

/** The invitation id alone is the capability. */
const invitationIdGrant = TenantScoped.crossTenant(
  "organization: the invitation id is the capability; acceptance re-checks the invitee's email",
);
/** The emailed token's hash is the capability. */
const invitationTokenGrant = TenantScoped.crossTenant(
  "organization: the emailed token's hash is the capability; the landing lookup then checks the invitee's email",
);
/** An invitee's own pending invitations, whichever organizations sent them. */
const inviteeGrant = TenantScoped.crossTenant(
  "organization: the invitee's own pending invitations, keyed by their verified email",
);
/** The per-inviter quota is deployment-wide. */
const inviterQuotaGrant = TenantScoped.crossTenant(
  "organization: per-inviter invitation quota, deployment-wide by design (invitationLimit)",
);

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

// ---- invitee identity ------------------------------------------------------------

/** FAMS-002: an invitation names an email address; only an Email-identity user can own one (`emailOf` is already lower-cased, as invitation emails are stored). */
const ownsEmail = (user: Users.UserRecord, email: string): boolean =>
  Option.exists(Users.emailOf(user), (own) => own === email);

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
      const invitations = yield* InvitationRecords.InvitationRecords;
      const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
      const teams = yield* TeamRecords.TeamRecords;
      // ADR-EA-040: the plugin's system interfaces, built beneath this `make` by `exposes`.
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const teamSystem = yield* OrganizationTeams.OrganizationTeams;
      const memberSystem = yield* OrganizationMembers.OrganizationMembers;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      // OHS-002: the cascades below commit or roll back as one unit. `layerNoop`
      // for an in-memory composition, `layerSql` over the real client otherwise.
      const crypto = yield* Crypto.Crypto;
      // EP-007 (ADR-EA-018): the configuration in force is decided per operation, not frozen at
      // layer build. A `provideService(OrganizationConfig, ...)` in the *calling* fiber (the tenant
      // middleware does this from a `TenantConfig`) overrides for that request; with none, the
      // build-time value applies exactly as before — so `Layer.provide(Organization.config(...))`
      // keeps meaning what it always meant.
      const builtConfig = yield* OrganizationConfig;
      const configNow = Effect.contextWith((context: Context.Context<never>) =>
        Effect.succeed(Context.getOrUndefined(context, OrganizationConfig) ?? builtConfig),
      );
      const beforeCreateInvitation = yield* OrganizationHooks.BeforeCreateInvitation;
      const afterCreateInvitation = yield* OrganizationHooks.AfterCreateInvitation;
      const beforeAccept = yield* OrganizationHooks.BeforeAcceptInvitation;
      const afterAccept = yield* OrganizationHooks.AfterAcceptInvitation;
      const beforeReject = yield* OrganizationHooks.BeforeRejectInvitation;
      const afterReject = yield* OrganizationHooks.AfterRejectInvitation;
      const beforeCancel = yield* OrganizationHooks.BeforeCancelInvitation;
      const afterCancel = yield* OrganizationHooks.AfterCancelInvitation;
      const beforeCreateRole = yield* OrganizationHooks.BeforeCreateRole;
      const afterCreateRole = yield* OrganizationHooks.AfterCreateRole;
      const beforeUpdateRoleHook = yield* OrganizationHooks.BeforeUpdateRole;
      const afterUpdateRoleHook = yield* OrganizationHooks.AfterUpdateRole;
      const beforeDeleteRole = yield* OrganizationHooks.BeforeDeleteRole;
      const afterDeleteRole = yield* OrganizationHooks.AfterDeleteRole;

      const statementsByRole = authority.statementsByRole;
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

      /**
       * RRM-001/RRM-002: every role-assignment path stores only role names this
       * organization recognizes (built-in, static custom, or a live dynamic role).
       */
      const requireKnownRoles = (
        byRole: ReadonlyMap<string, PermissionEngine.Statements>,
        roleNames: ReadonlyArray<string>,
      ) =>
        roleNames.some((name) => !byRole.has(name))
          ? Effect.fail(new OrganizationApi.UnknownOrgRole())
          : Effect.void;

      /**
       * RRM-001/RRM-002: the same self-escalation guard `createRole`/`updateRole`
       * already apply — a granter can only confer statements it itself holds
       * (`PermissionEngine.canGrant`), over role names that actually exist.
       */
      const requireGrantable = (
        organizationId: string,
        granter: MembershipRecords.MembershipRecord,
        roleNames: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const byRole = yield* statementsByRole(organizationId);
          yield* requireKnownRoles(byRole, roleNames);
          const held = PermissionEngine.effectivePermissions(granter.role, byRole);
          const requested = PermissionEngine.effectivePermissions(roleNames, byRole);
          if (!PermissionEngine.canGrant(requested, held)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }
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
          const invitationRows = yield* invitations
            .listByOrganization(organizationId)
            .pipe(Effect.map((rows) => rows.filter((row) => row.status === "pending")));
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

      // ---- invitations --------------------------------------------------------

      const invite: OrganizationShape["invite"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const orgConfig = yield* configNow;
          const organizationRecord = yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          const inviter = yield* requirePermission(
            callerId,
            organizationId,
            "invitation",
            "create",
          );

          const pendingCount = yield* invitations.countPendingByInviter(
            inviterQuotaGrant,
            callerId,
          );
          if (pendingCount >= (yield* limitsOf(organizationId)).invitationLimit) {
            return yield* Effect.fail(new OrganizationApi.InvitationLimitReached());
          }

          if (input.teamId !== undefined) {
            if (!orgConfig.teams.enabled) {
              return yield* Effect.fail(new OrganizationApi.TeamsDisabled());
            }
            yield* requireTeam(organizationId, input.teamId);
          }

          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateInvitation)(
            beforeCreateInvitation.run({
              actor: OrganizationActor.user(caller),
              organizationId,
              email: input.email,
              role: input.role,
            }),
          );
          // RRM-002: an invitation can only confer statements the inviter holds.
          yield* requireGrantable(organizationId, inviter, vetoed.role);

          const alreadyMember = yield* users.findByEmail(vetoed.email).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none<MembershipRecords.MembershipRecord>()),
                onSome: (user) => members.findByUserAndOrg(user.id, organizationId),
              }),
            ),
          );
          const existing = yield* invitations.findPendingByEmailAndOrg(
            vetoed.email,
            organizationId,
          );

          // OHS-006: an existing member is never invited again (an invitation
          // could otherwise overwrite or duplicate the membership on accept);
          // any pending invitation for them is stale, so cancel it first.
          if (Option.isSome(alreadyMember)) {
            if (Option.isSome(existing)) {
              yield* invitations
                .updateStatus(existing.value.organizationId, existing.value.id, "canceled")
                .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
            }
            return yield* Effect.fail(new OrganizationApi.AlreadyMember());
          }

          const expiresAt = yield* DateTime.now.pipe(
            Effect.map((now) => DateTime.addDuration(now, orgConfig.invitationExpiresIn)),
          );

          // MTI-010: the mailed capability is a fresh random token (only its hash
          // is stored), never the invitation's own id.
          // EEM-002: the inviter is authenticated, so a delivery failure is
          // surfaced (the invitation stays pending; re-inviting with
          // `resend: true` retries) rather than swallowed.
          const sendInvite = (record: InvitationRecords.InvitationRecord, token: string) =>
            mailer
              .send({
                to: record.email,
                template: "organization-invite",
                data: {
                  token,
                  invitationId: record.id,
                  organizationId,
                  organizationName: organizationRecord.name,
                  // EP-005: the mail is rendered to the tenant's own users, so it
                  // carries the tenant's presentation data, not the host's.
                  organizationLogo: Option.getOrNull(organizationRecord.logo),
                  role: record.role,
                },
              })
              .pipe(
                Effect.catchTag(
                  "MailDeliveryFailed",
                  () => new OrganizationApi.InvitationDeliveryFailed({ invitationId: record.id }),
                ),
              );

          if (Option.isNone(alreadyMember) && Option.isSome(existing)) {
            if (orgConfig.cancelPendingInvitationsOnReInvite) {
              yield* invitations
                .updateStatus(existing.value.organizationId, existing.value.id, "canceled")
                .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
            } else if (input.resend) {
              // A resend mints a new token (only the hash is kept, so the old
              // mail cannot be re-sent) and retires the previous one.
              const fresh = yield* mintInvitationToken;
              const rotated = yield* invitations
                .setTokenHash(existing.value.organizationId, existing.value.id, fresh.tokenHash)
                .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
              yield* sendInvite(rotated, fresh.token);
              yield* events.publish({
                _tag: "auth.organization.invitationCreated",
                invitationId: rotated.id,
                organizationId,
              });
              return rotated;
            } else {
              return existing.value;
            }
          }

          const minted = yield* mintInvitationToken;
          const record = yield* invitations.create({
            email: vetoed.email,
            inviterId: callerId,
            organizationId,
            teamId: input.teamId,
            role: vetoed.role,
            expiresAt,
            tokenHash: minted.tokenHash,
          });
          // The record exists from here on, so its creation is published
          // before the mail attempt: a delivery failure leaves a pending
          // invitation, not a phantom one.
          yield* events.publish({
            _tag: "auth.organization.invitationCreated",
            invitationId: record.id,
            organizationId,
          });
          yield* afterCreateInvitation.run({
            actor: OrganizationActor.user(caller),
            organizationId,
            email: record.email,
            role: vetoed.role,
            invitationId: record.id,
          });
          yield* sendInvite(record, minted.token);
          return record;
        },
      );

      /** Hex SHA-256 of an invitation token — the only form of it ever stored. */
      const hashInvitationToken = (token: string) =>
        crypto
          .digest("SHA-256", new TextEncoder().encode(token))
          .pipe(Effect.map(hexOf), Effect.orDie);

      const mintInvitationToken = Effect.gen(function* () {
        const token = hexOf(yield* crypto.randomBytes(32).pipe(Effect.orDie));
        return { token, tokenHash: yield* hashInvitationToken(token) };
      });

      /**
       * MTI-010: proves the caller holds the emailed token for `invitationId`
       * (constant-time hash comparison). An unknown id, a wrong token and a
       * pre-column invitation with no stored hash all answer the same
       * `InvitationNotFound`, so knowing an id reveals nothing.
       */
      const requireInvitationToken = (invitationId: string, token: string) =>
        Effect.gen(function* () {
          const found = yield* invitations.findById(invitationIdGrant, invitationId);
          const presented = yield* hashInvitationToken(token);
          const stored = Option.flatMap(found, (record) => record.tokenHash);
          const matches = Hmac.constantTimeEqualString(
            presented,
            Option.getOrElse(stored, () => NO_INVITATION_TOKEN_HASH),
          );
          if (Option.isNone(found) || Option.isNone(stored) || !matches) {
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          }
          return found.value;
        });

      const requirePendingInvitation = (invitationId: string, token: string) =>
        requireInvitationToken(invitationId, token).pipe(
          Effect.flatMap((record) =>
            record.status === "pending"
              ? Effect.succeed(record)
              : Effect.fail(new OrganizationApi.InvitationNotPending()),
          ),
        );

      const acceptInvitation: OrganizationShape["acceptInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId, token) {
          yield* HookPoint.aborted(OrganizationHooks.BeforeAcceptInvitation)(
            beforeAccept.run({ actor: OrganizationActor.user(caller), invitationId }),
          );

          const record = yield* requirePendingInvitation(invitationId, token);

          const now = yield* DateTime.now;
          if (DateTime.isGreaterThan(now, record.expiresAt)) {
            yield* invitations
              .updateStatus(record.organizationId, invitationId, "expired")
              .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
            return yield* Effect.fail(new OrganizationApi.InvitationExpired());
          }

          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          if (!ownsEmail(user, record.email)) {
            return yield* Effect.fail(new OrganizationApi.InvitationEmailMismatch());
          }
          if (
            (yield* configNow).requireEmailVerificationOnInvitation &&
            !Users.isEmailVerified(user)
          ) {
            return yield* Effect.fail(new OrganizationApi.EmailVerificationRequired());
          }

          // OHS-006: accepting can never overwrite or duplicate a membership —
          // the invitation is stale (the user was admitted another way), so it
          // is canceled and the existing roles stay untouched.
          const alreadyMember = yield* members.findByUserAndOrg(callerId, record.organizationId);
          if (Option.isSome(alreadyMember)) {
            yield* invitations
              .updateStatus(record.organizationId, invitationId, "canceled")
              .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
            return yield* Effect.fail(new OrganizationApi.AlreadyMember());
          }

          const count = yield* members.countByOrganization(record.organizationId);
          if (count >= (yield* limitsOf(record.organizationId)).membershipLimit) {
            return yield* Effect.fail(new OrganizationApi.MembershipLimitReached());
          }

          if (Option.isSome(record.teamId)) {
            const team = yield* teams.findTeamById(record.organizationId, record.teamId.value).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Defects.invariantViolation(
                      "RowVanished",
                      "awthaq: invitation's team vanished before acceptance",
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
            if (
              team.memberCount >= (yield* limitsOf(record.organizationId)).maximumMembersPerTeam
            ) {
              return yield* Effect.fail(new OrganizationApi.TeamMemberLimitReached());
            }
          }

          const membership = yield* members
            .create({
              userId: callerId,
              organizationId: record.organizationId,
              role: record.role,
            })
            .pipe(
              Effect.catchTag("MembershipRecordAlreadyExists", () =>
                Effect.fail(new OrganizationApi.AlreadyMember()),
              ),
            );
          yield* invitations
            .updateStatus(record.organizationId, invitationId, "accepted")
            .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
          yield* events.publish({
            _tag: "auth.organization.invitationAccepted",
            invitationId,
            organizationId: record.organizationId,
            userId: callerId,
          });
          yield* events.publish({
            _tag: "auth.organization.memberAdded",
            organizationId: record.organizationId,
            userId: callerId,
            role: membership.role,
          });
          if (Option.isSome(record.teamId)) {
            const teamId = record.teamId.value;
            // OHS-003: the team half of accepting stays idempotent — a user who
            // is already on the team is not double-counted.
            const added = yield* teams.addTeamMember({ teamId, userId: callerId }).pipe(
              Effect.as(true),
              Effect.catchTag("TeamMembershipRecordAlreadyExists", () => Effect.succeed(false)),
            );
            if (added) {
              yield* events.publish({
                _tag: "auth.organization.teamMemberAdded",
                organizationId: record.organizationId,
                teamId,
                userId: callerId,
              });
            }
          }
          yield* afterAccept.run({
            actor: OrganizationActor.user(caller),
            invitationId,
            organizationId: record.organizationId,
            userId: callerId,
          });
          return membership;
        },
      );

      const rejectInvitation: OrganizationShape["rejectInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId, token) {
          yield* HookPoint.aborted(OrganizationHooks.BeforeRejectInvitation)(
            beforeReject.run({ actor: OrganizationActor.user(caller), invitationId }),
          );

          const record = yield* requirePendingInvitation(invitationId, token);
          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          if (!ownsEmail(user, record.email)) {
            return yield* Effect.fail(new OrganizationApi.InvitationEmailMismatch());
          }
          yield* invitations
            .updateStatus(record.organizationId, invitationId, "rejected")
            .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
          yield* events.publish({
            _tag: "auth.organization.invitationRejected",
            invitationId,
            organizationId: record.organizationId,
          });
          yield* afterReject.run({ actor: OrganizationActor.user(caller), invitationId });
        },
      );

      const cancelInvitation: OrganizationShape["cancelInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          yield* HookPoint.aborted(OrganizationHooks.BeforeCancelInvitation)(
            beforeCancel.run({ actor: OrganizationActor.user(caller), invitationId }),
          );

          // MTI-009: a non-member must not be able to tell an existing invitation
          // (or its status) from an unknown one, so membership is checked before
          // the pending check and answers the unknown-invitation error.
          const callerId = Users.UserId(caller.ref.id);
          const found = yield* invitations.findById(invitationIdGrant, invitationId).pipe(
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
          const record = found;
          if (record.status !== "pending") {
            return yield* Effect.fail(new OrganizationApi.InvitationNotPending());
          }
          yield* requirePermission(callerId, record.organizationId, "invitation", "cancel").pipe(
            // Membership was just proven; a racing removal reads as "no such invitation".
            Effect.catchTag("OrganizationNotFound", () =>
              Effect.fail(new OrganizationApi.InvitationNotFound()),
            ),
          );
          yield* invitations
            .updateStatus(record.organizationId, invitationId, "canceled")
            .pipe(Effect.catchTag("InvitationRecordNotFound", Effect.die));
          yield* events.publish({
            _tag: "auth.organization.invitationCanceled",
            invitationId,
            organizationId: record.organizationId,
          });
          yield* afterCancel.run({ actor: OrganizationActor.user(caller), invitationId });
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
          const found = yield* invitations.findById(invitationIdGrant, invitationId);
          if (Option.isNone(found))
            return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          const allowed = yield* mayReadInvitation(Users.UserId(caller.ref.id), found.value);
          if (!allowed) return yield* Effect.fail(new OrganizationApi.InvitationNotFound());
          return found.value;
        },
      );

      const getInvitationByToken: OrganizationShape["getInvitationByToken"] = Effect.fnUntraced(
        function* (caller, token) {
          const found = yield* invitations.findByTokenHash(
            invitationTokenGrant,
            yield* hashInvitationToken(token),
          );
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
          Effect.flatMap(() => invitations.listByOrganization(organizationId)),
        );

      const listInvitationsForUser: OrganizationShape["listInvitationsForUser"] = Effect.fnUntraced(
        function* (caller) {
          const callerId = Users.UserId(caller.ref.id);
          const user = yield* users.findById(callerId).pipe(Effect.orDie);
          // FAMS-002: a Phone/Anonymous user has no email, so no invitation can name them.
          return yield* Option.match(Users.emailOf(user), {
            onNone: () => Effect.succeed([]),
            onSome: (email) => invitations.listByEmail(inviteeGrant, email),
          });
        },
      );

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

      const requireTeam = (organizationId: string, teamId: string) =>
        teams.findTeamById(organizationId, teamId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.TeamNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

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
