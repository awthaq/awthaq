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

import { Api, type SessionLifecycle } from "@awthaq/api";
import {
  type AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  HookPoint,
  type Retention,
  Users,
} from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ConnectionRecords from "./ConnectionRecords.ts";
import * as OrganizationActiveContext from "./OrganizationActiveContext.ts";
import * as OrganizationApi from "./OrganizationApi.ts";
import { OrganizationConfigScoped } from "./OrganizationConfig.ts";
import * as OrganizationHandlers from "./OrganizationHandlers.ts";
import { organizationMigrations } from "./OrganizationMigrations.ts";
import {
  organizationErasure,
  organizationExport,
  organizationInvitationRetention,
} from "./OrganizationPersonalData.ts";
import * as OrganizationBundle from "./OrganizationBundle.ts";
import { OrganizationHooksLive } from "./OrganizationHooks.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationEvents from "./OrganizationEvents.ts";
import * as OrganizationInvitations from "./OrganizationInvitations.ts";
import * as OrganizationMembers from "./OrganizationMembers.ts";
import * as OrganizationRoles from "./OrganizationRoles.ts";
import * as OrganizationSystem from "./OrganizationSystem.ts";
import * as OrganizationTeams from "./OrganizationTeams.ts";
import type { OrganizationShape } from "./OrganizationShape.ts";
import * as OrganizationAccess from "./internal/access.ts";
import { statement } from "./internal/access.ts";

/** ADR-EA-045: the session lifecycle this module's endpoints declare; named so the inferred handler and layer types can be emitted (TS2883 needs the `SessionLifecycle` namespace in scope). */
export type OrganizationLifecycle = SessionLifecycle.Refreshes;

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
export {
  organizationErasure,
  organizationExport,
  organizationInvitationRetention,
} from "./OrganizationPersonalData.ts";

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
export type PersonalDataRegistries =
  | Erasure.ErasureRegistry
  | DataExport.DataExportRegistry
  | Retention.RetentionRegistry;

/**
 * The wire middleware and the typed veto error the plugin's class and layer mention, named here so their
 * inferred types can be emitted (declaration emit needs the namespaces in scope).
 */
export type WireTypes = Api.Authentication | Api.CsrfProtection | HookPoint.HookAborted;

/** The core service `OrganizationAccess` publishes its denials through, named for declaration emit like the above. */
export type AccessServices = AuthEvents.AuthEvents | Users.Users;

// ---- plugin ---------------------------------------------------------------------

export class Organization extends AuthPlugin.Service<Organization, OrganizationShape>()(
  "organization",
  {
    apiVersion: 1,
    contract: OrganizationApi.OrganizationApi,
    migrations: organizationMigrations,
    // ADR-EA-049: the events this plugin publishes, defined in `OrganizationEvents.ts`.
    events: OrganizationEvents.events,
    // Plan 17: the sealed OAuth connection secret, declared beside the records that seal it.
    sealedColumns: [ConnectionRecords.clientSecretColumn],
    // Plan 08 (BEH-EA-T4): the eight record stores, memory and SQL, matched.
    records: OrganizationBundle,
    // Plan 08: the 46 hook points this plugin owns; `TestAuth.layer` provides them once beneath application taps.
    hookPoints: OrganizationHooksLive,
    config: [ConfigDescriptor.make(OrganizationConfigScoped)],
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
      organization_domain_owner: AuthPlugin.Table.keyed("organizationId"),
      organization_domain_claim: AuthPlugin.Table.keyed("organizationId"),
    },
  },
) {
  static readonly layer = AuthPlugin.layer(Organization, {
    ports: [Mailer.Mailer, SqlTransaction.SqlTransaction],
    exposes: { services: OrganizationSystem.services, layer: OrganizationSystem.layer },
    handlers: OrganizationHandlers.make(Organization),
    contributes: Layer.mergeAll(
      organizationErasure,
      organizationExport,
      organizationInvitationRetention,
    ),
    make: Effect.gen(function* () {
      // ADR-EA-040: the plugin's system interfaces, built beneath this `make` by `exposes`.
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const teamSystem = yield* OrganizationTeams.OrganizationTeams;
      const memberSystem = yield* OrganizationMembers.OrganizationMembers;
      const invitationSystem = yield* OrganizationInvitations.OrganizationInvitations;
      const roleSystem = yield* OrganizationRoles.OrganizationRoles;
      const activeSystem = yield* OrganizationActiveContext.OrganizationActiveContext;
      // ADR-EA-040 decision 6 (plan 30): every organization-scoped method below takes its proof from
      // one `OrganizationAccess` entry point, which writes the order (EP-003, MTI-009, the feature
      // gate, the statement with its PERS-005 audit) once. A method then acts with the proof's
      // organization id, actor and ceiling, and nothing else: it holds no authorization of its own.
      const access = yield* OrganizationAccess.make;

      // ---- organizations: authorization on top of `OrganizationDirectory` ---------------------

      const create: OrganizationShape["create"] = Effect.fnUntraced(function* ({
        caller,
        ...input
      }) {
        // The region, the quota, the veto and the organization with its creator's membership are the Directory's.
        const { userId, actor } = yield* access.creator(caller);
        return yield* directory.create(actor, { owner: userId, ...input });
      });

      const checkSlug: OrganizationShape["checkSlug"] = directory.isSlugAvailable;

      const list: OrganizationShape["list"] = (caller) => directory.listForUser(caller.userId);

      // EP-003 (ADR-EA-018): a suspended organization answers exactly like an unknown one, for members
      // and outsiders alike; `list` still returns it, flagged `suspended`, so a member sees why.
      const get: OrganizationShape["get"] = (caller, organizationId) =>
        access.member(caller, organizationId).pipe(Effect.map((proof) => proof.organization));

      const getFull: OrganizationShape["getFull"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const proof = yield* access.member(caller, organizationId);
          const memberRows = yield* memberSystem.list(proof.organizationId, {
            limit: input?.membersLimit,
            offset: input?.membersOffset,
          });
          const invitationRows = yield* invitationSystem.listPendingForOrganization(
            proof.organizationId,
          );
          return {
            organization: proof.organization,
            members: memberRows,
            invitations: invitationRows,
          };
        },
      );

      const update: OrganizationShape["update"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const proof = yield* access.require(
            caller,
            organizationId,
            statement("organization", "update"),
          );
          return yield* directory.update(proof.actor, {
            organizationId: proof.organizationId,
            ...input,
          });
        },
      );

      const delete_: OrganizationShape["delete"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          const proof = yield* access.require(
            caller,
            organizationId,
            statement("organization", "delete"),
          );
          yield* directory.delete(proof.actor, { organizationId: proof.organizationId });
        },
      );

      // ---- members: authorization on top of `OrganizationMembers` ----------------------------
      //
      // The owner invariant, role names, the veto, the transaction and the events are the module's,
      // once, for every caller (SCIM and SAML included).

      const listMembers: OrganizationShape["listMembers"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const proof = yield* access.member(caller, organizationId);
          return yield* memberSystem.list(proof.organizationId, input);
        },
      );

      const removeMember: OrganizationShape["removeMember"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId) {
          // D4: the statement check comes first, so a caller without `member:delete` cannot probe
          // whether a member is the last owner.
          const proof = yield* access.require(
            caller,
            organizationId,
            statement("member", "delete"),
          );
          yield* memberSystem.remove(proof.actor, {
            organizationId: proof.organizationId,
            userId: targetUserId,
          });
        },
      );

      const updateMemberRole: OrganizationShape["updateMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, targetUserId, role) {
          const proof = yield* access.require(
            caller,
            organizationId,
            statement("member", "update"),
          );
          const { membership } = yield* memberSystem
            .setRoles(proof.actor, {
              organizationId: proof.organizationId,
              userId: targetUserId,
              roles: role,
              bound: proof.bound,
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
          // PV-300 (MTI-009): a non-member leaving is answered exactly like an unknown id.
          const proof = yield* access.member(caller, organizationId);
          yield* memberSystem.remove(proof.actor, {
            organizationId: proof.organizationId,
            userId: proof.membership.userId,
          });
        },
      );

      // ---- active context: a session's pointers, through `OrganizationActiveContext` ---------
      //
      // Nothing here is an authorization decision beyond the membership witness the module requires; the
      // caller's session is the identity.

      const getActiveMember: OrganizationShape["getActiveMember"] = (caller) =>
        activeSystem.activeMembership(OrganizationActiveContext.sessionOf(caller));

      const getActiveMemberRole: OrganizationShape["getActiveMemberRole"] = (caller) =>
        getActiveMember(caller).pipe(Effect.map((membership) => membership.role));

      const setActive: OrganizationShape["setActive"] = (caller, organizationId) =>
        activeSystem.setOrganization(
          OrganizationActiveContext.sessionOf(caller),
          Option.fromNullOr(organizationId),
        );

      const getActive: OrganizationShape["getActive"] = (caller) =>
        activeSystem.get(OrganizationActiveContext.sessionOf(caller));

      // ---- invitations: authorization on top of `OrganizationInvitations` -------------------
      //
      // The capability token, expiry, limits, the transaction, hooks and events are the module's. The
      // invitee's own acts (accept, reject) are not an authorization decision: the emailed token plus
      // the invitee's address are the capability, and the module refuses a suspended organization.

      const invite: OrganizationShape["invite"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const proof = yield* access.require(
            caller,
            organizationId,
            statement("invitation", "create"),
          );
          return yield* invitationSystem.create(proof.actor, {
            organizationId: proof.organizationId,
            inviterId: proof.membership.userId,
            email: input.email,
            role: input.role,
            teamId: input.teamId,
            resend: input.resend,
            bound: proof.bound,
          });
        },
      );

      const acceptInvitation: OrganizationShape["acceptInvitation"] = (
        caller,
        invitationId,
        token,
      ) => invitationSystem.accept({ invitationId, token, userId: caller.userId });

      const rejectInvitation: OrganizationShape["rejectInvitation"] = (
        caller,
        invitationId,
        token,
      ) => invitationSystem.reject({ invitationId, token, userId: caller.userId });

      const cancelInvitation: OrganizationShape["cancelInvitation"] = Effect.fnUntraced(
        function* (caller, invitationId) {
          // MTI-009: a non-member must not tell an existing invitation (or its status) from an unknown
          // one, so visibility comes before the pending check and answers the unknown-invitation error.
          const wanted = statement("invitation", "cancel");
          const seen = yield* access.invitation(caller, invitationId, wanted);
          if (seen.invitation.status !== "pending") {
            return yield* new OrganizationApi.InvitationNotPending();
          }
          const proof = yield* access.upgrade(caller, seen.access, wanted);
          // D6: the veto runs after the authorization above.
          yield* invitationSystem.cancel(proof.actor, { invitationId });
        },
      );

      const getInvitation: OrganizationShape["getInvitation"] = access.readInvitation;

      const getInvitationByToken: OrganizationShape["getInvitationByToken"] =
        access.invitationByToken;

      const listInvitationsForOrganization: OrganizationShape["listInvitationsForOrganization"] = (
        caller,
        organizationId,
      ) =>
        access
          .member(caller, organizationId)
          .pipe(
            Effect.flatMap((proof) => invitationSystem.listForOrganization(proof.organizationId)),
          );

      const listInvitationsForUser: OrganizationShape["listInvitationsForUser"] = (caller) =>
        invitationSystem.listForUser(caller.userId);

      // ---- dynamic access control: authorization on top of `OrganizationRoles` ----------------
      //
      // The reserved names, the quota, the veto and the write are the module's. `requireRole` checks
      // membership before the feature gate, so a non-member's answer never depends on whether dynamic
      // access control is enabled (BEH-EA-284).

      const createRole: OrganizationShape["createRole"] = Effect.fnUntraced(
        function* (caller, organizationId, input) {
          const proof = yield* access.requireRole(
            caller,
            organizationId,
            statement("role", "create"),
          );
          return yield* roleSystem.create(proof.actor, {
            organizationId: proof.organizationId,
            role: input.role,
            permission: input.permission,
            bound: proof.bound,
          });
        },
      );

      const listRoles: OrganizationShape["listRoles"] = Effect.fnUntraced(
        function* (caller, organizationId) {
          const proof = yield* access.requireRole(
            caller,
            organizationId,
            statement("role", "read"),
          );
          return yield* roleSystem.list(proof.organizationId);
        },
      );

      const getRole: OrganizationShape["getRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId) {
          const proof = yield* access.requireRole(
            caller,
            organizationId,
            statement("role", "read"),
          );
          return yield* roleSystem.find(proof.organizationId, roleId);
        },
      );

      const updateRole: OrganizationShape["updateRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId, permission) {
          const proof = yield* access.requireRole(
            caller,
            organizationId,
            statement("role", "update"),
          );
          return yield* roleSystem.update(proof.actor, {
            organizationId: proof.organizationId,
            roleId,
            permission,
            bound: proof.bound,
          });
        },
      );

      const deleteRole: OrganizationShape["deleteRole"] = Effect.fnUntraced(
        function* (caller, organizationId, roleId) {
          const proof = yield* access.requireRole(
            caller,
            organizationId,
            statement("role", "delete"),
          );
          yield* roleSystem.remove(proof.actor, { organizationId: proof.organizationId, roleId });
        },
      );

      // ---- teams: authorization on top of `OrganizationTeams` ------------------------
      //
      // Quotas, the last-team rule, vetoes, the transaction and events live in `OrganizationTeams`, once,
      // for every caller (SCIM Groups included). A team statement is checked on the team it names (a
      // team role held there or on an ancestor counts, OHS-004); a roster role is bounded by the proof.

      const createTeam: OrganizationShape["createTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, name, parentId) {
          // OHS-004: a nested team needs `team:create` on its parent; a root team needs it org-level.
          const proof = yield* access.requireOnTeam(
            caller,
            organizationId,
            statement("team", "create"),
            parentId,
          );
          const { team } = yield* teamSystem
            .create(proof.actor, { organizationId: proof.organizationId, name, parentId })
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
          // OHS-004: authority over the team *and* over its destination (a move can hand a subtree to
          // another team's leads); the root is org-level.
          const wanted = statement("team", "update");
          const proof = yield* access.requireOnTeam(caller, organizationId, wanted, teamId);
          yield* access.alsoOnTeam(caller, proof, wanted, Option.getOrUndefined(parentId));
          return yield* teamSystem.move(proof.actor, {
            organizationId: proof.organizationId,
            teamId,
            parentId,
          });
        },
      );

      // OHS-001, MTI-002: relatives, rosters and team names are member-only reads, never public.
      const listTeamAncestors: OrganizationShape["listTeamAncestors"] = (
        caller,
        organizationId,
        teamId,
      ) =>
        access
          .teamMember(caller, organizationId)
          .pipe(Effect.flatMap((proof) => teamSystem.ancestors(proof.organizationId, teamId)));

      const listTeamDescendants: OrganizationShape["listTeamDescendants"] = (
        caller,
        organizationId,
        teamId,
      ) =>
        access
          .teamMember(caller, organizationId)
          .pipe(Effect.flatMap((proof) => teamSystem.descendants(proof.organizationId, teamId)));

      const listTeams: OrganizationShape["listTeams"] = (caller, organizationId) =>
        access
          .teamMember(caller, organizationId)
          .pipe(Effect.flatMap((proof) => teamSystem.list(proof.organizationId)));

      const listUserTeams: OrganizationShape["listUserTeams"] = (caller, organizationId) =>
        access
          .teamMember(caller, organizationId)
          .pipe(
            Effect.flatMap((proof) =>
              teamSystem.listForUser(proof.organizationId, proof.membership.userId),
            ),
          );

      const listTeamMembers: OrganizationShape["listTeamMembers"] = (
        caller,
        organizationId,
        teamId,
      ) =>
        access
          .teamMember(caller, organizationId)
          .pipe(Effect.flatMap((proof) => teamSystem.members(proof.organizationId, teamId)));

      const updateTeam: OrganizationShape["updateTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, name) {
          const proof = yield* access.requireOnTeam(
            caller,
            organizationId,
            statement("team", "update"),
            teamId,
          );
          return yield* teamSystem.rename(proof.actor, {
            organizationId: proof.organizationId,
            teamId,
            name,
          });
        },
      );

      const removeTeam: OrganizationShape["removeTeam"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId) {
          const proof = yield* access.requireOnTeam(
            caller,
            organizationId,
            statement("team", "delete"),
            teamId,
          );
          yield* teamSystem.remove(proof.actor, { organizationId: proof.organizationId, teamId });
        },
      );

      const addTeamMember: OrganizationShape["addTeamMember"] = Effect.fnUntraced(function* (
        caller,
        organizationId,
        teamId,
        targetUserId,
        role = ["member"],
      ) {
        const proof = yield* access.requireOnTeam(
          caller,
          organizationId,
          statement("team", "update"),
          teamId,
        );
        return yield* teamSystem.addMember(proof.actor, {
          organizationId: proof.organizationId,
          teamId,
          userId: targetUserId,
          role,
          bound: proof.bound,
        });
      });

      const updateTeamMemberRole: OrganizationShape["updateTeamMemberRole"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId, role) {
          const proof = yield* access.requireOnTeam(
            caller,
            organizationId,
            statement("team", "update"),
            teamId,
          );
          return yield* teamSystem.setMemberRole(proof.actor, {
            organizationId: proof.organizationId,
            teamId,
            userId: targetUserId,
            role,
            bound: proof.bound,
          });
        },
      );

      const removeTeamMember: OrganizationShape["removeTeamMember"] = Effect.fnUntraced(
        function* (caller, organizationId, teamId, targetUserId) {
          const proof = yield* access.requireOnTeam(
            caller,
            organizationId,
            statement("team", "update"),
            teamId,
          );
          yield* teamSystem.removeMember(proof.actor, {
            organizationId: proof.organizationId,
            teamId,
            userId: targetUserId,
          });
        },
      );

      const setActiveTeam: OrganizationShape["setActiveTeam"] = (caller, teamId) =>
        activeSystem.setTeam(
          OrganizationActiveContext.sessionOf(caller),
          Option.fromNullOr(teamId),
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
