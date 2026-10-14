// @awthaq/organization — OrganizationTeams
//
// The team forest as a system interface (ADR-EA-040): the team tree, its rosters and their
// invariants, for any trusted caller. Every mutation takes an explicit `Actor` (for audit and hook
// taps), never an `Api.UserPrincipal`: who may do what is the authorized interface's decision
// (`Organization.ts`: MTI-009 visibility, `PermissionEngine`, the caller's `Bound`); what a team
// operation *means* lives here once, for every caller:
//
//   guards (suspension, `teams.enabled`, quotas, the last-team rule)
//     → veto (`HookPoint.aborted(BeforeX)`)
//     → writes in one `SqlTransaction` (+ the caller's `attach`)
//     → events → observe point
//
// Events and observe points run only after this module's own transaction has ended, exactly like
// `Organization.delete` always did. SCIM Groups, the HTTP endpoints and application code all
// reach the same implementation, so a veto, a quota or a decision-cache invalidation cannot be
// skipped by a caller that writes the records instead.

import { AuthEvents, Errors, HookPoint, Users } from "@awthaq/core";
import { Defects, SqlTransaction, Tenant } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "./ActiveContextRecords.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as OrganizationActor from "./OrganizationActor.ts";
import * as OrganizationAuthority from "./OrganizationAuthority.ts";
import { OrganizationConfig } from "./OrganizationConfig.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";
import * as OrganizationErrors from "./OrganizationErrors.ts";
import * as OrganizationHooks from "./OrganizationHooks.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";
import { requireWithin } from "./internal/bound.ts";
import { limitsOf } from "./internal/limits.ts";

export type Team = TeamRecords.TeamRecord;
export type TeamMembership = TeamRecords.TeamMembershipRecord;

/** What every team operation checks first: the organization is visible (not suspended) and teams are on. */
type TeamGate = OrganizationErrors.OrganizationNotFound | OrganizationErrors.TeamsDisabled;

export interface OrganizationTeamsShape {
  /** `teams.enabled` in force for this fiber (per-tenant config). The authorized layer calls it after MTI-009 (PV-300). */
  readonly requireEnabled: Effect.Effect<void, OrganizationErrors.TeamsDisabled>;
  readonly find: (
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<Option.Option<Team>, Errors.StoreUnavailable>;
  readonly list: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<Team>, Errors.StoreUnavailable>;
  /** Every team of the organization the user is on. */
  readonly listForUser: (
    organizationId: string,
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<Team>, Errors.StoreUnavailable>;
  /** OHS-001: the team's ancestors, nearest first. */
  readonly ancestors: (
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<
    ReadonlyArray<Team>,
    OrganizationErrors.TeamNotFound | Errors.StoreUnavailable
  >;
  /** OHS-001: every team below this one, nearest first. */
  readonly descendants: (
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<
    ReadonlyArray<Team>,
    OrganizationErrors.TeamNotFound | Errors.StoreUnavailable
  >;
  readonly members: (
    organizationId: string,
    teamId: string,
  ) => Effect.Effect<
    ReadonlyArray<TeamMembership>,
    OrganizationErrors.TeamNotFound | Errors.StoreUnavailable
  >;
  readonly membership: (
    teamId: string,
    userId: Users.UserId,
  ) => Effect.Effect<Option.Option<TeamMembership>, Errors.StoreUnavailable>;

  /**
   * Creates a team. Guards: suspension, `teams.enabled`, the parent is in the organization, `maximumTeams`,
   * and, for `initialMembers` (each an organization member, added with the `member` team role), the
   * `maximumMembersPerTeam` limit on the final count. `BeforeCreateTeam` runs before any write; the team,
   * its initial members and `attach` are one transaction (`attach` runs after the module's own writes and
   * before any event, may touch only the caller's own tables, and must not call a system interface: its
   * events would escape this transaction). A failure of any step leaves no team behind, on SQL by rolling
   * back and on a backend without transactions by removing the team again.
   */
  readonly create: <A = void, E = never, R = never>(
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly name: string;
      readonly parentId?: string | undefined;
      readonly initialMembers?: ReadonlyArray<Users.UserId> | undefined;
    },
    options?: { readonly attach?: (team: Team) => Effect.Effect<A, E, R> },
  ) => Effect.Effect<
    { readonly team: Team; readonly attached: A | undefined },
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.TeamLimitReached
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.TeamMemberLimitReached
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
    | E,
    R
  >;
  readonly rename: (
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string; readonly teamId: string; readonly name: string },
  ) => Effect.Effect<
    Team,
    TeamGate | OrganizationErrors.TeamNotFound | HookPoint.HookAborted | Errors.StoreUnavailable
  >;
  readonly move: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly teamId: string;
      readonly parentId: Option.Option<string>;
    },
  ) => Effect.Effect<
    Team,
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.TeamHierarchyCycle
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * `allowRemovingAllTeams` (`LastTeamCannotBeRemoved`), `TeamHasChildren` (before the veto, and re-checked
   * atomically by the records); then, in one transaction, the team, its memberships, every session's active
   * pointer to it, and `attach`. After the transaction: `teamDeleted` and `AfterDeleteTeam`.
   */
  readonly remove: <E = never, R = never>(
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string; readonly teamId: string },
    options?: { readonly attach?: () => Effect.Effect<void, E, R> },
  ) => Effect.Effect<
    void,
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.LastTeamCannotBeRemoved
    | OrganizationErrors.TeamHasChildren
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
    | E,
    R
  >;
  /** The target is an organization member; known team roles; the `Bound` over the requested statements; `maximumMembersPerTeam`; unique (OHS-003). */
  readonly addMember: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly teamId: string;
      readonly userId: Users.UserId;
      readonly role?: ReadonlyArray<string> | undefined;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    TeamMembership,
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.TeamMemberLimitReached
    | OrganizationErrors.AlreadyTeamMember
    | OrganizationErrors.UnknownTeamRole
    | OrganizationErrors.RolePermissionEscalation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** Known team roles; the `Bound` over the requested statements and over what the member holds now. */
  readonly setMemberRole: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly teamId: string;
      readonly userId: Users.UserId;
      readonly role: ReadonlyArray<string>;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    TeamMembership,
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.TeamMembershipNotFound
    | OrganizationErrors.UnknownTeamRole
    | OrganizationErrors.RolePermissionEscalation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  readonly removeMember: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly teamId: string;
      readonly userId: Users.UserId;
    },
  ) => Effect.Effect<
    void,
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.TeamMembershipNotFound
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /**
   * A roster change as one unit (SCIM PUT/PATCH members). Idempotent per user: adding a member already on
   * the team, or removing one who is not, is skipped, not an error (a user named in both lists is added).
   * Every veto runs before any write, `maximumMembersPerTeam` is checked against the FINAL count, the writes
   * are one transaction, and one event and one observe point follow per user actually changed.
   */
  readonly applyRoster: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly teamId: string;
      readonly add: ReadonlyArray<Users.UserId>;
      readonly remove: ReadonlyArray<Users.UserId>;
      readonly role?: ReadonlyArray<string> | undefined;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    { readonly added: ReadonlyArray<Users.UserId>; readonly removed: ReadonlyArray<Users.UserId> },
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.TeamMemberLimitReached
    | OrganizationErrors.UnknownTeamRole
    | OrganizationErrors.RolePermissionEscalation
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
}

const DEFAULT_TEAM_ROLE: ReadonlyArray<string> = ["member"];

const vanished = (what: string) =>
  Defects.invariantViolation("RowVanished", `awthaq: ${what} vanished between check and write`);

export class OrganizationTeams extends Context.Service<OrganizationTeams, OrganizationTeamsShape>()(
  "awthaq/plugin/organization/Teams",
) {
  static readonly layer = Layer.effect(
    OrganizationTeams,
    Effect.gen(function* () {
      // Every service is yielded once, here: one captured inside an operation would leak into the
      // `Requires` marker of `HttpApiBuilder` (plan 04 §3.4, ticket 19's rule).
      const events = yield* AuthEvents.AuthEvents;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const members = yield* MembershipRecords.MembershipRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      // EP-007 (ADR-EA-018): the configuration in force is decided per operation.
      const builtConfig = yield* OrganizationConfig;
      const configNow = Tenant.configInForce(OrganizationConfig, builtConfig);
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

      const requireEnabled: OrganizationTeamsShape["requireEnabled"] = Effect.flatMap(
        configNow,
        (orgConfig) =>
          orgConfig.teams.enabled
            ? Effect.void
            : Effect.fail(new OrganizationErrors.TeamsDisabled()),
      );

      /** EP-003: a suspended organization answers exactly like an unknown one (MTI-009, BEH-EA-237). */
      const requireActive = (organizationId: string) =>
        Effect.asVoid(directory.requireActive(organizationId));

      const gate = (organizationId: string) =>
        requireActive(organizationId).pipe(Effect.andThen(requireEnabled));

      const requireTeam = (organizationId: string, teamId: string) =>
        teams.findTeamById(organizationId, teamId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationErrors.TeamNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      const limits = (organizationId: string) =>
        Effect.flatMap(configNow, (orgConfig) => limitsOf(orgConfig, organizationId));

      /** OHS-004: the names must be defined team roles, and what they confer (and what the target holds now) must fit the bound. */
      const requireTeamRoles = Effect.fnUntraced(function* (
        bound: OrganizationActor.Bound,
        roleNames: ReadonlyArray<string>,
        current?: ReadonlyArray<string>,
      ) {
        const roleStatements = yield* authority.teamRoleStatements;
        if (roleNames.some((name) => !roleStatements.has(name))) {
          return yield* new OrganizationErrors.UnknownTeamRole();
        }
        yield* requireWithin(
          bound,
          PermissionEngine.effectivePermissions(roleNames, roleStatements),
          current === undefined
            ? undefined
            : PermissionEngine.effectivePermissions(current, roleStatements),
        );
      });

      const requireOrganizationMember = (organizationId: string, userId: Users.UserId) =>
        members.findByUserAndOrg(userId, organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationErrors.MembershipNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        );

      // ---- reads ------------------------------------------------------------------------

      const find: OrganizationTeamsShape["find"] = (organizationId, teamId) =>
        teams.findTeamById(organizationId, teamId);
      const list: OrganizationTeamsShape["list"] = (organizationId) =>
        teams.listTeamsByOrganization(organizationId);
      const listForUser: OrganizationTeamsShape["listForUser"] = (organizationId, userId) =>
        teams.listTeamsByUser(organizationId, userId);
      const ancestors: OrganizationTeamsShape["ancestors"] = (organizationId, teamId) =>
        requireTeam(organizationId, teamId).pipe(
          Effect.andThen(teams.getAncestors(organizationId, teamId)),
        );
      const descendants: OrganizationTeamsShape["descendants"] = (organizationId, teamId) =>
        requireTeam(organizationId, teamId).pipe(
          Effect.andThen(teams.getDescendants(organizationId, teamId)),
        );
      const teamMembers: OrganizationTeamsShape["members"] = (organizationId, teamId) =>
        requireTeam(organizationId, teamId).pipe(Effect.andThen(teams.listTeamMembers(teamId)));
      const membership: OrganizationTeamsShape["membership"] = (teamId, userId) =>
        teams.findTeamMembership(teamId, userId);

      // ---- team lifecycle --------------------------------------------------------------

      const create: OrganizationTeamsShape["create"] = Effect.fnUntraced(
        function* (actor, input, options) {
          const { organizationId, name, parentId } = input;
          yield* gate(organizationId);
          if (parentId !== undefined) yield* requireTeam(organizationId, parentId);
          const teamLimits = yield* limits(organizationId);
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count >= teamLimits.maximumTeams) {
            return yield* new OrganizationErrors.TeamLimitReached();
          }
          const initial = [...new Set(input.initialMembers ?? [])];
          for (const userId of initial) yield* requireOrganizationMember(organizationId, userId);
          // TML on the final count: nothing is written when the roster alone is over the limit.
          if (initial.length > teamLimits.maximumMembersPerTeam) {
            return yield* new OrganizationErrors.TeamMemberLimitReached();
          }
          const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeCreateTeam)(
            beforeCreateTeam.run({ actor, organizationId, name, parentId }),
          );
          const { team, attached } = yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                const created = yield* teams
                  .createTeam({ organizationId, name: vetoed.name, parentId: vetoed.parentId })
                  .pipe(
                    Effect.catchTag("TeamRecordNotFound", () =>
                      Effect.fail(new OrganizationErrors.TeamNotFound()),
                    ),
                  );
                return yield* Effect.gen(function* () {
                  for (const userId of initial) {
                    // A veto on a roster member aborts the whole creation: the team is not made.
                    yield* HookPoint.aborted(OrganizationHooks.BeforeAddTeamMember)(
                      beforeAddTeamMember.run({
                        actor,
                        organizationId,
                        teamId: created.id,
                        userId,
                        role: DEFAULT_TEAM_ROLE,
                      }),
                    );
                    yield* teams
                      .addTeamMember({ teamId: created.id, userId, role: DEFAULT_TEAM_ROLE })
                      .pipe(
                        Effect.catchTag("TeamMembershipRecordAlreadyExists", () =>
                          vanished("a fresh team's roster"),
                        ),
                      );
                  }
                  const fresh =
                    initial.length === 0
                      ? created
                      : Option.getOrElse(
                          yield* teams.findTeamById(organizationId, created.id),
                          () => created,
                        );
                  const result =
                    options?.attach === undefined ? undefined : yield* options.attach(fresh);
                  return { team: fresh, attached: result };
                }).pipe(
                  // A backend without transactions (`SqlTransaction.layerNoop`) cannot roll back: the
                  // team is removed again so a failed creation leaves nothing behind. Over SQL the
                  // rollback has already done it (or is about to) and this is a harmless no-op.
                  Effect.onError(() => Effect.ignore(teams.removeTeam(organizationId, created.id))),
                );
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({
            _tag: "auth.organization.teamCreated",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId,
            teamId: team.id,
          });
          for (const userId of initial) {
            yield* events.publish({
              _tag: "auth.organization.teamMemberAdded",
              actorUserId: OrganizationActor.userIdOf(actor),
              organizationId,
              teamId: team.id,
              userId,
            });
          }
          yield* afterCreateTeam.run({
            actor,
            organizationId,
            name: vetoed.name,
            parentId: vetoed.parentId,
            teamId: team.id,
          });
          for (const userId of initial) {
            yield* afterAddTeamMember.run({
              actor,
              organizationId,
              teamId: team.id,
              userId,
              role: DEFAULT_TEAM_ROLE,
            });
          }
          return { team, attached };
        },
      );

      const rename: OrganizationTeamsShape["rename"] = Effect.fnUntraced(function* (actor, input) {
        const { organizationId, teamId, name } = input;
        yield* gate(organizationId);
        yield* requireTeam(organizationId, teamId);
        const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateTeam)(
          beforeUpdateTeam.run({ actor, organizationId, teamId, name }),
        );
        const updated = yield* teams
          .updateTeam(organizationId, teamId, vetoed.name)
          .pipe(Effect.catchTag("TeamRecordNotFound", () => vanished("team")));
        yield* events.publish({
          _tag: "auth.organization.teamUpdated",
          actorUserId: OrganizationActor.userIdOf(actor),
          organizationId,
          teamId,
        });
        yield* afterUpdateTeam.run({ actor, organizationId, teamId, name: vetoed.name });
        return updated;
      });

      const move: OrganizationTeamsShape["move"] = Effect.fnUntraced(function* (actor, input) {
        const { organizationId, teamId, parentId } = input;
        yield* gate(organizationId);
        yield* requireTeam(organizationId, teamId);
        if (Option.isSome(parentId)) yield* requireTeam(organizationId, parentId.value);
        const vetoed = yield* HookPoint.aborted(OrganizationHooks.BeforeMoveTeam)(
          beforeMoveTeam.run({
            actor,
            organizationId,
            teamId,
            parentId: Option.getOrNull(parentId),
          }),
        );
        const moved = yield* teams
          .moveTeam({ organizationId, id: teamId, parentId: Option.fromNullOr(vetoed.parentId) })
          .pipe(
            Effect.catchTags({
              TeamRecordNotFound: () => Effect.fail(new OrganizationErrors.TeamNotFound()),
              "TeamRecords/HierarchyCycle": () =>
                Effect.fail(new OrganizationErrors.TeamHierarchyCycle()),
            }),
          );
        yield* events.publish({
          _tag: "auth.organization.teamMoved",
          actorUserId: OrganizationActor.userIdOf(actor),
          organizationId,
          teamId,
          parentId: vetoed.parentId,
        });
        yield* afterMoveTeam.run({ actor, organizationId, teamId, parentId: vetoed.parentId });
        return moved;
      });

      const remove: OrganizationTeamsShape["remove"] = Effect.fnUntraced(
        function* (actor, input, options) {
          const { organizationId, teamId } = input;
          yield* gate(organizationId);
          yield* requireTeam(organizationId, teamId);
          const count = yield* teams.countTeamsByOrganization(organizationId);
          if (count <= 1 && !(yield* configNow).teams.allowRemovingAllTeams) {
            return yield* new OrganizationErrors.LastTeamCannotBeRemoved();
          }
          // OHS-001: refuse before the veto hook runs; the records layer re-checks atomically.
          const below = yield* teams.getDescendants(organizationId, teamId);
          if (below.length > 0) return yield* new OrganizationErrors.TeamHasChildren();
          yield* HookPoint.aborted(OrganizationHooks.BeforeDeleteTeam)(
            beforeDeleteTeam.run({ actor, organizationId, teamId }),
          );
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* teams.removeTeam(organizationId, teamId).pipe(
                  Effect.catchTags({
                    TeamRecordNotFound: () => vanished("team"),
                    "TeamRecords/HasChildren": () =>
                      Effect.fail(new OrganizationErrors.TeamHasChildren()),
                  }),
                );
                // CWM-003/OHS-007: no session may keep the deleted team active.
                yield* activeContext.clearTeam(teamId);
                if (options?.attach !== undefined) yield* options.attach();
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          yield* events.publish({
            _tag: "auth.organization.teamDeleted",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId,
            teamId,
          });
          yield* afterDeleteTeam.run({ actor, organizationId, teamId });
        },
      );

      // ---- rosters ------------------------------------------------------------------------

      const addMember: OrganizationTeamsShape["addMember"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, teamId, userId, bound } = input;
          const role = input.role ?? DEFAULT_TEAM_ROLE;
          yield* gate(organizationId);
          const team = yield* requireTeam(organizationId, teamId);
          yield* requireTeamRoles(bound, role);
          yield* requireOrganizationMember(organizationId, userId);
          if (team.memberCount >= (yield* limits(organizationId)).maximumMembersPerTeam) {
            return yield* new OrganizationErrors.TeamMemberLimitReached();
          }
          yield* HookPoint.aborted(OrganizationHooks.BeforeAddTeamMember)(
            beforeAddTeamMember.run({ actor, organizationId, teamId, userId, role }),
          );
          // OHS-003: a second add is refused: it would over-count `memberCount`.
          const onTeam = yield* teams.findTeamMembership(teamId, userId);
          if (Option.isSome(onTeam)) return yield* new OrganizationErrors.AlreadyTeamMember();
          const record = yield* teams
            .addTeamMember({ teamId, userId, role })
            .pipe(
              Effect.catchTag("TeamMembershipRecordAlreadyExists", () =>
                Effect.fail(new OrganizationErrors.AlreadyTeamMember()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMemberAdded",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId,
            teamId,
            userId,
          });
          yield* afterAddTeamMember.run({ actor, organizationId, teamId, userId, role });
          return record;
        },
      );

      const setMemberRole: OrganizationTeamsShape["setMemberRole"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, teamId, userId, role, bound } = input;
          yield* gate(organizationId);
          yield* requireTeam(organizationId, teamId);
          const target = yield* teams.findTeamMembership(teamId, userId);
          if (Option.isNone(target)) return yield* new OrganizationErrors.TeamMembershipNotFound();
          yield* requireTeamRoles(bound, role, target.value.role);
          yield* HookPoint.aborted(OrganizationHooks.BeforeUpdateTeamMemberRole)(
            beforeUpdateTeamMemberRole.run({ actor, organizationId, teamId, userId, role }),
          );
          const updated = yield* teams
            .updateTeamMemberRole(teamId, userId, role)
            .pipe(
              Effect.catchTag("TeamMembershipRecordNotFound", () =>
                Effect.fail(new OrganizationErrors.TeamMembershipNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMemberRoleUpdated",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId,
            teamId,
            userId,
            role,
          });
          yield* afterUpdateTeamMemberRole.run({ actor, organizationId, teamId, userId, role });
          return updated;
        },
      );

      const removeMember: OrganizationTeamsShape["removeMember"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, teamId, userId } = input;
          yield* gate(organizationId);
          yield* requireTeam(organizationId, teamId);
          yield* HookPoint.aborted(OrganizationHooks.BeforeRemoveTeamMember)(
            beforeRemoveTeamMember.run({ actor, organizationId, teamId, userId }),
          );
          yield* teams
            .removeTeamMember(teamId, userId)
            .pipe(
              Effect.catchTag("TeamMembershipRecordNotFound", () =>
                Effect.fail(new OrganizationErrors.TeamMembershipNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.organization.teamMemberRemoved",
            actorUserId: OrganizationActor.userIdOf(actor),
            organizationId,
            teamId,
            userId,
          });
          yield* afterRemoveTeamMember.run({ actor, organizationId, teamId, userId });
        },
      );

      const applyRoster: OrganizationTeamsShape["applyRoster"] = Effect.fnUntraced(
        function* (actor, input) {
          const { organizationId, teamId, bound } = input;
          const role = input.role ?? DEFAULT_TEAM_ROLE;
          yield* gate(organizationId);
          const team = yield* requireTeam(organizationId, teamId);
          // Idempotent per user: the roster as it is now decides what actually changes.
          const wanted = [...new Set(input.add)];
          const unwanted = [...new Set(input.remove)].filter((userId) => !wanted.includes(userId));
          const toAdd: Array<Users.UserId> = [];
          for (const userId of wanted) {
            if (Option.isNone(yield* teams.findTeamMembership(teamId, userId))) toAdd.push(userId);
          }
          const toRemove: Array<Users.UserId> = [];
          for (const userId of unwanted) {
            if (Option.isSome(yield* teams.findTeamMembership(teamId, userId)))
              toRemove.push(userId);
          }
          if (toAdd.length > 0) {
            yield* requireTeamRoles(bound, role);
            for (const userId of toAdd) yield* requireOrganizationMember(organizationId, userId);
            // TML against the FINAL count, so a roster swap at the limit is not refused.
            const finalCount = team.memberCount + toAdd.length - toRemove.length;
            if (finalCount > (yield* limits(organizationId)).maximumMembersPerTeam) {
              return yield* new OrganizationErrors.TeamMemberLimitReached();
            }
          }
          // Every veto runs before any write.
          for (const userId of toAdd) {
            yield* HookPoint.aborted(OrganizationHooks.BeforeAddTeamMember)(
              beforeAddTeamMember.run({ actor, organizationId, teamId, userId, role }),
            );
          }
          for (const userId of toRemove) {
            yield* HookPoint.aborted(OrganizationHooks.BeforeRemoveTeamMember)(
              beforeRemoveTeamMember.run({ actor, organizationId, teamId, userId }),
            );
          }
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                for (const userId of toRemove) {
                  yield* teams
                    .removeTeamMember(teamId, userId)
                    .pipe(
                      Effect.catchTag("TeamMembershipRecordNotFound", () =>
                        vanished("team membership"),
                      ),
                    );
                }
                for (const userId of toAdd) {
                  yield* teams
                    .addTeamMember({ teamId, userId, role })
                    .pipe(
                      Effect.catchTag("TeamMembershipRecordAlreadyExists", () =>
                        vanished("team roster"),
                      ),
                    );
                }
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          for (const userId of toRemove) {
            yield* events.publish({
              _tag: "auth.organization.teamMemberRemoved",
              actorUserId: OrganizationActor.userIdOf(actor),
              organizationId,
              teamId,
              userId,
            });
            yield* afterRemoveTeamMember.run({ actor, organizationId, teamId, userId });
          }
          for (const userId of toAdd) {
            yield* events.publish({
              _tag: "auth.organization.teamMemberAdded",
              actorUserId: OrganizationActor.userIdOf(actor),
              organizationId,
              teamId,
              userId,
            });
            yield* afterAddTeamMember.run({ actor, organizationId, teamId, userId, role });
          }
          return { added: toAdd, removed: toRemove };
        },
      );

      return OrganizationTeams.of({
        requireEnabled,
        find,
        list,
        listForUser,
        ancestors,
        descendants,
        members: teamMembers,
        membership,
        create,
        rename,
        move,
        remove,
        addMember,
        setMemberRole,
        removeMember,
        applyRoster,
      });
    }),
  );
}
