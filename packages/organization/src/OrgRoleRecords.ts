// @awthaq/organization — OrgRoleRecords
//
// spec.md's "Dynamic access control": persistence for the
// `organization_role` table (opt-in via `OrganizationConfig.dynamicAccessControl.enabled`),
// mirroring `MembershipRecords.ts`'s own shape. `permission` is a
// `PermissionEngine.Statements` value, JSON-serialized `TEXT` under
// `layerSql` — the same resource→actions map shape as the plugin's static
// default statements, so `Organization.ts` can merge a dynamic role's
// permission directly into `PermissionEngine.statementsByRoleFrom`'s
// `dynamicStatements` argument with no reshaping.

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
import type * as PermissionEngine from "./PermissionEngine.ts";

export interface OrgRoleRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly role: string;
  readonly permission: PermissionEngine.Statements;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export class OrgRoleRecordNameTaken extends Data.TaggedError("OrgRoleRecordNameTaken")<{
  readonly organizationId: string;
  readonly role: string;
}> {}

export class OrgRoleRecordNotFound extends Data.TaggedError("OrgRoleRecordNotFound")<{
  readonly id: string;
}> {}

export interface OrgRoleRecordsShape {
  readonly create: (input: {
    readonly organizationId: string;
    readonly role: string;
    readonly permission: PermissionEngine.Statements;
  }) => Effect.Effect<OrgRoleRecord, OrgRoleRecordNameTaken>;
  readonly findById: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<Option.Option<OrgRoleRecord>>;
  readonly listByOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<OrgRoleRecord>>;
  readonly countByOrganization: (organizationId: string) => Effect.Effect<number>;
  readonly update: (
    organizationId: string,
    id: string,
    permission: PermissionEngine.Statements,
  ) => Effect.Effect<OrgRoleRecord, OrgRoleRecordNotFound>;
  readonly remove: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<void, OrgRoleRecordNotFound>;
  readonly removeAllForOrganization: (organizationId: string) => Effect.Effect<void>;
}

export class OrgRoleRecords extends Context.Service<OrgRoleRecords, OrgRoleRecordsShape>()(
  "awthaq/organization/OrgRoleRecords",
) {}

const notFound = (id: string): OrgRoleRecordNotFound => new OrgRoleRecordNotFound({ id });
const nameTaken = (organizationId: string, role: string): OrgRoleRecordNameTaken =>
  new OrgRoleRecordNameTaken({ organizationId, role });

// ---- layerMemory ------------------------------------------------------------

type State = HashMap.HashMap<string, OrgRoleRecord>;

export const layerMemory = Layer.effect(
  OrgRoleRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());
    const crypto = yield* Crypto.Crypto;

    const nameCollision = (s: State, organizationId: string, role: string): boolean =>
      Array.from(HashMap.values(s)).some(
        (row) => row.organizationId === organizationId && row.role === role,
      );

    const create: OrgRoleRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const outcome = yield* Ref.modify(
        state,
        (s): readonly [Result.Result<OrgRoleRecord, OrgRoleRecordNameTaken>, State] => {
          if (nameCollision(s, input.organizationId, input.role)) {
            return [Result.fail(nameTaken(input.organizationId, input.role)), s] as const;
          }
          const record: OrgRoleRecord = {
            id,
            organizationId: input.organizationId,
            role: input.role,
            permission: input.permission,
            createdAt: now,
            updatedAt: now,
          };
          return [Result.succeed(record), HashMap.set(s, id, record)] as const;
        },
      );
      return yield* Effect.fromResult(outcome);
    });

    const findById: OrgRoleRecordsShape["findById"] = (organizationId, id) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          HashMap.get(s, id).pipe(Option.filter((row) => row.organizationId === organizationId)),
        ),
      );

    const listByOrganization: OrgRoleRecordsShape["listByOrganization"] = (organizationId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s)).filter((row) => row.organizationId === organizationId),
        ),
      );

    const countByOrganization: OrgRoleRecordsShape["countByOrganization"] = (organizationId) =>
      listByOrganization(organizationId).pipe(Effect.map((rows) => rows.length));

    const update: OrgRoleRecordsShape["update"] = (organizationId, id, permission) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(
          state,
          (s): readonly [Result.Result<OrgRoleRecord, OrgRoleRecordNotFound>, State] => {
            const existing = HashMap.get(s, id);
            if (Option.isNone(existing) || existing.value.organizationId !== organizationId) {
              return [Result.fail(notFound(id)), s] as const;
            }
            const updated: OrgRoleRecord = { ...existing.value, permission, updatedAt: now };
            return [Result.succeed(updated), HashMap.set(s, id, updated)] as const;
          },
        ).pipe(Effect.flatMap(Effect.fromResult));
      });

    const remove: OrgRoleRecordsShape["remove"] = (organizationId, id) =>
      Ref.modify(state, (s): readonly [Result.Result<void, OrgRoleRecordNotFound>, State] => {
        const existing = HashMap.get(s, id);
        if (Option.isNone(existing) || existing.value.organizationId !== organizationId) {
          return [Result.fail(notFound(id)), s] as const;
        }
        return [Result.succeed(undefined), HashMap.remove(s, id)] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    const removeAllForOrganization: OrgRoleRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      Ref.update(state, (s) =>
        Array.from(HashMap.entries(s)).reduce(
          (acc, [key, row]) =>
            row.organizationId === organizationId ? HashMap.remove(acc, key) : acc,
          s,
        ),
      );

    return {
      create,
      findById,
      listByOrganization,
      countByOrganization,
      update,
      remove,
      removeAllForOrganization,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const OrgRoleRow = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  role: Schema.String,
  permission: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

const parsePermission = (json: string): PermissionEngine.Statements => JSON.parse(json);

const toRecord = (row: typeof OrgRoleRow.Type): OrgRoleRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  role: row.role,
  permission: parsePermission(row.permission),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const layerSql = Layer.effect(
  OrgRoleRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        organizationId: Schema.String,
        role: Schema.String,
        permission: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: OrgRoleRow,
      execute: (r) => sql`
          INSERT INTO organization_role (id, organizationId, role, permission, createdAt, updatedAt)
          VALUES (${r.id}, ${r.organizationId}, ${r.role}, ${r.permission}, ${r.createdAt}, ${r.updatedAt})
          RETURNING *
        `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: OrgRoleRow,
      execute: (r) =>
        sql`SELECT * FROM organization_role WHERE id = ${r.id} AND organizationId = ${r.organizationId}`,
    });

    const listByOrganizationQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: OrgRoleRow,
      execute: (organizationId) =>
        sql`SELECT * FROM organization_role WHERE organizationId = ${organizationId}`,
    });

    // MTI-005: a COUNT(*), never a full-row materialization.
    const countByOrganizationQuery = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ count: Schema.Number }),
      execute: (organizationId) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_role WHERE organizationId = ${organizationId}`,
    });

    const updateQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        organizationId: Schema.String,
        id: Schema.String,
        permission: Schema.String,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: OrgRoleRow,
      execute: (r) => sql`
          UPDATE organization_role SET permission = ${r.permission}, updatedAt = ${r.updatedAt}
          WHERE id = ${r.id} AND organizationId = ${r.organizationId}
          RETURNING *
        `,
    });

    const removeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: OrgRoleRow,
      execute: (r) =>
        sql`DELETE FROM organization_role WHERE id = ${r.id} AND organizationId = ${r.organizationId} RETURNING *`,
    });

    const create: OrgRoleRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const row = yield* insert({
        id,
        organizationId: input.organizationId,
        role: input.role,
        permission: JSON.stringify(input.permission),
        createdAt: now,
        updatedAt: now,
      }).pipe(
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(nameTaken(input.organizationId, input.role))
            : Effect.die(error),
        ),
        Effect.catchTag("SchemaError", Effect.die),
        Effect.catchTag("NoSuchElementError", Effect.die),
      );
      return toRecord(row);
    });

    const findById: OrgRoleRecordsShape["findById"] = (organizationId, id) =>
      findByIdQuery({ organizationId, id }).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const listByOrganization: OrgRoleRecordsShape["listByOrganization"] = (organizationId) =>
      listByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const countByOrganization: OrgRoleRecordsShape["countByOrganization"] = (organizationId) =>
      countByOrganizationQuery(organizationId).pipe(
        Effect.map((row) => row.count),
        Effect.orDie,
      );

    const update: OrgRoleRecordsShape["update"] = Effect.fnUntraced(
      function* (organizationId, id, permission) {
        const now = yield* DateTime.now;
        const row = yield* updateQuery({
          organizationId,
          id,
          permission: JSON.stringify(permission),
          updatedAt: now,
        }).pipe(Effect.orDie);
        if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
        return toRecord(row.value);
      },
    );

    const remove: OrgRoleRecordsShape["remove"] = Effect.fnUntraced(function* (organizationId, id) {
      const row = yield* removeQuery({ organizationId, id }).pipe(Effect.orDie);
      if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
    });

    const removeAllForOrganization: OrgRoleRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      sql`DELETE FROM organization_role WHERE organizationId = ${organizationId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    return {
      create,
      findById,
      listByOrganization,
      countByOrganization,
      update,
      remove,
      removeAllForOrganization,
    };
  }),
);
