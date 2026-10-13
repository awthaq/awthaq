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
import * as OrganizationApi from "./OrganizationApi.ts";
import { OrganizationConfig, type OrganizationLimits } from "./OrganizationConfig.ts";
import * as OrganizationHandlers from "./OrganizationHandlers.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import { organizationMigrations } from "./OrganizationMigrations.ts";
import { organizationErasure, organizationExport } from "./OrganizationPersonalData.ts";
import type { OrganizationShape } from "./OrganizationShape.ts";
import { hexOf, NO_INVITATION_TOKEN_HASH } from "./internal/tokens.ts";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as OrgRoleRecords from "./OrgRoleRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";

// ---- cross-organization witnesses (plan 05, ADR-EA-018 decision 10) ----------------------
//
// Every records method that reads or writes across organizations takes a `CrossTenant` witness,
// minted here with the reason it is sound, so the justification lives next to the call (the regex
// guard `TenantScoping.test.ts` kept it in an allowlist far from the code). A method keyed by an
// organization id takes no witness: the key is the scope.

/** A caller's own memberships, whichever organizations they are in. */
const ownMembershipsGrant = TenantScoped.crossTenant(
  "organization: a user's own memberships across organizations, keyed by the caller's identity",
);
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
    handlers: OrganizationHandlers.make(Organization),
    contributes: Layer.mergeAll(organizationErasure, organizationExport),
    make: Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const invitations = yield* InvitationRecords.InvitationRecords;
      const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      // OHS-002: the cascades below commit or roll back as one unit. `layerNoop`
      // for an in-memory composition, `layerSql` over the real client otherwise.
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
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
      const beforeCreate = yield* OrganizationHooks.BeforeCreateOrganization;
      const afterCreate = yield* OrganizationHooks.AfterCreateOrganization;
      const beforeUpdate = yield* OrganizationHooks.BeforeUpdateOrganization;
      const afterUpdate = yield* OrganizationHooks.AfterUpdateOrganization;
      const beforeDelete = yield* OrganizationHooks.BeforeDeleteOrganization;
      const afterDelete = yield* OrganizationHooks.AfterDeleteOrganization;
      const beforeRemove = yield* OrganizationHooks.BeforeRemoveMember;
      const afterRemove = yield* OrganizationHooks.AfterRemoveMember;
      const beforeUpdateRole = yield* OrganizationHooks.BeforeUpdateMemberRole;
      const afterUpdateRole = yield* OrganizationHooks.AfterUpdateMemberRole;
      const beforeAdd = yield* OrganizationHooks.BeforeAddMember;
      const afterAdd = yield* OrganizationHooks.AfterAddMember;
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
      const beforeCreateTeam = yield* OrganizationHooks.BeforeCreateTeam;
      const afterCreateTeam = yield* OrganizationHooks.AfterCreateTeam;
      const beforeUpdateTeam = yield* OrganizationHooks.BeforeUpdateTeam;
      const afterUpdateTeam = yield* OrganizationHooks.AfterUpdateTeam;
      const beforeMoveTeam = yield* OrganizationHooks.BeforeMoveTeam;
      const afterMoveTeam = yield* OrganizationHooks.AfterMoveTeam;
      const beforeDeleteTeam = yield* OrganizationHooks.BeforeDeleteTeam;
      const afterDeleteTeam = yield* OrganizationHooks.AfterDeleteTeam;
      const beforeAddTeamMember = yield* OrganizationHooks.BeforeAddTeamMember;
      const afterAddTeamMember = yield* OrganizationHooks.AfterAddTeamMember;
      const beforeUpdateTeamMemberRole = yield* OrganizationHooks.BeforeUpdateTeamMemberRole;
      const afterUpdateTeamMemberRole = yield* OrganizationHooks.AfterUpdateTeamMemberRole;
      const beforeRemoveTeamMember = yield* OrganizationHooks.BeforeRemoveTeamMember;
      const afterRemoveTeamMember = yield* OrganizationHooks.AfterRemoveTeamMember;

      /** Static statements plus, when dynamic access control is enabled, every custom role this organization has defined. */
      const statementsByRole = (organizationId: string) =>
        Effect.flatMap(configNow, (orgConfig) =>
          orgConfig.dynamicAccessControl.enabled
            ? orgRoles.listByOrganization(organizationId).pipe(
                Effect.map((rows) => {
                  const dynamic: Record<string, PermissionEngine.Statements> = {};
                  for (const row of rows) dynamic[row.role] = row.permission;
                  return PermissionEngine.statementsByRoleFrom(
                    orgConfig.permissionStatements,
                    dynamic,
                  );
                }),
              )
            : Effect.succeed(PermissionEngine.statementsByRoleFrom(orgConfig.permissionStatements)),
        );

      const effectivePermissionsOf = (
        organizationId: string,
        membership: MembershipRecords.MembershipRecord,
      ) =>
        statementsByRole(organizationId).pipe(
          Effect.map((byRole) => PermissionEngine.effectivePermissions(membership.role, byRole)),
        );

      /**
       * MTI-009 (BEH-EA-147): a caller who is not a member of the organization
       * gets `OrganizationNotFound` — byte-identical to the answer for an id that
       * does not exist, so a denial never reveals that a tenant exists.
       * `OrganizationPermissionDenied` (403) is reserved for a *member* who lacks
       * the requested statement.
       */
      /**
       * OHS-004: the team-role statements a `TeamMembershipRecord` may hold —
       * `member` (nothing) plus whatever `OrganizationConfig.teamStatements` defines.
       */
      const teamRoleStatementsNow = Effect.map(
        configNow,
        (orgConfig): ReadonlyMap<string, PermissionEngine.Statements> =>
          new Map([["member", {}], ...Object.entries(orgConfig.teamStatements)]),
      );

      /**
       * OHS-004: what the caller's *team* roles confer on `teamId`: the statements of
       * every role they hold on that team or any ancestor of it (authority flows down
       * the subtree, never up or sideways).
       */
      const teamRoleAuthority = (callerId: Users.UserId, organizationId: string, teamId: string) =>
        Effect.gen(function* () {
          const teamRoleStatements = yield* teamRoleStatementsNow;
          const ancestors = yield* teams.getAncestors(organizationId, teamId);
          let authority: PermissionEngine.Statements = {};
          for (const id of [teamId, ...ancestors.map((team) => team.id)]) {
            const held = yield* teams.findTeamMembership(id, callerId);
            if (Option.isSome(held)) {
              authority = PermissionEngine.mergeStatements(
                authority,
                PermissionEngine.effectivePermissions(held.value.role, teamRoleStatements),
              );
            }
          }
          return authority;
        });

      /**
       * `teamId`, when given, widens the check for the `team` resource with the
       * caller's team-scoped roles (`teamRoleAuthority`) — org-level statements are
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
                  yield* teamRoleAuthority(callerId, organizationId, teamId),
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

      /**
       * OHS-004: the same guards as `requireGrantable`/`requireOutranks`, for team roles —
       * the names must be defined, and what they confer (and, when re-roling, what the
       * target already holds) must be within the granter's authority over this team.
       */
      const requireGrantableTeamRole = (
        granterId: Users.UserId,
        organizationId: string,
        teamId: string,
        roleNames: ReadonlyArray<string>,
        current?: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const teamRoleStatements = yield* teamRoleStatementsNow;
          if (roleNames.some((name) => !teamRoleStatements.has(name))) {
            return yield* Effect.fail(new OrganizationApi.UnknownTeamRole());
          }
          const granter = yield* requireMembership(granterId, organizationId);
          const held = PermissionEngine.mergeStatements(
            yield* effectivePermissionsOf(organizationId, granter),
            yield* teamRoleAuthority(granterId, organizationId, teamId),
          );
          const requested = PermissionEngine.effectivePermissions(roleNames, teamRoleStatements);
          const outranked =
            current === undefined
              ? {}
              : PermissionEngine.effectivePermissions(current, teamRoleStatements);
          if (
            !PermissionEngine.canGrant(requested, held) ||
            !PermissionEngine.canGrant(outranked, held)
          ) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
          }
        });

      /** RRM-001: a lower tier cannot alter (demote/reshape) a member who out-privileges it. */
      const requireOutranks = (
        organizationId: string,
        granter: MembershipRecords.MembershipRecord,
        target: MembershipRecords.MembershipRecord,
      ) =>
        Effect.gen(function* () {
          const byRole = yield* statementsByRole(organizationId);
          const held = PermissionEngine.effectivePermissions(granter.role, byRole);
          const targetHeld = PermissionEngine.effectivePermissions(target.role, byRole);
          if (!PermissionEngine.canGrant(targetHeld, held)) {
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
      const requireOrganization = (organizationId: string) =>
        orgs.findById(organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrganizationNotFound()),
              onSome: (record) =>
                Option.isSome(record.suspendedAt)
                  ? Effect.fail(new OrganizationApi.OrganizationNotFound())
                  : Effect.succeed(record),
            }),
          ),
        );

      /** EP-006: the static limits with this organization's `limitsFor` overrides merged over them. */
      const limitsOf = (organizationId: string) =>
        Effect.flatMap(configNow, (orgConfig) =>
          (orgConfig.limitsFor === undefined
            ? Effect.succeed<OrganizationLimits>({})
            : orgConfig.limitsFor(organizationId)
          ).pipe(
            Effect.map((override) => ({
              membershipLimit: override.membershipLimit ?? orgConfig.membershipLimit,
              invitationLimit: override.invitationLimit ?? orgConfig.invitationLimit,
              maximumTeams: override.maximumTeams ?? orgConfig.teams.maximumTeams,
              maximumMembersPerTeam:
                override.maximumMembersPerTeam ?? orgConfig.teams.maximumMembersPerTeam,
              maximumRolesPerOrganization:
                override.maximumRolesPerOrganization ??
                orgConfig.dynamicAccessControl.maximumRolesPerOrganization,
            })),
          ),
        );

      /** DRS-007: a `homeRegion` must come from the configured vocabulary. */
      const requireKnownRegion = (region: string | null | undefined) =>
        Effect.flatMap(configNow, (orgConfig) =>
          region === undefined || region === null || orgConfig.regions.includes(region)
            ? Effect.void
            : Effect.fail(new OrganizationApi.UnknownRegion({ region })),
        );

      const create: OrganizationShape["create"] = Effect.fnUntraced(function* ({
        caller,
        name,
        slug,
        logo,
        metadata,
        homeRegion,
      }) {
        const orgConfig = yield* configNow;
        const callerId = Users.UserId(caller.ref.id);
        yield* requireKnownRegion(homeRegion);
        const allowed = yield* orgConfig.allowUserToCreateOrganization(callerId);
        if (!allowed)
          return yield* Effect.fail(new OrganizationApi.OrganizationCreationNotAllowed());

        const ownedOrgs = yield* members.listByUser(ownMembershipsGrant, callerId);
        const ownedCount = ownedOrgs.filter((m) => m.role.includes(orgConfig.creatorRole)).length;
        if (ownedCount >= orgConfig.organizationLimit) {
          return yield* Effect.fail(new OrganizationApi.OrganizationLimitReached());
        }

        const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateOrganization)(
          beforeCreate.run({ callerId, name, slug }),
        );

        const record = yield* orgs
          .create({ name: vetoed.name, slug: vetoed.slug, logo, metadata, homeRegion })
          .pipe(
            Effect.catchTag("OrganizationRecordSlugTaken", () =>
              Effect.fail(new OrganizationApi.OrganizationSlugTaken()),
            ),
          );
        // A brand-new organization has no memberships, so this cannot collide.
        const membership = yield* members
          .create({
            userId: callerId,
            organizationId: record.id,
            role: [orgConfig.creatorRole],
          })
          .pipe(Effect.catchTag("MembershipRecordAlreadyExists", Effect.die));
        yield* events.publish({
          _tag: "auth.organization.created",
          organizationId: record.id,
          creatorUserId: callerId,
        });
        yield* events.publish({
          _tag: "auth.organization.memberAdded",
          organizationId: record.id,
          userId: callerId,
          role: membership.role,
        });

        yield* afterCreate.run({
          callerId,
          name: vetoed.name,
          slug: vetoed.slug,
          organizationId: record.id,
        });

        return record;
      });

      const checkSlug: OrganizationShape["checkSlug"] = (slug) =>
        orgs.findBySlug(slug).pipe(Effect.map(Option.isNone));

      const list: OrganizationShape["list"] = (caller) =>
        members.listByUser(ownMembershipsGrant, Users.UserId(caller.ref.id)).pipe(
          Effect.flatMap((rows) =>
            orgs.listByIds(
              ownMembershipsGrant,
              rows.map((r) => r.organizationId),
            ),
          ),
        );

      const get: OrganizationShape["get"] = Effect.fnUntraced(function* (caller, organizationId) {
        const record = yield* requireOrganization(organizationId);
        yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
        return record;
      });

      const getFull: OrganizationShape["getFull"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const record = yield* requireOrganization(organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          const memberRows = yield* members.listByOrganization(organizationId, {
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
          yield* requireKnownRegion(input.homeRegion);
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateOrganization)(
            beforeUpdate.run({ organizationId, name: input.name, slug: input.slug }),
          );
          const record = yield* orgs
            .update(organizationId, { ...input, name: vetoed.name, slug: vetoed.slug })
            .pipe(
              Effect.catchTag("OrganizationRecordNotFound", () =>
                Defects.invariantViolation(
                  "RowVanished",
                  "awthaq: organization vanished between check and write",
                ),
              ),
              Effect.catchTag("OrganizationRecordSlugTaken", () =>
                Effect.fail(new OrganizationApi.OrganizationSlugTaken()),
              ),
            );
          yield* events.publish({ _tag: "auth.organization.updated", organizationId });
          yield* afterUpdate.run({ organizationId, name: vetoed.name, slug: vetoed.slug });
          return record;
        },
      );

      const delete_: OrganizationShape["delete"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          if ((yield* configNow).disableOrganizationDeletion) {
            return yield* Effect.fail(new OrganizationApi.OrganizationDeletionDisabled());
          }
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "organization",
            "delete",
          );
          yield* HookPoint.aborted(OrganizationHooks.BeforeDeleteOrganization)(
            beforeDelete.run({ organizationId }),
          );
          // OHS-002: the five-table cascade is one transaction — a failure at any
          // step leaves every organization_* row untouched. Hooks and events stay
          // outside it: they only run once the delete has committed.
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* members.removeAllForOrganization(organizationId);
                yield* invitations.removeAllForOrganization(organizationId);
                yield* teams.removeAllTeamsForOrganization(organizationId);
                yield* orgRoles.removeAllForOrganization(organizationId);
                // CWM-003: no session may keep pointing at the deleted organization.
                yield* activeContext.clearOrganization(organizationId);
                yield* orgs
                  .delete(organizationId)
                  .pipe(
                    Effect.catchTag("OrganizationRecordNotFound", () =>
                      Defects.invariantViolation(
                        "RowVanished",
                        "awthaq: organization vanished between check and write",
                      ),
                    ),
                  );
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({ _tag: "auth.organization.deleted", organizationId });
          yield* afterDelete.run({ organizationId });
        },
      );

      const listMembers: OrganizationShape["listMembers"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          yield* requireOrganization(organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          return yield* members.listByOrganization(organizationId, input);
        },
      );

      /** True iff removing/changing a membership's role away from `owner` would leave zero owners. */
      const wouldViolateOwnerInvariant = (
        organizationId: string,
        targetHeldOwner: boolean,
        nextHeldOwner: boolean,
      ) =>
        targetHeldOwner && !nextHeldOwner
          ? members.countOwners(organizationId).pipe(Effect.map((count) => count <= 1))
          : Effect.succeed(false);

      /**
       * CWM-003/N9: removing a membership (`removeMember` and `leave` alike) also
       * drops everything that hangs off it — the user's team memberships in this
       * organization and any session's active organization/team pointing at it —
       * in one transaction, so a removed member can no longer answer `team-member`
       * in qadi or keep the organization "active". Returns the teams the user was
       * on so the caller can announce each departure once the transaction commits.
       */
      const dropMembership = (organizationId: string, userId: Users.UserId) =>
        sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              yield* members
                .remove(userId, organizationId)
                .pipe(
                  Effect.catchTag("MembershipRecordNotFound", () =>
                    Defects.invariantViolation(
                      "RowVanished",
                      "awthaq: membership vanished between check and write",
                    ),
                  ),
                );
              yield* activeContext.clearOrganizationForUser(userId, organizationId);
              return yield* teams.removeUserFromOrganizationTeams(organizationId, userId);
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));

      const announceTeamDepartures = (
        organizationId: string,
        userId: Users.UserId,
        teamIds: ReadonlyArray<string>,
      ) =>
        Effect.forEach(
          teamIds,
          (teamId) =>
            events
              .publish({
                _tag: "auth.organization.teamMemberRemoved",
                organizationId,
                teamId,
                userId,
              })
              .pipe(Effect.andThen(afterRemoveTeamMember.run({ organizationId, teamId, userId }))),
          { discard: true },
        );

      const removeMember: OrganizationShape["removeMember"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId) {
          yield* requireOrganization(organizationId);
          // MTI-009: a non-member learns nothing about who else is in the
          // organization — the target lookup below would otherwise answer
          // `MembershipNotFound` before any permission check.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          const target = yield* members.findByUserAndOrg(targetUserId, organizationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrganizationApi.MembershipNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const violates = yield* wouldViolateOwnerInvariant(
            organizationId,
            target.role.includes("owner"),
            false,
          );
          if (violates) return yield* Effect.fail(new OrganizationApi.OwnerInvariantViolation());

          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "member", "delete");
          yield* HookPoint.aborted(OrganizationHooks.BeforeRemoveMember)(
            beforeRemove.run({ organizationId, userId: targetUserId }),
          );
          const leftTeams = yield* dropMembership(organizationId, targetUserId);
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId: targetUserId,
          });
          yield* announceTeamDepartures(organizationId, targetUserId, leftTeams);
          yield* afterRemove.run({ organizationId, userId: targetUserId });
        },
      );

      const updateMemberRole: OrganizationShape["updateMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId, role) {
          yield* requireOrganization(organizationId);
          // MTI-009: see `removeMember`.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          const target = yield* members.findByUserAndOrg(targetUserId, organizationId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrganizationApi.MembershipNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const violates = yield* wouldViolateOwnerInvariant(
            organizationId,
            target.role.includes("owner"),
            role.includes("owner"),
          );
          if (violates) return yield* Effect.fail(new OrganizationApi.OwnerInvariantViolation());

          const granter = yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "member",
            "update",
          );
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateMemberRole)(
            beforeUpdateRole.run({ organizationId, userId: targetUserId, role }),
          );
          // RRM-001: after the veto hook (a tap may rewrite the role), the
          // caller must hold every statement it is conferring, and must not
          // out-privilege-lose against the member it is changing.
          yield* requireOutranks(organizationId, granter, target);
          yield* requireGrantable(organizationId, granter, vetoed.role);
          const updated = yield* members
            .updateRole(targetUserId, organizationId, vetoed.role)
            .pipe(
              Effect.catchTag("MembershipRecordNotFound", () =>
                Defects.invariantViolation(
                  "RowVanished",
                  "awthaq: membership vanished between check and write",
                ),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.memberRoleUpdated",
            organizationId,
            userId: targetUserId,
            role: vetoed.role,
          });
          yield* afterUpdateRole.run({ organizationId, userId: targetUserId, role: vetoed.role });
          return updated;
        },
      );

      const leave: OrganizationShape["leave"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          const callerId = Users.UserId(caller.ref.id);
          const own = yield* members.findByUserAndOrg(callerId, organizationId).pipe(
            Effect.flatMap(
              Option.match({
                // PV-300 (MTI-009): a non-member leaving is answered exactly like an unknown id.
                onNone: () => Effect.fail(new OrganizationApi.OrganizationNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
          const violates = yield* wouldViolateOwnerInvariant(
            organizationId,
            own.role.includes("owner"),
            false,
          );
          if (violates) return yield* Effect.fail(new OrganizationApi.OwnerInvariantViolation());

          // PCS-002: `leave` removes a membership like `removeMember` does, so it
          // runs the same remove-member hooks — `DecisionCacheInvalidationLive`
          // (and any other observer) must see a member leaving.
          yield* HookPoint.aborted(OrganizationHooks.BeforeRemoveMember)(
            beforeRemove.run({ organizationId, userId: callerId }),
          );
          const leftTeams = yield* dropMembership(organizationId, callerId);
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId: callerId,
          });
          yield* announceTeamDepartures(organizationId, callerId, leftTeams);
          yield* afterRemove.run({ organizationId, userId: callerId });
        },
      );

      const addMember: OrganizationShape["addMember"] = Effect.fnUntraced(function* ({
        organizationId,
        userId,
        role,
      }) {
        yield* requireOrganization(organizationId);
        const count = yield* members.countByOrganization(organizationId);
        if (count >= (yield* limitsOf(organizationId)).membershipLimit) {
          return yield* Effect.fail(new OrganizationApi.MembershipLimitReached());
        }
        const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeAddMember)(
          beforeAdd.run({ organizationId, userId, role }),
        );
        // RRM-001: a trusted, caller-less server-side primitive (SCIM/import) —
        // it bypasses the grant guard by design, but still only stores role
        // names the organization recognizes.
        yield* requireKnownRoles(yield* statementsByRole(organizationId), vetoed.role);
        // MTI-003: never overwrite or duplicate an existing membership — a role
        // change goes through `updateMemberRole` (and its canGrant guard).
        const existing = yield* members.findByUserAndOrg(userId, organizationId);
        if (Option.isSome(existing)) return yield* Effect.fail(new OrganizationApi.AlreadyMember());
        const membership = yield* members
          .create({ userId, organizationId, role: vetoed.role })
          .pipe(
            Effect.catchTag("MembershipRecordAlreadyExists", () =>
              Effect.fail(new OrganizationApi.AlreadyMember()),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.memberAdded",
          organizationId,
          userId,
          role: vetoed.role,
        });
        yield* afterAdd.run({ organizationId, userId, role: vetoed.role });
        return membership;
      });

      const checkRoleCeiling: OrganizationShape["checkRoleCeiling"] = Effect.fnUntraced(function* ({
        organizationId,
        roles,
        ceiling,
      }) {
        yield* requireOrganization(organizationId);
        const byRole = yield* statementsByRole(organizationId);
        if (roles.some((name) => !byRole.has(name))) return Option.some("unknownRole" as const);
        if (ceiling.some((name) => !byRole.has(name)))
          return Option.some("unknownCeiling" as const);
        return PermissionEngine.canGrant(
          PermissionEngine.effectivePermissions(roles, byRole),
          PermissionEngine.effectivePermissions(ceiling, byRole),
        )
          ? Option.none()
          : Option.some("exceedsCeiling" as const);
      });

      const syncMemberRoles: OrganizationShape["syncMemberRoles"] = Effect.fnUntraced(function* ({
        organizationId,
        userId,
        roles,
        ceiling,
      }) {
        yield* requireOrganization(organizationId);
        const byRole = yield* statementsByRole(organizationId);
        yield* requireKnownRoles(byRole, roles);
        const held = PermissionEngine.effectivePermissions(ceiling, byRole);
        if (
          !PermissionEngine.canGrant(PermissionEngine.effectivePermissions(roles, byRole), held)
        ) {
          return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
        }
        const existing = yield* members.findByUserAndOrg(userId, organizationId);
        if (Option.isNone(existing)) {
          const membership = yield* addMember({ organizationId, userId, role: roles });
          return { membership, change: "added" as const };
        }
        const current = existing.value;
        if (
          current.role.length === roles.length &&
          roles.every((name) => current.role.includes(name))
        ) {
          return { membership: current, change: "unchanged" as const };
        }
        // RRM-001: a source never reshapes a member who out-privileges it.
        if (
          !PermissionEngine.canGrant(
            PermissionEngine.effectivePermissions(current.role, byRole),
            held,
          )
        ) {
          return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
        }
        if (
          yield* wouldViolateOwnerInvariant(
            organizationId,
            current.role.includes("owner"),
            roles.includes("owner"),
          )
        ) {
          return yield* Effect.fail(new OrganizationApi.OwnerInvariantViolation());
        }
        const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateMemberRole)(
          beforeUpdateRole.run({ organizationId, userId, role: roles }),
        );
        const updated = yield* members
          .updateRole(userId, organizationId, vetoed.role)
          .pipe(
            Effect.catchTag("MembershipRecordNotFound", () =>
              Defects.invariantViolation(
                "RowVanished",
                "awthaq: membership vanished between check and write",
              ),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.memberRoleUpdated",
          organizationId,
          userId,
          role: vetoed.role,
        });
        yield* afterUpdateRole.run({ organizationId, userId, role: vetoed.role });
        return { membership: updated, change: "updated" as const };
      });

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
        orgs
          .findById(organizationId)
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
            beforeCreateInvitation.run({ organizationId, email: input.email, role: input.role }),
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
            beforeAccept.run({ invitationId }),
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
            beforeReject.run({ invitationId }),
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
          yield* afterReject.run({ invitationId });
        },
      );

      const cancelInvitation: OrganizationShape["cancelInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          yield* HookPoint.aborted(OrganizationHooks.BeforeCancelInvitation)(
            beforeCancel.run({ invitationId }),
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
          yield* afterCancel.run({ invitationId });
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
            beforeCreateRole.run({ organizationId, role: input.role }),
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
          yield* afterCreateRole.run({ organizationId, role: record.role, roleId: record.id });
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
            beforeUpdateRoleHook.run({ organizationId, roleId }),
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
          yield* afterUpdateRoleHook.run({ organizationId, roleId });
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
            beforeDeleteRole.run({ organizationId, roleId }),
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
          yield* afterDeleteRole.run({ organizationId, roleId });
        },
      );

      // ---- teams --------------------------------------------------------------

      const requireTeamsEnabled = Effect.flatMap(configNow, (orgConfig) =>
        orgConfig.teams.enabled ? Effect.void : Effect.fail(new OrganizationApi.TeamsDisabled()),
      );

      /**
       * PV-300 (MTI-009): the membership gate comes *before* the feature gate. A
       * non-member must get `OrganizationNotFound` whether or not teams are enabled,
       * or `TeamsDisabled` (403) versus `OrganizationNotFound` (404) tells an outsider
       * which organization ids exist.
       */
      const requireTeamsFor = (callerId: Users.UserId, organizationId: string) =>
        requireMembership(callerId, organizationId).pipe(Effect.andThen(requireTeamsEnabled));

      const requireTeam = (organizationId: string, teamId: string) =>
        teams.findTeamById(organizationId, teamId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.TeamNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const createTeam: OrganizationShape["createTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, name, parentId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          // OHS-004: a nested team needs `team:create` on its parent (a team role held
          // on the parent or an ancestor suffices); a root team needs it org-level.
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "create",
            parentId,
          );
          if (parentId !== undefined) yield* requireTeam(organizationId, parentId);
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count >= (yield* limitsOf(organizationId)).maximumTeams) {
            return yield* Effect.fail(new OrganizationApi.TeamLimitReached());
          }
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateTeam)(
            beforeCreateTeam.run({ organizationId, name, parentId }),
          );
          const record = yield* teams
            .createTeam({ organizationId, name: vetoed.name, parentId: vetoed.parentId })
            .pipe(
              Effect.catchTag("TeamRecordNotFound", () =>
                Effect.fail(new OrganizationApi.TeamNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamCreated",
            organizationId,
            teamId: record.id,
          });
          yield* afterCreateTeam.run({
            organizationId,
            name: vetoed.name,
            parentId: vetoed.parentId,
            teamId: record.id,
          });
          return record;
        },
      );

      const moveTeam: OrganizationShape["moveTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, parentId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          // OHS-004: authority over the team *and* over its destination — a move can
          // hand a subtree to another team's leads, so the target's own authority is
          // required too; the root is org-level.
          const callerId = Users.UserId(caller.ref.id);
          yield* requirePermission(callerId, organizationId, "team", "update", teamId);
          yield* requirePermission(
            callerId,
            organizationId,
            "team",
            "update",
            Option.getOrUndefined(parentId),
          );
          yield* requireTeam(organizationId, teamId);
          if (Option.isSome(parentId)) yield* requireTeam(organizationId, parentId.value);
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeMoveTeam)(
            beforeMoveTeam.run({ organizationId, teamId, parentId: Option.getOrNull(parentId) }),
          );
          const moved = yield* teams
            .moveTeam({ organizationId, id: teamId, parentId: Option.fromNullOr(vetoed.parentId) })
            .pipe(
              Effect.catchTags({
                TeamRecordNotFound: () => Effect.fail(new OrganizationApi.TeamNotFound()),
                "TeamRecords/HierarchyCycle": () =>
                  Effect.fail(new OrganizationApi.TeamHierarchyCycle()),
              }),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMoved",
            organizationId,
            teamId,
            parentId: vetoed.parentId,
          });
          yield* afterMoveTeam.run({ organizationId, teamId, parentId: vetoed.parentId });
          return moved;
        },
      );

      // OHS-001: relatives are read like `listTeams` — member-only, never public.
      const listTeamAncestors: OrganizationShape["listTeamAncestors"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          yield* requireTeam(organizationId, teamId);
          return yield* teams.getAncestors(organizationId, teamId);
        },
      );

      const listTeamDescendants: OrganizationShape["listTeamDescendants"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          yield* requireTeam(organizationId, teamId);
          return yield* teams.getDescendants(organizationId, teamId);
        },
      );

      const listTeams: OrganizationShape["listTeams"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          // MTI-002: any authenticated principal could otherwise enumerate
          // another tenant's team names/counts — member-only, mirroring
          // `getFull`'s own `requireMembership` posture for a read.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          return yield* teams.listTeamsByOrganization(organizationId);
        },
      );

      const listUserTeams: OrganizationShape["listUserTeams"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          return yield* teams.listTeamsByUser(organizationId, Users.UserId(caller.ref.id));
        },
      );

      const updateTeam: OrganizationShape["updateTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, name) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "update",
            teamId,
          );
          yield* requireTeam(organizationId, teamId);
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateTeam)(
            beforeUpdateTeam.run({ organizationId, teamId, name }),
          );
          const updated = yield* teams
            .updateTeam(organizationId, teamId, vetoed.name)
            .pipe(
              Effect.catchTag("TeamRecordNotFound", () =>
                Defects.invariantViolation(
                  "RowVanished",
                  "awthaq: team vanished between check and write",
                ),
              ),
            );
          yield* events.publish({ _tag: "auth.organization.teamUpdated", organizationId, teamId });
          yield* afterUpdateTeam.run({ organizationId, teamId, name: vetoed.name });
          return updated;
        },
      );

      const removeTeam: OrganizationShape["removeTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "delete",
            teamId,
          );
          yield* requireTeam(organizationId, teamId);
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count <= 1 && !(yield* configNow).teams.allowRemovingAllTeams) {
            return yield* Effect.fail(new OrganizationApi.LastTeamCannotBeRemoved());
          }
          // OHS-001: refuse before the veto hook runs; the records layer re-checks atomically.
          const below = yield* teams.getDescendants(organizationId, teamId);
          if (below.length > 0) return yield* Effect.fail(new OrganizationApi.TeamHasChildren());
          yield* HookPoint.aborted(OrganizationHooks.BeforeDeleteTeam)(
            beforeDeleteTeam.run({ organizationId, teamId }),
          );
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* teams.removeTeam(organizationId, teamId).pipe(
                  Effect.catchTags({
                    TeamRecordNotFound: () =>
                      Defects.invariantViolation(
                        "RowVanished",
                        "awthaq: team vanished between check and write",
                      ),
                    "TeamRecords/HasChildren": () =>
                      Effect.fail(new OrganizationApi.TeamHasChildren()),
                  }),
                );
                // CWM-003/OHS-007: no session may keep the deleted team active.
                yield* activeContext.clearTeam(teamId);
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({ _tag: "auth.organization.teamDeleted", organizationId, teamId });
          yield* afterDeleteTeam.run({ organizationId, teamId });
        },
      );

      const listTeamMembers: OrganizationShape["listTeamMembers"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          yield* requireTeam(organizationId, teamId);
          // MTI-002: a team roster is personal data about another tenant's
          // staff — member-only, mirroring `getFull`'s own
          // `requireMembership` posture for a read.
          yield* requireMembership(Users.UserId(caller.ref.id), organizationId);
          return yield* teams.listTeamMembers(teamId);
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
        yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
        const callerId = Users.UserId(caller.ref.id);
        yield* requirePermission(callerId, organizationId, "team", "update", teamId);
        const team = yield* requireTeam(organizationId, teamId);
        yield* requireGrantableTeamRole(callerId, organizationId, teamId, role);
        const targetMembership = yield* members.findByUserAndOrg(targetUserId, organizationId);
        if (Option.isNone(targetMembership)) {
          return yield* Effect.fail(new OrganizationApi.MembershipNotFound());
        }
        if (team.memberCount >= (yield* limitsOf(organizationId)).maximumMembersPerTeam) {
          return yield* Effect.fail(new OrganizationApi.TeamMemberLimitReached());
        }
        yield* HookPoint.aborted(OrganizationHooks.BeforeAddTeamMember)(
          beforeAddTeamMember.run({ organizationId, teamId, userId: targetUserId, role }),
        );
        // OHS-003: a second add is refused — it would over-count `memberCount`.
        const onTeam = yield* teams.findTeamMembership(teamId, targetUserId);
        if (Option.isSome(onTeam)) {
          return yield* Effect.fail(new OrganizationApi.AlreadyTeamMember());
        }
        const record = yield* teams
          .addTeamMember({ teamId, userId: targetUserId, role })
          .pipe(
            Effect.catchTag("TeamMembershipRecordAlreadyExists", () =>
              Effect.fail(new OrganizationApi.AlreadyTeamMember()),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.teamMemberAdded",
          organizationId,
          teamId,
          userId: targetUserId,
        });
        yield* afterAddTeamMember.run({ organizationId, teamId, userId: targetUserId, role });
        return record;
      });

      const updateTeamMemberRole: OrganizationShape["updateTeamMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId, role) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          const callerId = Users.UserId(caller.ref.id);
          yield* requirePermission(callerId, organizationId, "team", "update", teamId);
          yield* requireTeam(organizationId, teamId);
          const target = yield* teams.findTeamMembership(teamId, targetUserId);
          if (Option.isNone(target)) {
            return yield* Effect.fail(new OrganizationApi.TeamMembershipNotFound());
          }
          yield* requireGrantableTeamRole(
            callerId,
            organizationId,
            teamId,
            role,
            target.value.role,
          );
          yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateTeamMemberRole)(
            beforeUpdateTeamMemberRole.run({ organizationId, teamId, userId: targetUserId, role }),
          );
          const updated = yield* teams
            .updateTeamMemberRole(teamId, targetUserId, role)
            .pipe(
              Effect.catchTag("TeamMembershipRecordNotFound", () =>
                Effect.fail(new OrganizationApi.TeamMembershipNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMemberRoleUpdated",
            organizationId,
            teamId,
            userId: targetUserId,
            role,
          });
          yield* afterUpdateTeamMemberRole.run({
            organizationId,
            teamId,
            userId: targetUserId,
            role,
          });
          return updated;
        },
      );

      const removeTeamMember: OrganizationShape["removeTeamMember"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsFor(Users.UserId(caller.ref.id), organizationId);
          yield* requirePermission(
            Users.UserId(caller.ref.id),
            organizationId,
            "team",
            "update",
            teamId,
          );
          yield* requireTeam(organizationId, teamId);
          yield* HookPoint.aborted(OrganizationHooks.BeforeRemoveTeamMember)(
            beforeRemoveTeamMember.run({ organizationId, teamId, userId: targetUserId }),
          );
          yield* teams
            .removeTeamMember(teamId, targetUserId)
            .pipe(
              Effect.catchTag("TeamMembershipRecordNotFound", () =>
                Effect.fail(new OrganizationApi.TeamMembershipNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMemberRemoved",
            organizationId,
            teamId,
            userId: targetUserId,
          });
          yield* afterRemoveTeamMember.run({ organizationId, teamId, userId: targetUserId });
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

      const attributesFor: OrganizationShape["attributesFor"] = (organizationId, userId) =>
        members
          .findByUserAndOrg(userId, organizationId)
          .pipe(
            Effect.flatMap((membership) =>
              Option.isNone(membership)
                ? Effect.succeed(Option.none())
                : effectivePermissionsOf(organizationId, membership.value).pipe(
                    Effect.map((permissions) =>
                      Option.some({ role: membership.value.role, permissions }),
                    ),
                  ),
            ),
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
        addMember,
        checkRoleCeiling,
        syncMemberRoles,
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
        attributesFor,
      });
    }),
  });
}
