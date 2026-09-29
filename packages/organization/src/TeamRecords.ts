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

import { Users } from "@awthaq/core";
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
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export interface TeamMembershipRecord {
  readonly id: string;
  readonly teamId: string;
  readonly userId: Users.UserId;
  readonly createdAt: DateTime.Utc;
}

export class TeamRecordNotFound extends Data.TaggedError("TeamRecordNotFound")<{
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
  readonly createTeam: (input: {
    readonly organizationId: string;
    readonly name: string;
  }) => Effect.Effect<TeamRecord>;
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
  /** Removes the team and cascades every one of its `TeamMembershipRecord` rows. */
  readonly removeTeam: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<void, TeamRecordNotFound>;
  /** Used by `Organization.delete`'s own cascade. */
  readonly removeAllTeamsForOrganization: (organizationId: string) => Effect.Effect<void>;
  /** Increments the owning team's `memberCount`; atomic with the row insert under `layerSql`. */
  readonly addTeamMember: (input: {
    readonly teamId: string;
    readonly userId: Users.UserId;
  }) => Effect.Effect<TeamMembershipRecord, TeamMembershipRecordAlreadyExists>;
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
        createdAt: now,
        updatedAt: now,
      };
      yield* Ref.update(state, (s) => ({ ...s, teams: HashMap.set(s.teams, id, record) }));
      return record;
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
      Ref.modify(state, (s): readonly [Result.Result<void, TeamRecordNotFound>, State] => {
        const existing = HashMap.get(s.teams, id);
        if (Option.isNone(existing) || existing.value.organizationId !== organizationId) {
          return [Result.fail(teamNotFound(id)), s] as const;
        }
        const memberships = Array.from(HashMap.entries(s.memberships)).reduce(
          (acc, [key, row]) => (row.teamId === id ? HashMap.remove(acc, key) : acc),
          s.memberships,
        );
        return [
          Result.succeed(undefined),
          { teams: HashMap.remove(s.teams, id), memberships },
        ] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

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
      const record: TeamMembershipRecord = {
        id,
        teamId: input.teamId,
        userId: input.userId,
        createdAt: now,
      };
      const key = membershipKeyOf(input.teamId, input.userId);
      return yield* Ref.modify(
        state,
        (
          s,
        ): readonly [Result.Result<TeamMembershipRecord, TeamMembershipRecordAlreadyExists>, State] => {
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
        const memberships = removed.reduce(
          (acc, [key]) => HashMap.remove(acc, key),
          s.memberships,
        );
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
      removeTeam,
      removeAllTeamsForOrganization,
      addTeamMember,
      removeTeamMember,
      removeUserFromOrganizationTeams,
      findTeamMembership,
      listTeamMembers,
      listTeamsByUser,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const TeamRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  organizationId: Schema.String,
  memberCount: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

const toTeamRecord = (row: typeof TeamRow.Type): TeamRecord => ({
  id: row.id,
  name: row.name,
  organizationId: row.organizationId,
  memberCount: row.memberCount,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const TeamMembershipRow = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  userId: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});

const toTeamMembershipRecord = (row: typeof TeamMembershipRow.Type): TeamMembershipRecord => ({
  id: row.id,
  teamId: row.teamId,
  userId: Users.UserId(row.userId),
  createdAt: row.createdAt,
});

export const layerSql = Layer.effect(
  TeamRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;

    const insertTeam = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        organizationId: Schema.String,
        memberCount: Schema.Number,
        createdAt: Schema.DateTimeUtcFromString,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: TeamRow,
      execute: (r) => sql`
          INSERT INTO organization_team (id, name, organizationId, memberCount, createdAt, updatedAt)
          VALUES (${r.id}, ${r.name}, ${r.organizationId}, ${r.memberCount}, ${r.createdAt}, ${r.updatedAt})
          RETURNING *
        `,
    });

    const findTeamByIdQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: TeamRow,
      execute: (r) =>
        sql`SELECT * FROM organization_team WHERE id = ${r.id} AND organizationId = ${r.organizationId}`,
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
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_team WHERE organizationId = ${organizationId}`,
    });

    const listTeamsByOrganizationQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: TeamRow,
      execute: (organizationId) =>
        sql`SELECT * FROM organization_team WHERE organizationId = ${organizationId} ORDER BY createdAt ASC`,
    });

    const updateTeamQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        organizationId: Schema.String,
        id: Schema.String,
        name: Schema.String,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: TeamRow,
      execute: (r) => sql`
          UPDATE organization_team SET name = ${r.name}, updatedAt = ${r.updatedAt}
          WHERE id = ${r.id} AND organizationId = ${r.organizationId}
          RETURNING *
        `,
    });

    const deleteTeamQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: TeamRow,
      execute: (r) =>
        sql`DELETE FROM organization_team WHERE id = ${r.id} AND organizationId = ${r.organizationId} RETURNING *`,
    });

    const insertTeamMembership = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        teamId: Schema.String,
        userId: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
      }),
      Result: TeamMembershipRow,
      execute: (r) => sql`
          INSERT INTO organization_team_membership (id, teamId, userId, createdAt)
          VALUES (${r.id}, ${r.teamId}, ${r.userId}, ${r.createdAt})
          RETURNING *
        `,
    });

    const findTeamMembershipQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ teamId: Schema.String, userId: Schema.String }),
      Result: TeamMembershipRow,
      execute: (r) =>
        sql`SELECT * FROM organization_team_membership WHERE teamId = ${r.teamId} AND userId = ${r.userId}`,
    });

    const listTeamMembersQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: TeamMembershipRow,
      execute: (teamId) => sql`SELECT * FROM organization_team_membership WHERE teamId = ${teamId}`,
    });

    const deleteTeamMembershipQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ teamId: Schema.String, userId: Schema.String }),
      Result: TeamMembershipRow,
      execute: (r) =>
        sql`DELETE FROM organization_team_membership WHERE teamId = ${r.teamId} AND userId = ${r.userId} RETURNING *`,
    });

    const listTeamsByUserQuery = SqlSchema.findAll({
      Request: Schema.Struct({ organizationId: Schema.String, userId: Schema.String }),
      Result: TeamRow,
      execute: (r) => sql`
          SELECT t.* FROM organization_team t
          INNER JOIN organization_team_membership tm ON tm.teamId = t.id
          WHERE t.organizationId = ${r.organizationId} AND tm.userId = ${r.userId}
        `,
    });

    const listOrganizationTeamIdsOfUserQuery = SqlSchema.findAll({
      Request: Schema.Struct({ organizationId: Schema.String, userId: Schema.String }),
      Result: Schema.Struct({ teamId: Schema.String }),
      execute: (r) => sql`
          SELECT tm.teamId AS teamId FROM organization_team_membership tm
          INNER JOIN organization_team t ON t.id = tm.teamId
          WHERE t.organizationId = ${r.organizationId} AND tm.userId = ${r.userId}
        `,
    });

    const adjustMemberCount = (teamId: string, delta: number) =>
      sql`UPDATE organization_team SET memberCount = memberCount + ${delta} WHERE id = ${teamId}`.pipe(
        Effect.asVoid,
      );

    const createTeam: TeamRecordsShape["createTeam"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const row = yield* insertTeam({
        id,
        name: input.name,
        organizationId: input.organizationId,
        memberCount: 0,
        createdAt: now,
        updatedAt: now,
      }).pipe(Effect.orDie);
      return toTeamRecord(row);
    });

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
            const row = yield* deleteTeamQuery({ organizationId, id });
            if (Option.isNone(row)) return yield* Effect.fail(teamNotFound(id));
            yield* sql`DELETE FROM organization_team_membership WHERE teamId = ${id}`;
          }),
        )
        .pipe(Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }));

    const removeAllTeamsForOrganization: TeamRecordsShape["removeAllTeamsForOrganization"] = (
      organizationId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM organization_team_membership
              WHERE teamId IN (SELECT id FROM organization_team WHERE organizationId = ${organizationId})
            `;
            yield* sql`DELETE FROM organization_team WHERE organizationId = ${organizationId}`;
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
        .pipe(
          Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
        );

    const removeUserFromOrganizationTeams: TeamRecordsShape["removeUserFromOrganizationTeams"] = (
      organizationId,
      userId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* listOrganizationTeamIdsOfUserQuery({ organizationId, userId });
            for (const { teamId } of rows) {
              yield* sql`DELETE FROM organization_team_membership WHERE teamId = ${teamId} AND userId = ${userId}`;
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
      removeTeam,
      removeAllTeamsForOrganization,
      addTeamMember,
      removeTeamMember,
      removeUserFromOrganizationTeams,
      findTeamMembership,
      listTeamMembers,
      listTeamsByUser,
    };
  }),
);
