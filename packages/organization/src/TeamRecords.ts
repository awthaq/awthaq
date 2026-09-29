// @awthaq/organization — TeamRecords
//
// spec.md's "Teams" (opt-in via `OrganizationConfig.teams.enabled`):
// persistence for `organization_team` and `organization_team_membership`,
// mirroring `MembershipRecords.ts`/`OrgRoleRecords.ts`'s own shape. `team`'s
// `memberCount` is a durable counter (better-auth's own design: "a durable
// counter used to enforce capacity") maintained directly on
// `addTeamMember`/`removeTeamMember` rather than recomputed via `COUNT`
// every time.
//
// OHS-002: each `layerSql` operation that is inherently several statements
// (`removeTeam`, `removeAllTeamsForOrganization`, `addTeamMember`,
// `removeTeamMember`, `removeUserFromOrganizationTeams`) runs in one
// `sql.withTransaction`, so it is atomic even when called directly; inside a
// caller's own transaction (`Organization`'s cascades) it is a savepoint. This
// is the bounded exception BEH-EA-035 documents for a plugin's own records
// service — composing *two* records calls stays the domain service's job.
//
// OHS-001 (wayfinder ticket 34): teams form a per-organization forest. `parentId`
// is the adjacency (write side); `organization_team_closure` under `layerSql`
// holds every (ancestor, descendant, depth) pair — self rows at depth 0 — so
// `getAncestors`/`getDescendants`/`getSubtree` are single indexed lookups, and
// create/move/remove keep it in step inside one transaction. `layerMemory`
// derives the same answers by walking parent pointers. Hierarchy is structure
// only: it grants no permission inheritance (OHS-004).

import { Users } from "@awthaq/core";
import { Models as SqlModels } from "@awthaq/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly memberCount: number;
  /** OHS-001: the parent team, `None` for a root. Always in the same organization. */
  readonly parentId: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

interface TeamMembershipFields {
  readonly id: string;
  readonly teamId: string;
  readonly userId: Users.UserId;
  /** OHS-004: team-scoped role names (`["member"]` by default), resolved through `OrganizationConfig.teamStatements`. */
  readonly role: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
}

/** MTI-001: branded like `MembershipRecords.MembershipRecord` — the witness `ActiveContextRecords.setTeam` requires. */
export type TeamMembershipRecord = Brand.Branded<TeamMembershipFields, "TeamMembershipRecord">;
const brandTeamMembership = Brand.nominal<TeamMembershipRecord>();

export class TeamRecordNotFound extends Data.TaggedError("TeamRecordNotFound")<{
  readonly id: string;
}> {}

/** OHS-001: a move would place a team under itself or one of its own descendants. */
export class TeamHierarchyCycle extends Data.TaggedError("TeamRecords/HierarchyCycle")<{
  readonly id: string;
  readonly parentId: string;
}> {}

/** OHS-001: a team that still has child teams cannot be removed; move or remove them first. */
export class TeamHasChildren extends Data.TaggedError("TeamRecords/HasChildren")<{
  readonly id: string;
}> {}

export class TeamMembershipRecordNotFound extends Data.TaggedError("TeamMembershipRecordNotFound")<{
  readonly teamId: string;
  readonly userId: string;
}> {}

/** OHS-003: `(teamId, userId)` is unique — a second add is refused, so `memberCount` can never over-count. */
export class TeamMembershipRecordAlreadyExists extends Data.TaggedError(
  "TeamMembershipRecordAlreadyExists",
)<{
  readonly teamId: string;
  readonly userId: string;
}> {}

export interface TeamRecordsShape {
  /** With a `parentId`, that team must exist in the same organization (`TeamRecordNotFound` otherwise). */
  readonly createTeam: (input: {
    readonly organizationId: string;
    readonly name: string;
    readonly parentId?: string | undefined;
  }) => Effect.Effect<TeamRecord, TeamRecordNotFound>;
  readonly findTeamById: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<Option.Option<TeamRecord>>;
  /**
   * RZS-005: resolves a team from its id alone, for callers (the qadi
   * `team-member` relation) that are handed only a resource id and must tell
   * "no such team" apart from "not a member". Not tenant-scoped by design —
   * it answers existence, never data, to the relationship resolver.
   */
  readonly findTeamByIdAnyOrg: (id: string) => Effect.Effect<Option.Option<TeamRecord>>;
  readonly listTeamsByOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<TeamRecord>>;
  readonly countTeamsByOrganization: (organizationId: string) => Effect.Effect<number>;
  readonly updateTeam: (
    organizationId: string,
    id: string,
    name: string,
  ) => Effect.Effect<TeamRecord, TeamRecordNotFound>;
  /**
   * OHS-001: re-parents a team — with its whole subtree — under `parentId`, or
   * to the root with `None`. A parent in another organization is
   * `TeamRecordNotFound`; the team itself or any of its descendants is
   * `TeamHierarchyCycle`.
   */
  readonly moveTeam: (input: {
    readonly organizationId: string;
    readonly id: string;
    readonly parentId: Option.Option<string>;
  }) => Effect.Effect<TeamRecord, TeamRecordNotFound | TeamHierarchyCycle>;
  /** OHS-001: the team's ancestors, nearest first, excluding the team itself. */
  readonly getAncestors: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<ReadonlyArray<TeamRecord>>;
  /** OHS-001: every team below this one, nearest first, excluding the team itself. */
  readonly getDescendants: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<ReadonlyArray<TeamRecord>>;
  /** OHS-001: the team itself followed by its descendants. */
  readonly getSubtree: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<ReadonlyArray<TeamRecord>>;
  /**
   * Removes the team and cascades every one of its `TeamMembershipRecord` rows.
   * OHS-001: a team with children is `TeamHasChildren`.
   */
  readonly removeTeam: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<void, TeamRecordNotFound | TeamHasChildren>;
  /** Used by `Organization.delete`'s own cascade. */
  readonly removeAllTeamsForOrganization: (organizationId: string) => Effect.Effect<void>;
  /** Increments the owning team's `memberCount`; atomic with the row insert under `layerSql`. */
  readonly addTeamMember: (input: {
    readonly teamId: string;
    readonly userId: Users.UserId;
    readonly role?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<TeamMembershipRecord, TeamMembershipRecordAlreadyExists>;
  /** OHS-004: replaces a team membership's role names. */
  readonly updateTeamMemberRole: (
    teamId: string,
    userId: Users.UserId,
    role: ReadonlyArray<string>,
  ) => Effect.Effect<TeamMembershipRecord, TeamMembershipRecordNotFound>;
  /** Decrements the owning team's `memberCount`. */
  readonly removeTeamMember: (
    teamId: string,
    userId: Users.UserId,
  ) => Effect.Effect<void, TeamMembershipRecordNotFound>;
  /**
   * CWM-003/N9: removes a user from every team of one organization (the
   * user left or was removed from it), decrementing each `memberCount`.
   * Returns the ids of the teams the user was actually on, so the caller can
   * publish one `teamMemberRemoved` per row. Atomic under `layerSql`.
   */
  readonly removeUserFromOrganizationTeams: (
    organizationId: string,
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly findTeamMembership: (
    teamId: string,
    userId: Users.UserId,
  ) => Effect.Effect<Option.Option<TeamMembershipRecord>>;
  readonly listTeamMembers: (teamId: string) => Effect.Effect<ReadonlyArray<TeamMembershipRecord>>;
  /** Every team, within one organization, the given user belongs to. */
  readonly listTeamsByUser: (
    organizationId: string,
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<TeamRecord>>;
}

export class TeamRecords extends Context.Service<TeamRecords, TeamRecordsShape>()(
  "awthaq/organization/TeamRecords",
) {}

const teamNotFound = (id: string): TeamRecordNotFound => new TeamRecordNotFound({ id });
const teamMembershipNotFound = (teamId: string, userId: string): TeamMembershipRecordNotFound =>
  new TeamMembershipRecordNotFound({ teamId, userId });

// ---- layerMemory ------------------------------------------------------------

interface State {
  readonly teams: HashMap.HashMap<string, TeamRecord>;
  readonly memberships: HashMap.HashMap<string, TeamMembershipRecord>;
}

const DEFAULT_TEAM_ROLE: ReadonlyArray<string> = ["member"];

const membershipKeyOf = (teamId: string, userId: string): string => `${teamId}:${userId}`;

export const layerMemory = Layer.effect(
  TeamRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ teams: HashMap.empty(), memberships: HashMap.empty() });
    const crypto = yield* Crypto.Crypto;

    const createTeam: TeamRecordsShape["createTeam"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const record: TeamRecord = {
        id,
        name: input.name,
        organizationId: input.organizationId,
        memberCount: 0,
        parentId: Option.fromNullishOr(input.parentId),
        createdAt: now,
        updatedAt: now,
      };
      return yield* Ref.modify(
        state,
        (s): readonly [Result.Result<TeamRecord, TeamRecordNotFound>, State] => {
          if (input.parentId !== undefined) {
            const parent = HashMap.get(s.teams, input.parentId);
            if (Option.isNone(parent) || parent.value.organizationId !== input.organizationId) {
              return [Result.fail(teamNotFound(input.parentId)), s] as const;
            }
          }
          return [
            Result.succeed(record),
            { ...s, teams: HashMap.set(s.teams, id, record) },
          ] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));
    });

    // OHS-001: derived from parent pointers; the SQL layer reads its closure table instead.
    const ancestorsIn = (teams: HashMap.HashMap<string, TeamRecord>, start: TeamRecord) => {
      const chain: Array<TeamRecord> = [];
      const seen = new Set<string>([start.id]);
      let cursor = start.parentId;
      while (Option.isSome(cursor) && !seen.has(cursor.value)) {
        const next = HashMap.get(teams, cursor.value);
        if (Option.isNone(next)) break;
        seen.add(next.value.id);
        chain.push(next.value);
        cursor = next.value.parentId;
      }
      return chain;
    };

    const descendantsIn = (teams: HashMap.HashMap<string, TeamRecord>, start: TeamRecord) => {
      const all = Array.from(HashMap.values(teams)).sort(
        (a, b) =>
          a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds || a.id.localeCompare(b.id),
      );
      const out: Array<TeamRecord> = [];
      let level: ReadonlyArray<string> = [start.id];
      while (level.length > 0) {
        const parents = new Set(level);
        const next = all.filter(
          (row) => Option.isSome(row.parentId) && parents.has(row.parentId.value),
        );
        out.push(...next);
        level = next.map((row) => row.id);
      }
      return out;
    };

    const getAncestors: TeamRecordsShape["getAncestors"] = (organizationId, id) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const team = HashMap.get(s.teams, id);
          return Option.isSome(team) && team.value.organizationId === organizationId
            ? ancestorsIn(s.teams, team.value)
            : [];
        }),
      );

    const getDescendants: TeamRecordsShape["getDescendants"] = (organizationId, id) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const team = HashMap.get(s.teams, id);
          return Option.isSome(team) && team.value.organizationId === organizationId
            ? descendantsIn(s.teams, team.value)
            : [];
        }),
      );

    const getSubtree: TeamRecordsShape["getSubtree"] = (organizationId, id) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const team = HashMap.get(s.teams, id);
          return Option.isSome(team) && team.value.organizationId === organizationId
            ? [team.value, ...descendantsIn(s.teams, team.value)]
            : [];
        }),
      );

    const moveTeam: TeamRecordsShape["moveTeam"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(
          state,
          (
            s,
          ): readonly [
            Result.Result<TeamRecord, TeamRecordNotFound | TeamHierarchyCycle>,
            State,
          ] => {
            const team = HashMap.get(s.teams, input.id);
            if (Option.isNone(team) || team.value.organizationId !== input.organizationId) {
              return [Result.fail(teamNotFound(input.id)), s] as const;
            }
            if (Option.isSome(input.parentId)) {
              const parentId = input.parentId.value;
              const parent = HashMap.get(s.teams, parentId);
              if (Option.isNone(parent) || parent.value.organizationId !== input.organizationId) {
                return [Result.fail(teamNotFound(parentId)), s] as const;
              }
              const cyclic =
                parentId === input.id ||
                descendantsIn(s.teams, team.value).some((row) => row.id === parentId);
              if (cyclic) {
                return [
                  Result.fail(new TeamHierarchyCycle({ id: input.id, parentId })),
                  s,
                ] as const;
              }
            }
            const updated: TeamRecord = { ...team.value, parentId: input.parentId, updatedAt: now };
            return [
              Result.succeed(updated),
              { ...s, teams: HashMap.set(s.teams, input.id, updated) },
            ] as const;
          },
        ).pipe(Effect.flatMap(Effect.fromResult));
      });

    const findTeamById: TeamRecordsShape["findTeamById"] = (organizationId, id) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          HashMap.get(s.teams, id).pipe(
            Option.filter((row) => row.organizationId === organizationId),
          ),
        ),
      );

    const findTeamByIdAnyOrg: TeamRecordsShape["findTeamByIdAnyOrg"] = (id) =>
      Ref.get(state).pipe(Effect.map((s) => HashMap.get(s.teams, id)));

    const listTeamsByOrganization: TeamRecordsShape["listTeamsByOrganization"] = (organizationId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s.teams)).filter(
            (row) => row.organizationId === organizationId,
          ),
        ),
      );

    const countTeamsByOrganization: TeamRecordsShape["countTeamsByOrganization"] = (
      organizationId,
    ) => listTeamsByOrganization(organizationId).pipe(Effect.map((rows) => rows.length));

    const updateTeam: TeamRecordsShape["updateTeam"] = (organizationId, id, name) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(
          state,
          (s): readonly [Result.Result<TeamRecord, TeamRecordNotFound>, State] => {
            const existing = HashMap.get(s.teams, id);
            if (Option.isNone(existing) || existing.value.organizationId !== organizationId) {
              return [Result.fail(teamNotFound(id)), s] as const;
            }
            const updated: TeamRecord = { ...existing.value, name, updatedAt: now };
            return [
              Result.succeed(updated),
              { ...s, teams: HashMap.set(s.teams, id, updated) },
            ] as const;
          },
        ).pipe(Effect.flatMap(Effect.fromResult));
      });

    const removeTeam: TeamRecordsShape["removeTeam"] = (organizationId, id) =>
      Ref.modify(
        state,
        (s): readonly [Result.Result<void, TeamRecordNotFound | TeamHasChildren>, State] => {
          const existing = HashMap.get(s.teams, id);
          if (Option.isNone(existing) || existing.value.organizationId !== organizationId) {
            return [Result.fail(teamNotFound(id)), s] as const;
          }
          const hasChildren = Array.from(HashMap.values(s.teams)).some(
            (row) => Option.isSome(row.parentId) && row.parentId.value === id,
          );
          if (hasChildren) return [Result.fail(new TeamHasChildren({ id })), s] as const;
          const memberships = Array.from(HashMap.entries(s.memberships)).reduce(
            (acc, [key, row]) => (row.teamId === id ? HashMap.remove(acc, key) : acc),
            s.memberships,
          );
          return [
            Result.succeed(undefined),
            { teams: HashMap.remove(s.teams, id), memberships },
          ] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const removeAllTeamsForOrganization: TeamRecordsShape["removeAllTeamsForOrganization"] = (
      organizationId,
    ) =>
      Ref.update(state, (s) => {
        const removedIds = new Set(
          Array.from(HashMap.values(s.teams))
            .filter((row) => row.organizationId === organizationId)
            .map((row) => row.id),
        );
        const teams = Array.from(HashMap.entries(s.teams)).reduce(
          (acc, [key, row]) =>
            row.organizationId === organizationId ? HashMap.remove(acc, key) : acc,
          s.teams,
        );
        const memberships = Array.from(HashMap.entries(s.memberships)).reduce(
          (acc, [key, row]) => (removedIds.has(row.teamId) ? HashMap.remove(acc, key) : acc),
          s.memberships,
        );
        return { teams, memberships };
      });

    const addTeamMember: TeamRecordsShape["addTeamMember"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const record = brandTeamMembership({
        id,
        teamId: input.teamId,
        userId: input.userId,
        role: input.role ?? DEFAULT_TEAM_ROLE,
        createdAt: now,
      });
      const key = membershipKeyOf(input.teamId, input.userId);
      return yield* Ref.modify(
        state,
        (
          s,
        ): readonly [
          Result.Result<TeamMembershipRecord, TeamMembershipRecordAlreadyExists>,
          State,
        ] => {
          if (HashMap.has(s.memberships, key)) {
            return [
              Result.fail(
                new TeamMembershipRecordAlreadyExists({
                  teamId: input.teamId,
                  userId: input.userId,
                }),
              ),
              s,
            ] as const;
          }
          const team = HashMap.get(s.teams, input.teamId);
          const teams = Option.isSome(team)
            ? HashMap.set(s.teams, input.teamId, {
                ...team.value,
                memberCount: team.value.memberCount + 1,
              })
            : s.teams;
          return [
            Result.succeed(record),
            { teams, memberships: HashMap.set(s.memberships, key, record) },
          ] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));
    });

    const updateTeamMemberRole: TeamRecordsShape["updateTeamMemberRole"] = (teamId, userId, role) =>
      Ref.modify(
        state,
        (
          s,
        ): readonly [Result.Result<TeamMembershipRecord, TeamMembershipRecordNotFound>, State] => {
          const key = membershipKeyOf(teamId, userId);
          const existing = HashMap.get(s.memberships, key);
          if (Option.isNone(existing)) {
            return [Result.fail(teamMembershipNotFound(teamId, userId)), s] as const;
          }
          const updated = brandTeamMembership({ ...existing.value, role });
          return [
            Result.succeed(updated),
            { ...s, memberships: HashMap.set(s.memberships, key, updated) },
          ] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const removeTeamMember: TeamRecordsShape["removeTeamMember"] = (teamId, userId) =>
      Ref.modify(
        state,
        (s): readonly [Result.Result<void, TeamMembershipRecordNotFound>, State] => {
          const key = membershipKeyOf(teamId, userId);
          if (!HashMap.has(s.memberships, key)) {
            return [Result.fail(teamMembershipNotFound(teamId, userId)), s] as const;
          }
          const team = HashMap.get(s.teams, teamId);
          const teams = Option.isSome(team)
            ? HashMap.set(s.teams, teamId, {
                ...team.value,
                memberCount: Math.max(0, team.value.memberCount - 1),
              })
            : s.teams;
          return [
            Result.succeed(undefined),
            { teams, memberships: HashMap.remove(s.memberships, key) },
          ] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const removeUserFromOrganizationTeams: TeamRecordsShape["removeUserFromOrganizationTeams"] = (
      organizationId,
      userId,
    ) =>
      Ref.modify(state, (s): readonly [ReadonlyArray<string>, State] => {
        const orgTeamIds = new Set(
          Array.from(HashMap.values(s.teams))
            .filter((row) => row.organizationId === organizationId)
            .map((row) => row.id),
        );
        const removed = Array.from(HashMap.entries(s.memberships)).filter(
          ([, row]) => row.userId === userId && orgTeamIds.has(row.teamId),
        );
        const memberships = removed.reduce((acc, [key]) => HashMap.remove(acc, key), s.memberships);
        const teams = removed.reduce((acc, [, row]) => {
          const team = HashMap.get(acc, row.teamId);
          return Option.isSome(team)
            ? HashMap.set(acc, row.teamId, {
                ...team.value,
                memberCount: Math.max(0, team.value.memberCount - 1),
              })
            : acc;
        }, s.teams);
        return [removed.map(([, row]) => row.teamId), { teams, memberships }] as const;
      });

    const findTeamMembership: TeamRecordsShape["findTeamMembership"] = (teamId, userId) =>
      Ref.get(state).pipe(
        Effect.map((s) => HashMap.get(s.memberships, membershipKeyOf(teamId, userId))),
      );

    const listTeamMembers: TeamRecordsShape["listTeamMembers"] = (teamId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s.memberships)).filter((row) => row.teamId === teamId),
        ),
      );

    const listTeamsByUser: TeamRecordsShape["listTeamsByUser"] = (organizationId, userId) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const teamIds = new Set(
            Array.from(HashMap.values(s.memberships))
              .filter((row) => row.userId === userId)
              .map((row) => row.teamId),
          );
          return Array.from(HashMap.values(s.teams)).filter(
            (row) => row.organizationId === organizationId && teamIds.has(row.id),
          );
        }),
      );

    return {
      createTeam,
      findTeamById,
      findTeamByIdAnyOrg,
      listTeamsByOrganization,
      countTeamsByOrganization,
      updateTeam,
      moveTeam,
      getAncestors,
      getDescendants,
      getSubtree,
      removeTeam,
      removeAllTeamsForOrganization,
      addTeamMember,
      updateTeamMemberRole,
      removeTeamMember,
      removeUserFromOrganizationTeams,
      findTeamMembership,
      listTeamMembers,
      listTeamsByUser,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const makeTeamRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    organizationId: Schema.String,
    memberCount: Schema.Number,
    parentId: Schema.NullOr(Schema.String),
    createdAt: wire.dateTime,
    updatedAt: wire.dateTime,
  });

type TeamRow = ReturnType<typeof makeTeamRow>["Type"];

const toTeamRecord = (row: TeamRow): TeamRecord => ({
  id: row.id,
  name: row.name,
  organizationId: row.organizationId,
  memberCount: row.memberCount,
  parentId: Option.fromNullOr(row.parentId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const makeTeamMembershipRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    teamId: Schema.String,
    userId: Schema.String,
    role: Schema.String,
    createdAt: wire.dateTime,
  });

type TeamMembershipRow = ReturnType<typeof makeTeamMembershipRow>["Type"];

/** `role` is a JSON array in a TEXT column, exactly like `organization_membership.role`. */
const RoleNames = Schema.Array(Schema.String);
const decodeRoleNames = Schema.decodeUnknownSync(Schema.fromJsonString(RoleNames));

const toTeamMembershipRecord = (row: TeamMembershipRow): TeamMembershipRecord =>
  brandTeamMembership({
    id: row.id,
    teamId: row.teamId,
    userId: Users.UserId(row.userId),
    role: decodeRoleNames(row.role),
    createdAt: row.createdAt,
  });

export const layerSql = Layer.effect(
  TeamRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const TeamRow = makeTeamRow(wire);
    const TeamMembershipRow = makeTeamMembershipRow(wire);
    const crypto = yield* Crypto.Crypto;

    const insertTeam = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        organizationId: Schema.String,
        memberCount: Schema.Number,
        parentId: Schema.NullOr(Schema.String),
        createdAt: wire.dateTime,
        updatedAt: wire.dateTime,
      }),
      Result: TeamRow,
      execute: (r) => sql`
          INSERT INTO organization_team (id, name, "organizationId", "memberCount", "parentId", "createdAt", "updatedAt")
          VALUES (${r.id}, ${r.name}, ${r.organizationId}, ${r.memberCount}, ${r.parentId}, ${r.createdAt}, ${r.updatedAt})
          RETURNING *
        `,
    });

    // OHS-001: closure-table reads. `depth > 0` is the strict ancestors/descendants,
    // `depth >= 0` adds the team itself. Tenant-scoped on the joined team row.
    const closureRelatives = (direction: "ancestors" | "descendants", minDepth: number) =>
      SqlSchema.findAll({
        Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
        Result: TeamRow,
        execute: (r) =>
          direction === "ancestors"
            ? sql`
                SELECT t.* FROM organization_team t
                INNER JOIN organization_team_closure c ON c."ancestorId" = t.id
                WHERE c."descendantId" = ${r.id} AND c.depth >= ${minDepth}
                  AND t."organizationId" = ${r.organizationId}
                ORDER BY c.depth ASC`
            : sql`
                SELECT t.* FROM organization_team t
                INNER JOIN organization_team_closure c ON c."descendantId" = t.id
                WHERE c."ancestorId" = ${r.id} AND c.depth >= ${minDepth}
                  AND t."organizationId" = ${r.organizationId}
                ORDER BY c.depth ASC, t."createdAt" ASC, t.id ASC`,
      });
    const ancestorsQuery = closureRelatives("ancestors", 1);
    const descendantsQuery = closureRelatives("descendants", 1);
    const subtreeQuery = closureRelatives("descendants", 0);

    const countChildrenQuery = SqlSchema.findOne({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: Schema.Struct({ count: Schema.Number }),
      execute: (r) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_team WHERE "parentId" = ${r.id} AND "organizationId" = ${r.organizationId}`,
    });

    const isInSubtreeQuery = SqlSchema.findOne({
      Request: Schema.Struct({ ancestorId: Schema.String, descendantId: Schema.String }),
      Result: Schema.Struct({ count: Schema.Number }),
      execute: (r) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_team_closure WHERE "ancestorId" = ${r.ancestorId} AND "descendantId" = ${r.descendantId}`,
    });

    const setParentQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        organizationId: Schema.String,
        id: Schema.String,
        parentId: Schema.NullOr(Schema.String),
        updatedAt: wire.dateTime,
      }),
      Result: TeamRow,
      execute: (r) => sql`
          UPDATE organization_team SET "parentId" = ${r.parentId}, "updatedAt" = ${r.updatedAt}
          WHERE id = ${r.id} AND "organizationId" = ${r.organizationId}
          RETURNING *
        `,
    });

    const findTeamByIdQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: TeamRow,
      execute: (r) =>
        sql`SELECT * FROM organization_team WHERE id = ${r.id} AND "organizationId" = ${r.organizationId}`,
    });

    const findTeamByIdAnyOrgQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: TeamRow,
      execute: (id) => sql`SELECT * FROM organization_team WHERE id = ${id}`,
    });

    // MTI-005: a COUNT(*), never a full-row materialization.
    const countTeamsByOrganizationQuery = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ count: Schema.Number }),
      execute: (organizationId) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_team WHERE "organizationId" = ${organizationId}`,
    });

    const listTeamsByOrganizationQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: TeamRow,
      execute: (organizationId) =>
        sql`SELECT * FROM organization_team WHERE "organizationId" = ${organizationId} ORDER BY "createdAt" ASC`,
    });

    const updateTeamQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        organizationId: Schema.String,
        id: Schema.String,
        name: Schema.String,
        updatedAt: wire.dateTime,
      }),
      Result: TeamRow,
      execute: (r) => sql`
          UPDATE organization_team SET name = ${r.name}, "updatedAt" = ${r.updatedAt}
          WHERE id = ${r.id} AND "organizationId" = ${r.organizationId}
          RETURNING *
        `,
    });

    const deleteTeamQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: TeamRow,
      execute: (r) =>
        sql`DELETE FROM organization_team WHERE id = ${r.id} AND "organizationId" = ${r.organizationId} RETURNING *`,
    });

    const insertTeamMembership = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        teamId: Schema.String,
        userId: Schema.String,
        role: Schema.String,
        createdAt: wire.dateTime,
      }),
      Result: TeamMembershipRow,
      execute: (r) => sql`
          INSERT INTO organization_team_membership (id, "teamId", "userId", role, "createdAt")
          VALUES (${r.id}, ${r.teamId}, ${r.userId}, ${r.role}, ${r.createdAt})
          RETURNING *
        `,
    });

    const updateTeamMemberRoleQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ teamId: Schema.String, userId: Schema.String, role: Schema.String }),
      Result: TeamMembershipRow,
      execute: (r) => sql`
          UPDATE organization_team_membership SET role = ${r.role}
          WHERE "teamId" = ${r.teamId} AND "userId" = ${r.userId}
          RETURNING *
        `,
    });

    const findTeamMembershipQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ teamId: Schema.String, userId: Schema.String }),
      Result: TeamMembershipRow,
      execute: (r) =>
        sql`SELECT * FROM organization_team_membership WHERE "teamId" = ${r.teamId} AND "userId" = ${r.userId}`,
    });

    const listTeamMembersQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: TeamMembershipRow,
      execute: (teamId) =>
        sql`SELECT * FROM organization_team_membership WHERE "teamId" = ${teamId}`,
    });

    const deleteTeamMembershipQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ teamId: Schema.String, userId: Schema.String }),
      Result: TeamMembershipRow,
      execute: (r) =>
        sql`DELETE FROM organization_team_membership WHERE "teamId" = ${r.teamId} AND "userId" = ${r.userId} RETURNING *`,
    });

    const listTeamsByUserQuery = SqlSchema.findAll({
      Request: Schema.Struct({ organizationId: Schema.String, userId: Schema.String }),
      Result: TeamRow,
      execute: (r) => sql`
          SELECT t.* FROM organization_team t
          INNER JOIN organization_team_membership tm ON tm."teamId" = t.id
          WHERE t."organizationId" = ${r.organizationId} AND tm."userId" = ${r.userId}
        `,
    });

    const listOrganizationTeamIdsOfUserQuery = SqlSchema.findAll({
      Request: Schema.Struct({ organizationId: Schema.String, userId: Schema.String }),
      Result: Schema.Struct({ teamId: Schema.String }),
      execute: (r) => sql`
          SELECT tm."teamId" AS "teamId" FROM organization_team_membership tm
          INNER JOIN organization_team t ON t.id = tm."teamId"
          WHERE t."organizationId" = ${r.organizationId} AND tm."userId" = ${r.userId}
        `,
    });

    const adjustMemberCount = (teamId: string, delta: number) =>
      sql`UPDATE organization_team SET "memberCount" = "memberCount" + ${delta} WHERE id = ${teamId}`.pipe(
        Effect.asVoid,
      );

    const createTeam: TeamRecordsShape["createTeam"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const parentId = input.parentId ?? null;
            if (parentId !== null) {
              const parent = yield* findTeamByIdQuery({
                organizationId: input.organizationId,
                id: parentId,
              });
              if (Option.isNone(parent)) return yield* Effect.fail(teamNotFound(parentId));
            }
            const row = yield* insertTeam({
              id,
              name: input.name,
              organizationId: input.organizationId,
              memberCount: 0,
              parentId,
              createdAt: now,
              updatedAt: now,
            });
            yield* sql`INSERT INTO organization_team_closure ("ancestorId", "descendantId", depth) VALUES (${id}, ${id}, 0)`;
            if (parentId !== null) {
              yield* sql`
                INSERT INTO organization_team_closure ("ancestorId", "descendantId", depth)
                SELECT "ancestorId", ${id}, depth + 1 FROM organization_team_closure
                WHERE "descendantId" = ${parentId}`;
            }
            return toTeamRecord(row);
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: Effect.die,
            SchemaError: Effect.die,
            NoSuchElementError: Effect.die,
          }),
        );
    });

    const moveTeam: TeamRecordsShape["moveTeam"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const team = yield* findTeamByIdQuery({
              organizationId: input.organizationId,
              id: input.id,
            });
            if (Option.isNone(team)) return yield* Effect.fail(teamNotFound(input.id));
            const parentId = Option.getOrNull(input.parentId);
            if (parentId !== null) {
              const parent = yield* findTeamByIdQuery({
                organizationId: input.organizationId,
                id: parentId,
              });
              if (Option.isNone(parent)) return yield* Effect.fail(teamNotFound(parentId));
              // The closure holds (id, id, 0), so this also covers "under itself".
              const below = yield* isInSubtreeQuery({
                ancestorId: input.id,
                descendantId: parentId,
              });
              if (below.count > 0) {
                return yield* Effect.fail(new TeamHierarchyCycle({ id: input.id, parentId }));
              }
            }
            // Detach the subtree from its old ancestors, then hang it under the new parent.
            yield* sql`
              DELETE FROM organization_team_closure
              WHERE "descendantId" IN (SELECT "descendantId" FROM organization_team_closure WHERE "ancestorId" = ${input.id})
                AND "ancestorId" NOT IN (SELECT "descendantId" FROM organization_team_closure WHERE "ancestorId" = ${input.id})`;
            if (parentId !== null) {
              yield* sql`
                INSERT INTO organization_team_closure ("ancestorId", "descendantId", depth)
                SELECT p."ancestorId", c."descendantId", p.depth + c.depth + 1
                FROM organization_team_closure p
                CROSS JOIN organization_team_closure c
                WHERE p."descendantId" = ${parentId} AND c."ancestorId" = ${input.id}`;
            }
            const row = yield* setParentQuery({
              organizationId: input.organizationId,
              id: input.id,
              parentId,
              updatedAt: now,
            });
            return toTeamRecord(row);
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: Effect.die,
            SchemaError: Effect.die,
            NoSuchElementError: Effect.die,
          }),
        );
    });

    const getAncestors: TeamRecordsShape["getAncestors"] = (organizationId, id) =>
      ancestorsQuery({ organizationId, id }).pipe(
        Effect.map((rows) => rows.map(toTeamRecord)),
        Effect.orDie,
      );

    const getDescendants: TeamRecordsShape["getDescendants"] = (organizationId, id) =>
      descendantsQuery({ organizationId, id }).pipe(
        Effect.map((rows) => rows.map(toTeamRecord)),
        Effect.orDie,
      );

    const getSubtree: TeamRecordsShape["getSubtree"] = (organizationId, id) =>
      subtreeQuery({ organizationId, id }).pipe(
        Effect.map((rows) => rows.map(toTeamRecord)),
        Effect.orDie,
      );

    const findTeamById: TeamRecordsShape["findTeamById"] = (organizationId, id) =>
      findTeamByIdQuery({ organizationId, id }).pipe(
        Effect.map(Option.map(toTeamRecord)),
        Effect.orDie,
      );

    const listTeamsByOrganization: TeamRecordsShape["listTeamsByOrganization"] = (organizationId) =>
      listTeamsByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => rows.map(toTeamRecord)),
        Effect.orDie,
      );

    const countTeamsByOrganization: TeamRecordsShape["countTeamsByOrganization"] = (
      organizationId,
    ) =>
      countTeamsByOrganizationQuery(organizationId).pipe(
        Effect.map((row) => row.count),
        Effect.orDie,
      );

    const findTeamByIdAnyOrg: TeamRecordsShape["findTeamByIdAnyOrg"] = (id) =>
      findTeamByIdAnyOrgQuery(id).pipe(Effect.map(Option.map(toTeamRecord)), Effect.orDie);

    const updateTeam: TeamRecordsShape["updateTeam"] = Effect.fnUntraced(
      function* (organizationId, id, name) {
        const now = yield* DateTime.now;
        const row = yield* updateTeamQuery({ organizationId, id, name, updatedAt: now }).pipe(
          Effect.orDie,
        );
        if (Option.isNone(row)) return yield* Effect.fail(teamNotFound(id));
        return toTeamRecord(row.value);
      },
    );

    // OHS-002: every multi-statement op below runs in one `sql.withTransaction`, so
    // a failure between its statements can never strand a half-applied change.
    // Nested inside a caller's own transaction (`Organization`'s cascades) it
    // becomes a savepoint, so a records op is atomic on its own *and* composes.
    const removeTeam: TeamRecordsShape["removeTeam"] = (organizationId, id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const children = yield* countChildrenQuery({ organizationId, id });
            if (children.count > 0) return yield* Effect.fail(new TeamHasChildren({ id }));
            const row = yield* deleteTeamQuery({ organizationId, id });
            if (Option.isNone(row)) return yield* Effect.fail(teamNotFound(id));
            yield* sql`DELETE FROM organization_team_membership WHERE "teamId" = ${id}`;
            yield* sql`DELETE FROM organization_team_closure WHERE "descendantId" = ${id} OR "ancestorId" = ${id}`;
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: Effect.die,
            SchemaError: Effect.die,
            NoSuchElementError: Effect.die,
          }),
        );

    const removeAllTeamsForOrganization: TeamRecordsShape["removeAllTeamsForOrganization"] = (
      organizationId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM organization_team_membership
              WHERE "teamId" IN (SELECT id FROM organization_team WHERE "organizationId" = ${organizationId})
            `;
            yield* sql`
              DELETE FROM organization_team_closure
              WHERE "descendantId" IN (SELECT id FROM organization_team WHERE "organizationId" = ${organizationId})
                 OR "ancestorId" IN (SELECT id FROM organization_team WHERE "organizationId" = ${organizationId})
            `;
            yield* sql`DELETE FROM organization_team WHERE "organizationId" = ${organizationId}`;
          }),
        )
        .pipe(Effect.orDie);

    const addTeamMember: TeamRecordsShape["addTeamMember"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* insertTeamMembership({
              id,
              teamId: input.teamId,
              userId: input.userId,
              role: JSON.stringify(input.role ?? DEFAULT_TEAM_ROLE),
              createdAt: now,
            });
            yield* adjustMemberCount(input.teamId, 1);
            return toTeamMembershipRecord(row);
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (error) =>
            error.reason._tag === "UniqueViolation"
              ? Effect.fail(
                  new TeamMembershipRecordAlreadyExists({
                    teamId: input.teamId,
                    userId: input.userId,
                  }),
                )
              : Effect.die(error),
          ),
          Effect.catchTag("SchemaError", Effect.die),
          Effect.catchTag("NoSuchElementError", Effect.die),
        );
    });

    const updateTeamMemberRole: TeamRecordsShape["updateTeamMemberRole"] = (teamId, userId, role) =>
      updateTeamMemberRoleQuery({ teamId, userId, role: JSON.stringify(role) }).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(teamMembershipNotFound(teamId, userId)),
            onSome: (row) => Effect.succeed(toTeamMembershipRecord(row)),
          }),
        ),
      );

    const removeTeamMember: TeamRecordsShape["removeTeamMember"] = (teamId, userId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* deleteTeamMembershipQuery({ teamId, userId });
            if (Option.isNone(row)) {
              return yield* Effect.fail(teamMembershipNotFound(teamId, userId));
            }
            yield* adjustMemberCount(teamId, -1);
          }),
        )
        .pipe(Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }));

    const removeUserFromOrganizationTeams: TeamRecordsShape["removeUserFromOrganizationTeams"] = (
      organizationId,
      userId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* listOrganizationTeamIdsOfUserQuery({ organizationId, userId });
            for (const { teamId } of rows) {
              yield* sql`DELETE FROM organization_team_membership WHERE "teamId" = ${teamId} AND "userId" = ${userId}`;
              yield* adjustMemberCount(teamId, -1);
            }
            return rows.map((row) => row.teamId);
          }),
        )
        .pipe(Effect.orDie);

    const findTeamMembership: TeamRecordsShape["findTeamMembership"] = (teamId, userId) =>
      findTeamMembershipQuery({ teamId, userId }).pipe(
        Effect.map(Option.map(toTeamMembershipRecord)),
        Effect.orDie,
      );

    const listTeamMembers: TeamRecordsShape["listTeamMembers"] = (teamId) =>
      listTeamMembersQuery(teamId).pipe(
        Effect.map((rows) => rows.map(toTeamMembershipRecord)),
        Effect.orDie,
      );

    const listTeamsByUser: TeamRecordsShape["listTeamsByUser"] = (organizationId, userId) =>
      listTeamsByUserQuery({ organizationId, userId }).pipe(
        Effect.map((rows) => rows.map(toTeamRecord)),
        Effect.orDie,
      );

    return {
      createTeam,
      findTeamById,
      findTeamByIdAnyOrg,
      listTeamsByOrganization,
      countTeamsByOrganization,
      updateTeam,
      moveTeam,
      getAncestors,
      getDescendants,
      getSubtree,
      removeTeam,
      removeAllTeamsForOrganization,
      addTeamMember,
      updateTeamMemberRole,
      removeTeamMember,
      removeUserFromOrganizationTeams,
      findTeamMembership,
      listTeamMembers,
      listTeamsByUser,
    };
  }),
);
