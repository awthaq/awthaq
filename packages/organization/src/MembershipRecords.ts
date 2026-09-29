// @awthaq/organization — MembershipRecords
//
// spec.md's "Membership": persistence for the `organization_membership`
// table, mirroring `OrganizationRecords.ts`'s own shape. `role` is stored as
// an array (multi-role, spec.md's richer-than-a-single-value decision) — a
// JSON-serialized `TEXT` column under `layerSql`, a plain array in memory.

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

export interface MembershipRecord {
  readonly id: string;
  readonly userId: Users.UserId;
  readonly organizationId: string;
  readonly role: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
}

export class MembershipRecordNotFound extends Data.TaggedError("MembershipRecordNotFound")<{
  readonly userId: string;
  readonly organizationId: string;
}> {}

/** MTI-003: `(userId, organizationId)` is unique — a second `create` for the same pair is refused, never an overwrite. */
export class MembershipRecordAlreadyExists extends Data.TaggedError(
  "MembershipRecordAlreadyExists",
)<{
  readonly userId: string;
  readonly organizationId: string;
}> {}

export interface ListMembersInput {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly sortBy?: "createdAt" | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
}

export interface MembershipRecordsShape {
  readonly create: (input: {
    readonly userId: Users.UserId;
    readonly organizationId: string;
    readonly role: ReadonlyArray<string>;
  }) => Effect.Effect<MembershipRecord, MembershipRecordAlreadyExists>;
  readonly findByUserAndOrg: (
    userId: Users.UserId,
    organizationId: string,
  ) => Effect.Effect<Option.Option<MembershipRecord>>;
  readonly listByOrganization: (
    organizationId: string,
    input?: ListMembersInput,
  ) => Effect.Effect<ReadonlyArray<MembershipRecord>>;
  readonly listByUser: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<MembershipRecord>>;
  readonly countByOrganization: (organizationId: string) => Effect.Effect<number>;
  readonly countOwners: (organizationId: string) => Effect.Effect<number>;
  readonly updateRole: (
    userId: Users.UserId,
    organizationId: string,
    role: ReadonlyArray<string>,
  ) => Effect.Effect<MembershipRecord, MembershipRecordNotFound>;
  readonly remove: (
    userId: Users.UserId,
    organizationId: string,
  ) => Effect.Effect<void, MembershipRecordNotFound>;
  /** Deletes every membership row for an organization — used by `Organization.delete`'s cascade. */
  readonly removeAllForOrganization: (organizationId: string) => Effect.Effect<void>;
  /** CSG-001/DRS-002 (.issues/high): deletes every membership row for a user across every organization — the erasure cascade's own `Hooks.BeforeUserDelete` tap needs (`Organization.ts`'s own `layer`). */
  readonly deleteAllByUser: (userId: Users.UserId) => Effect.Effect<void>;
}

export class MembershipRecords extends Context.Service<MembershipRecords, MembershipRecordsShape>()(
  "awthaq/organization/MembershipRecords",
) {}

const notFound = (userId: Users.UserId, organizationId: string): MembershipRecordNotFound =>
  new MembershipRecordNotFound({ userId, organizationId });

const applySort = (
  records: ReadonlyArray<MembershipRecord>,
  input?: ListMembersInput,
): ReadonlyArray<MembershipRecord> => {
  const direction = input?.sortDirection ?? "asc";
  const sorted = [...records].sort(
    (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
  );
  return direction === "desc" ? sorted.reverse() : sorted;
};

const applyPage = (
  records: ReadonlyArray<MembershipRecord>,
  input?: ListMembersInput,
): ReadonlyArray<MembershipRecord> => {
  const offset = input?.offset ?? 0;
  const limit = input?.limit;
  const sliced = records.slice(offset);
  return limit === undefined ? sliced : sliced.slice(0, limit);
};

// ---- layerMemory ------------------------------------------------------------

type State = HashMap.HashMap<string, MembershipRecord>;

const keyOf = (userId: string, organizationId: string): string => `${organizationId}:${userId}`;

export const layerMemory = Layer.effect(
  MembershipRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());
    const crypto = yield* Crypto.Crypto;

    const create: MembershipRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const record: MembershipRecord = {
        id,
        userId: input.userId,
        organizationId: input.organizationId,
        role: input.role,
        createdAt: now,
      };
      const key = keyOf(input.userId, input.organizationId);
      return yield* Ref.modify(
        state,
        (s): readonly [Result.Result<MembershipRecord, MembershipRecordAlreadyExists>, State] =>
          HashMap.has(s, key)
            ? ([
                Result.fail(
                  new MembershipRecordAlreadyExists({
                    userId: input.userId,
                    organizationId: input.organizationId,
                  }),
                ),
                s,
              ] as const)
            : ([Result.succeed(record), HashMap.set(s, key, record)] as const),
      ).pipe(Effect.flatMap(Effect.fromResult));
    });

    const findByUserAndOrg: MembershipRecordsShape["findByUserAndOrg"] = (userId, organizationId) =>
      Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, keyOf(userId, organizationId))));

    const listByOrganization: MembershipRecordsShape["listByOrganization"] = (
      organizationId,
      input,
    ) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s)).filter((row) => row.organizationId === organizationId),
        ),
        Effect.map((rows) => applyPage(applySort(rows, input), input)),
      );

    const listByUser: MembershipRecordsShape["listByUser"] = (userId) =>
      Ref.get(state).pipe(
        Effect.map((s) => Array.from(HashMap.values(s)).filter((row) => row.userId === userId)),
      );

    const countByOrganization: MembershipRecordsShape["countByOrganization"] = (organizationId) =>
      Ref.get(state).pipe(
        Effect.map(
          (s) =>
            Array.from(HashMap.values(s)).filter((row) => row.organizationId === organizationId)
              .length,
        ),
      );

    const countOwners: MembershipRecordsShape["countOwners"] = (organizationId) =>
      Ref.get(state).pipe(
        Effect.map(
          (s) =>
            Array.from(HashMap.values(s)).filter(
              (row) => row.organizationId === organizationId && row.role.includes("owner"),
            ).length,
        ),
      );

    const updateRole: MembershipRecordsShape["updateRole"] = (userId, organizationId, role) =>
      Ref.modify(
        state,
        (s): readonly [Result.Result<MembershipRecord, MembershipRecordNotFound>, State] => {
          const key = keyOf(userId, organizationId);
          const existing = HashMap.get(s, key);
          if (Option.isNone(existing)) {
            return [Result.fail(notFound(userId, organizationId)), s] as const;
          }
          const updated: MembershipRecord = { ...existing.value, role };
          return [Result.succeed(updated), HashMap.set(s, key, updated)] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const remove: MembershipRecordsShape["remove"] = (userId, organizationId) =>
      Ref.modify(state, (s): readonly [Result.Result<void, MembershipRecordNotFound>, State] => {
        const key = keyOf(userId, organizationId);
        if (!HashMap.has(s, key))
          return [Result.fail(notFound(userId, organizationId)), s] as const;
        return [Result.succeed(undefined), HashMap.remove(s, key)] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    const removeAllForOrganization: MembershipRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      Ref.update(state, (s) =>
        Array.from(HashMap.entries(s)).reduce(
          (acc, [key, row]) =>
            row.organizationId === organizationId ? HashMap.remove(acc, key) : acc,
          s,
        ),
      );

    const deleteAllByUser: MembershipRecordsShape["deleteAllByUser"] = (userId) =>
      Ref.update(state, (s) =>
        Array.from(HashMap.entries(s)).reduce(
          (acc, [key, row]) => (row.userId === userId ? HashMap.remove(acc, key) : acc),
          s,
        ),
      );

    return {
      create,
      findByUserAndOrg,
      listByOrganization,
      listByUser,
      countByOrganization,
      countOwners,
      updateRole,
      remove,
      removeAllForOrganization,
      deleteAllByUser,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const MembershipRow = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  organizationId: Schema.String,
  role: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});

const parseRoleArray = (json: string): ReadonlyArray<string> => JSON.parse(json);

const toRecord = (row: typeof MembershipRow.Type): MembershipRecord => ({
  id: row.id,
  userId: Users.UserId(row.userId),
  organizationId: row.organizationId,
  role: parseRoleArray(row.role),
  createdAt: row.createdAt,
});

export const layerSql = Layer.effect(
  MembershipRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        userId: Schema.String,
        organizationId: Schema.String,
        role: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
      }),
      Result: MembershipRow,
      execute: (r) => sql`
          INSERT INTO organization_membership (id, userId, organizationId, role, createdAt)
          VALUES (${r.id}, ${r.userId}, ${r.organizationId}, ${r.role}, ${r.createdAt})
          RETURNING *
        `,
    });

    const findByUserAndOrgQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: Schema.String, organizationId: Schema.String }),
      Result: MembershipRow,
      execute: (r) =>
        sql`SELECT * FROM organization_membership WHERE userId = ${r.userId} AND organizationId = ${r.organizationId}`,
    });

    const listByOrganizationQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: MembershipRow,
      execute: (organizationId) =>
        sql`SELECT * FROM organization_membership WHERE organizationId = ${organizationId} ORDER BY createdAt ASC`,
    });

    const listByUserQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: MembershipRow,
      execute: (userId) => sql`SELECT * FROM organization_membership WHERE userId = ${userId}`,
    });

    const updateRoleQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        userId: Schema.String,
        organizationId: Schema.String,
        role: Schema.String,
      }),
      Result: MembershipRow,
      execute: (r) => sql`
          UPDATE organization_membership SET role = ${r.role}
          WHERE userId = ${r.userId} AND organizationId = ${r.organizationId}
          RETURNING *
        `,
    });

    // MTI-005: counts are COUNT(*) — never a full-row materialization. CAST keeps
    // pg from returning a bigint string.
    const CountRow = Schema.Struct({ count: Schema.Number });

    const countByOrganizationQuery = SqlSchema.findOne({
      Request: Schema.String,
      Result: CountRow,
      execute: (organizationId) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_membership WHERE organizationId = ${organizationId}`,
    });

    // `role` is a JSON array in a TEXT column; "contains the element owner" is
    // dialect-specific JSON, so the query is branched like the migrations are.
    const countOwnersQuery = SqlSchema.findOne({
      Request: Schema.String,
      Result: CountRow,
      execute: (organizationId) =>
        sql.onDialectOrElse({
          sqlite: () => sql`
            SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_membership
            WHERE organizationId = ${organizationId}
              AND EXISTS (SELECT 1 FROM json_each(organization_membership.role) WHERE value = 'owner')`,
          pg: () => sql`
            SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_membership
            WHERE organizationId = ${organizationId} AND role::jsonb @> '"owner"'::jsonb`,
          orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for countOwners")),
        }),
    });

    const removeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: Schema.String, organizationId: Schema.String }),
      Result: MembershipRow,
      execute: (r) =>
        sql`DELETE FROM organization_membership WHERE userId = ${r.userId} AND organizationId = ${r.organizationId} RETURNING *`,
    });

    const create: MembershipRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const row = yield* insert({
        id,
        userId: input.userId,
        organizationId: input.organizationId,
        role: JSON.stringify(input.role),
        createdAt: now,
      }).pipe(
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(
                new MembershipRecordAlreadyExists({
                  userId: input.userId,
                  organizationId: input.organizationId,
                }),
              )
            : Effect.die(error),
        ),
        Effect.catchTag("SchemaError", Effect.die),
        Effect.catchTag("NoSuchElementError", Effect.die),
      );
      return toRecord(row);
    });

    const findByUserAndOrg: MembershipRecordsShape["findByUserAndOrg"] = (userId, organizationId) =>
      findByUserAndOrgQuery({ userId, organizationId }).pipe(
        Effect.map(Option.map(toRecord)),
        Effect.orDie,
      );

    const listByOrganization: MembershipRecordsShape["listByOrganization"] = (
      organizationId,
      input,
    ) =>
      listByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => applyPage(rows.map(toRecord), input)),
        Effect.orDie,
      );

    const listByUser: MembershipRecordsShape["listByUser"] = (userId) =>
      listByUserQuery(userId).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const countByOrganization: MembershipRecordsShape["countByOrganization"] = (organizationId) =>
      countByOrganizationQuery(organizationId).pipe(
        Effect.map((row) => row.count),
        Effect.orDie,
      );

    const countOwners: MembershipRecordsShape["countOwners"] = (organizationId) =>
      countOwnersQuery(organizationId).pipe(
        Effect.map((row) => row.count),
        Effect.orDie,
      );

    const updateRole: MembershipRecordsShape["updateRole"] = Effect.fnUntraced(
      function* (userId, organizationId, role) {
        const row = yield* updateRoleQuery({
          userId,
          organizationId,
          role: JSON.stringify(role),
        }).pipe(Effect.orDie);
        if (Option.isNone(row)) return yield* Effect.fail(notFound(userId, organizationId));
        return toRecord(row.value);
      },
    );

    const remove: MembershipRecordsShape["remove"] = Effect.fnUntraced(
      function* (userId, organizationId) {
        const row = yield* removeQuery({ userId, organizationId }).pipe(Effect.orDie);
        if (Option.isNone(row)) return yield* Effect.fail(notFound(userId, organizationId));
      },
    );

    const removeAllForOrganization: MembershipRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      sql`DELETE FROM organization_membership WHERE organizationId = ${organizationId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    const deleteAllByUser: MembershipRecordsShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM organization_membership WHERE userId = ${userId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    return {
      create,
      findByUserAndOrg,
      listByOrganization,
      listByUser,
      countByOrganization,
      countOwners,
      updateRole,
      remove,
      removeAllForOrganization,
      deleteAllByUser,
    };
  }),
);
