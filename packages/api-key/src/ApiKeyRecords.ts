// @awthaq/api-key — ApiKeyRecords
//
// OCM-002. This plugin's own persistence for the `apikey_key` table, built the way
// `@awthaq/jwt`'s `SigningKeyRecords` builds its own: a records service with an
// in-memory and a SQL layer (SQLite and Postgres, ADR-EA-004), the row codecs following
// the ambient client's dialect (`Models.dialectFields`, TS-001).
//
// Only `secretHash` (SHA-256, `SecretHash.digest`) is persisted, never the secret. The
// records service owns storage, not policy: ownership checks, expiry, scopes and
// rotation are `ApiKey.ts`'s job.

import { Users } from "@awthaq/core";
import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export interface ApiKeyRecord {
  /** The public `keyId` half of the key (`ak_<id>.<secret>`). */
  readonly id: string;
  readonly ownerId: Users.UserId;
  readonly name: string;
  /** The first characters of the secret, so an owner can recognise a key in a list. */
  readonly start: string;
  readonly secretHash: string;
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: Option.Option<DateTime.Utc>;
  readonly revokedAt: Option.Option<DateTime.Utc>;
  readonly lastUsedAt: Option.Option<DateTime.Utc>;
  /** OCM-005: the key this one replaced, when it came from `rotate`. */
  readonly rotatedFrom: Option.Option<string>;
}

export interface ApiKeyRecordsShape {
  readonly insert: (record: ApiKeyRecord) => Effect.Effect<void>;
  readonly findById: (id: string) => Effect.Effect<Option.Option<ApiKeyRecord>>;
  /** Newest first. */
  readonly listByOwner: (ownerId: Users.UserId) => Effect.Effect<ReadonlyArray<ApiKeyRecord>>;
  /** Sets `revokedAt` once; a key already revoked keeps its first revocation time. */
  readonly revoke: (id: string, at: DateTime.Utc) => Effect.Effect<void>;
  /** OCM-005: shortens (never extends) the key's expiry, for a rotation's grace window. */
  readonly limitExpiry: (id: string, expiresAt: DateTime.Utc) => Effect.Effect<void>;
  readonly touch: (id: string, at: DateTime.Utc) => Effect.Effect<void>;
}

export class ApiKeyRecords extends Context.Service<ApiKeyRecords, ApiKeyRecordsShape>()(
  "awthaq/api-key/ApiKeyRecords",
) {}

// ---- layerMemory ------------------------------------------------------------

const newestFirst = (records: ReadonlyArray<ApiKeyRecord>): ReadonlyArray<ApiKeyRecord> =>
  [...records].sort((a, b) => {
    const byTime = DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);
    return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

export const layerMemory = Layer.effect(
  ApiKeyRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<string, ApiKeyRecord>());
    const update = (id: string, change: (record: ApiKeyRecord) => ApiKeyRecord) =>
      Ref.update(state, (records) =>
        Option.match(HashMap.get(records, id), {
          onNone: () => records,
          onSome: (record) => HashMap.set(records, id, change(record)),
        }),
      );
    return ApiKeyRecords.of({
      insert: (record) => Ref.update(state, HashMap.set(record.id, record)),
      findById: (id) => Ref.get(state).pipe(Effect.map(HashMap.get(id))),
      listByOwner: (ownerId) =>
        Ref.get(state).pipe(
          Effect.map((records) =>
            newestFirst(HashMap.toValues(records).filter((record) => record.ownerId === ownerId)),
          ),
        ),
      revoke: (id, at) =>
        update(id, (record) =>
          Option.isSome(record.revokedAt) ? record : { ...record, revokedAt: Option.some(at) },
        ),
      limitExpiry: (id, expiresAt) =>
        update(id, (record) =>
          Option.isSome(record.expiresAt) &&
          DateTime.toEpochMillis(record.expiresAt.value) <= DateTime.toEpochMillis(expiresAt)
            ? record
            : { ...record, expiresAt: Option.some(expiresAt) },
        ),
      touch: (id, at) => update(id, (record) => ({ ...record, lastUsedAt: Option.some(at) })),
    });
  }),
);

// ---- layerSql ---------------------------------------------------------------

const makeRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    ownerId: Schema.String,
    name: Schema.String,
    start: Schema.String,
    secretHash: Schema.String,
    scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
    createdAt: wire.dateTime,
    expiresAt: wire.nullableDateTime,
    revokedAt: wire.nullableDateTime,
    lastUsedAt: wire.nullableDateTime,
    rotatedFrom: Schema.NullOr(Schema.String),
  });

export const layerSql = Layer.effect(
  ApiKeyRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const Row = makeRow(wire);

    const toRecord = (row: typeof Row.Type): ApiKeyRecord => ({
      id: row.id,
      ownerId: Users.UserId(row.ownerId),
      name: row.name,
      start: row.start,
      secretHash: row.secretHash,
      scopes: row.scopes,
      createdAt: row.createdAt,
      expiresAt: Option.fromNullishOr(row.expiresAt),
      revokedAt: Option.fromNullishOr(row.revokedAt),
      lastUsedAt: Option.fromNullishOr(row.lastUsedAt),
      rotatedFrom: Option.fromNullishOr(row.rotatedFrom),
    });

    const insertQuery = SqlSchema.void({
      Request: Row,
      execute: (r) => sql`
        INSERT INTO apikey_key
          (id, "ownerId", name, "start", "secretHash", scopes, "createdAt", "expiresAt", "revokedAt", "lastUsedAt", "rotatedFrom")
        VALUES
          (${r.id}, ${r.ownerId}, ${r.name}, ${r.start}, ${r.secretHash}, ${r.scopes}, ${r.createdAt}, ${r.expiresAt}, ${r.revokedAt}, ${r.lastUsedAt}, ${r.rotatedFrom})
      `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Row,
      execute: (id) => sql`SELECT * FROM apikey_key WHERE id = ${id}`,
    });

    const listByOwnerQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: Row,
      execute: (ownerId) =>
        sql`SELECT * FROM apikey_key WHERE "ownerId" = ${ownerId} ORDER BY "createdAt" DESC, id DESC`,
    });

    // `revokedAt IS NULL` keeps the first revocation time (idempotent, like the memory layer).
    const revokeQuery = SqlSchema.void({
      Request: Schema.Struct({ id: Schema.String, at: wire.dateTime }),
      execute: (r) =>
        sql`UPDATE apikey_key SET "revokedAt" = ${r.at} WHERE id = ${r.id} AND "revokedAt" IS NULL`,
    });

    const limitExpiryQuery = SqlSchema.void({
      Request: Schema.Struct({ id: Schema.String, expiresAt: wire.dateTime }),
      execute: (r) => sql`
        UPDATE apikey_key SET "expiresAt" = ${r.expiresAt}
        WHERE id = ${r.id} AND ("expiresAt" IS NULL OR "expiresAt" > ${r.expiresAt})
      `,
    });

    const touchQuery = SqlSchema.void({
      Request: Schema.Struct({ id: Schema.String, at: wire.dateTime }),
      execute: (r) => sql`UPDATE apikey_key SET "lastUsedAt" = ${r.at} WHERE id = ${r.id}`,
    });

    return ApiKeyRecords.of({
      insert: (record) =>
        insertQuery({
          id: record.id,
          ownerId: record.ownerId,
          name: record.name,
          start: record.start,
          secretHash: record.secretHash,
          scopes: record.scopes,
          createdAt: record.createdAt,
          expiresAt: Option.getOrNull(record.expiresAt),
          revokedAt: Option.getOrNull(record.revokedAt),
          lastUsedAt: Option.getOrNull(record.lastUsedAt),
          rotatedFrom: Option.getOrNull(record.rotatedFrom),
        }).pipe(Effect.orDie),
      findById: (id) => findByIdQuery(id).pipe(Effect.map(Option.map(toRecord)), Effect.orDie),
      listByOwner: (ownerId) =>
        listByOwnerQuery(ownerId).pipe(
          Effect.map((rows) => rows.map(toRecord)),
          Effect.orDie,
        ),
      revoke: (id, at) => revokeQuery({ id, at }).pipe(Effect.orDie),
      limitExpiry: (id, expiresAt) => limitExpiryQuery({ id, expiresAt }).pipe(Effect.orDie),
      touch: (id, at) => touchQuery({ id, at }).pipe(Effect.orDie),
    });
  }),
);
