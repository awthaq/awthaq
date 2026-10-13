// @awthaq/organization — OrganizationMembers
//
// Membership as a system interface (ADR-EA-040): adding a member, making a member's roles exactly
// a set, and removing a member, for any trusted caller (an HTTP member through the authorized
// layer, a SCIM connection provisioning, an identity provider mapping roles, application code).
// Every mutation takes an explicit `Actor` and a `Bound` where it confers roles, and owns the
// membership invariants once:
//
//   the owner invariant (an organization keeps an owner), the membership limit, known role
//   names, the `Bound`, MTI-003 uniqueness, the veto point, one transaction for a removal's
//   cascade (membership, active context, team memberships; CWM-003), events, observe points.
//
// Events and observe points run after the module's own transaction ends.

import { AuthEvents, Errors, HookPoint, Users } from "@awthaq/core";
import { Defects, SqlTransaction, Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationActor from "./OrganizationActor.ts";
import * as OrganizationAuthority from "./OrganizationAuthority.ts";
import { OrganizationConfig } from "./OrganizationConfig.ts";
import * as OrganizationErrors from "./OrganizationErrors.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";
import { requireWithin } from "./internal/bound.ts";
import { limitsOf } from "./internal/limits.ts";

export type Membership = MembershipRecords.MembershipRecord;

/** A caller's own memberships, whichever organizations they are in. */
const ownMembershipsGrant = TenantScoped.crossTenant(
  "organization members: a user's own memberships across organizations, keyed by the caller's identity",
);

export interface OrganizationMembersShape {
  /** RRC-003 decision read (primary). */
  readonly find: (
    organizationId: string,
    userId: Users.UserId,
  ) => Effect.Effect<Option.Option<Membership>, Errors.StoreUnavailable>;
  readonly list: (
    organizationId: string,
    page?: MembershipRecords.ListMembersInput,
  ) => Effect.Effect<
    ReadonlyArray<Membership>,
    OrganizationErrors.OrganizationNotFound | Errors.StoreUnavailable
  >;
  /** Every membership of the user, whichever organizations they are in (a suspended organization included). */
  readonly listForUser: (
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<Membership>, Errors.StoreUnavailable>;

  /**
   * Adds a member. Order: suspension, `membershipLimit` (with `limitsFor`), the veto point, known role names
   * and the `Bound` over what the vetoed roles confer, MTI-003 uniqueness, the write, `memberAdded`,
   * `AfterAddMember`. A trusted source with nothing to be bounded by (SCIM's configured role, a seed) passes
   * `Unbounded`.
   */
  readonly add: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly userId: Users.UserId;
      readonly role: ReadonlyArray<string>;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    Membership,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.MembershipLimitReached
    | OrganizationErrors.AlreadyMember
    | OrganizationErrors.UnknownOrgRole
    | OrganizationErrors.RolePermissionEscalation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * Makes the member's roles exactly `roles`: the one implementation behind an HTTP role change and a SAML
   * role mapping. Order: the target (or `add` when `ifAbsent: "add"`), the "unchanged" short-circuit (no
   * write, veto, event or observer), known role names, the `Bound` over the requested roles and over what the
   * member holds now (a source never reshapes a member who out-privileges it), the owner invariant, the veto
   * point, the `Bound` again over the VETOED roles (a tap may rewrite them), the write, `memberRoleUpdated`,
   * `AfterUpdateMemberRole`.
   */
  readonly setRoles: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly userId: Users.UserId;
      readonly roles: ReadonlyArray<string>;
      readonly bound: OrganizationActor.Bound;
      readonly ifAbsent: "fail" | "add";
    },
  ) => Effect.Effect<
    { readonly membership: Membership; readonly change: "added" | "updated" | "unchanged" },
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.MembershipLimitReached
    | OrganizationErrors.AlreadyMember
    | OrganizationErrors.UnknownOrgRole
    | OrganizationErrors.RolePermissionEscalation
    | OrganizationErrors.OwnerInvariantViolation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * Removes a member (`leave` is this with the user as the actor). The owner invariant, the veto point, then
   * ONE transaction: the membership, every session's active pointer to the organization, and the user's team
   * memberships in it (CWM-003); then `memberRemoved`, per team `teamMemberRemoved` and
   * `AfterRemoveTeamMember`, and `AfterRemoveMember`.
   */
  readonly remove: (
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string; readonly userId: Users.UserId },
  ) => Effect.Effect<
    void,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.OwnerInvariantViolation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
}

export class OrganizationMembers extends Context.Service<
  OrganizationMembers,
  OrganizationMembersShape
>()("awthaq/plugin/organization/Members") {
  static readonly layer = Layer.effect(
    OrganizationMembers,
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const builtConfig = yield* OrganizationConfig;
      const configNow = Tenant.configInForce(OrganizationConfig, builtConfig);
      const beforeAdd = yield* OrganizationHooks.BeforeAddMember;
      const afterAdd = yield* OrganizationHooks.AfterAddMember;
      const beforeRemove = yield* OrganizationHooks.BeforeRemoveMember;
      const afterRemove = yield* OrganizationHooks.AfterRemoveMember;
      const beforeUpdateRole = yield* OrganizationHooks.BeforeUpdateMemberRole;
      const afterUpdateRole = yield* OrganizationHooks.AfterUpdateMemberRole;
      const afterRemoveTeamMember = yield* OrganizationHooks.AfterRemoveTeamMember;

      /** EP-003: a suspended organization answers exactly like an unknown one (MTI-009, BEH-EA-237). */
      const requireActive = (organizationId: string) =>
        orgs.findById(organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationErrors.OrganizationNotFound()),
              onSome: (record) =>
                Option.isSome(record.suspendedAt)
                  ? Effect.fail(new OrganizationErrors.OrganizationNotFound())
                  : Effect.void,
            }),
          ),
        );

      /** RRM-001/RRM-002: every role-assignment path stores only role names this organization recognizes. */
      const requireKnownRoles = (
        byRole: ReadonlyMap<string, PermissionEngine.Statements>,
        roleNames: ReadonlyArray<string>,
      ) =>
        roleNames.some((name) => !byRole.has(name))
          ? Effect.fail(new OrganizationErrors.UnknownOrgRole())
          : Effect.void;

      /** True iff removing a membership, or taking `owner` away from its roles, would leave zero owners. */
      const wouldViolateOwnerInvariant = (
        organizationId: string,
        targetHeldOwner: boolean,
        nextHeldOwner: boolean,
      ) =>
        targetHeldOwner && !nextHeldOwner
          ? members.countOwners(organizationId).pipe(Effect.map((count) => count <= 1))
          : Effect.succeed(false);

      const requireTarget = (organizationId: string, userId: Users.UserId) =>
        members.findByUserAndOrg(userId, organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationErrors.MembershipNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const find: OrganizationMembersShape["find"] = (organizationId, userId) =>
        members.findByUserAndOrg(userId, organizationId);

      const list: OrganizationMembersShape["list"] = (organizationId, page) =>
        requireActive(organizationId).pipe(
          Effect.andThen(members.listByOrganization(organizationId, page)),
        );

      const listForUser: OrganizationMembersShape["listForUser"] = (userId) =>
        members.listByUser(ownMembershipsGrant, userId);

      const add: OrganizationMembersShape["add"] = Effect.fnUntraced(function* (actor, input) {
        const { organizationId, userId, role, bound } = input;
        yield* requireActive(organizationId);
        const orgConfig = yield* configNow;
        const count = yield* members.countByOrganization(organizationId);
        if (count >= (yield* limitsOf(orgConfig, organizationId)).membershipLimit) {
          return yield* new OrganizationErrors.MembershipLimitReached();
        }
        const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeAddMember)(
          beforeAdd.run({ actor, organizationId, userId, role }),
        );
        // RRM-001: only role names the organization recognizes, and nothing beyond the bound.
        const byRole = yield* authority.statementsByRole(organizationId);
        yield* requireKnownRoles(byRole, vetoed.role);
        yield* requireWithin(bound, PermissionEngine.effectivePermissions(vetoed.role, byRole));
        // MTI-003: never overwrite or duplicate an existing membership: a role change is `setRoles`.
        const existing = yield* members.findByUserAndOrg(userId, organizationId);
        if (Option.isSome(existing)) return yield* new OrganizationErrors.AlreadyMember();
        const membership = yield* members
          .create({ userId, organizationId, role: vetoed.role })
          .pipe(
            Effect.catchTag("MembershipRecordAlreadyExists", () =>
              Effect.fail(new OrganizationErrors.AlreadyMember()),
            ),
          );
        yield* events.publish({
          _tag: "auth.organization.memberAdded",
          organizationId,
          userId,
          role: vetoed.role,
        });
        yield* afterAdd.run({ actor, organizationId, userId, role: vetoed.role });
        return membership;
      });

      const setRoles: OrganizationMembersShape["setRoles"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, userId, roles, bound } = input;
          yield* requireActive(organizationId);
          const existing = yield* members.findByUserAndOrg(userId, organizationId);
          if (Option.isNone(existing)) {
            if (input.ifAbsent === "fail")
              return yield* new OrganizationErrors.MembershipNotFound();
            // A source with nothing to hold yet: its ceiling still bounds what it adds.
            const membership = yield* add(actor, { organizationId, userId, role: roles, bound });
            return { membership, change: "added" as const };
          }
          const current = existing.value;
          // D5: nothing changes, so there is nothing to veto, publish or observe.
          if (
            current.role.length === roles.length &&
            roles.every((name) => current.role.includes(name))
          ) {
            return { membership: current, change: "unchanged" as const };
          }
          const byRole = yield* authority.statementsByRole(organizationId);
          yield* requireKnownRoles(byRole, roles);
          // RRM-001: a source never reshapes a member who out-privileges it, whatever it asks for.
          yield* requireWithin(
            bound,
            PermissionEngine.effectivePermissions(roles, byRole),
            PermissionEngine.effectivePermissions(current.role, byRole),
          );
          if (
            yield* wouldViolateOwnerInvariant(
              organizationId,
              current.role.includes("owner"),
              roles.includes("owner"),
            )
          ) {
            return yield* new OrganizationErrors.OwnerInvariantViolation();
          }
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateMemberRole)(
            beforeUpdateRole.run({ actor, organizationId, userId, role: roles }),
          );
          // RRM-001: a tap may rewrite the roles, so the bound applies to what is stored.
          yield* requireKnownRoles(byRole, vetoed.role);
          yield* requireWithin(bound, PermissionEngine.effectivePermissions(vetoed.role, byRole));
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
          yield* afterUpdateRole.run({ actor, organizationId, userId, role: vetoed.role });
          return { membership: updated, change: "updated" as const };
        },
      );

      const remove: OrganizationMembersShape["remove"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, userId } = input;
          yield* requireActive(organizationId);
          const target = yield* requireTarget(organizationId, userId);
          if (
            yield* wouldViolateOwnerInvariant(organizationId, target.role.includes("owner"), false)
          ) {
            return yield* new OrganizationErrors.OwnerInvariantViolation();
          }
          // PCS-002: `leave` runs the same remove-member hooks, so `DecisionCacheInvalidationLive` (and any
          // other observer) sees a member leaving.
          yield* HookPoint.aborted(OrganizationHooks.BeforeRemoveMember)(
            beforeRemove.run({ actor, organizationId, userId }),
          );
          // CWM-003/N9: removing a membership also drops everything that hangs off it, in one
          // transaction, so a removed member can no longer answer `team-member` in qadi or keep the
          // organization "active".
          const leftTeams = yield* sqlTransaction
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
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId,
          });
          for (const teamId of leftTeams) {
            yield* events.publish({
              _tag: "auth.organization.teamMemberRemoved",
              organizationId,
              teamId,
              userId,
            });
            yield* afterRemoveTeamMember.run({ actor, organizationId, teamId, userId });
          }
          yield* afterRemove.run({ actor, organizationId, userId });
        },
      );

      return OrganizationMembers.of({ find, list, listForUser, add, setRoles, remove });
    }),
  );
}
