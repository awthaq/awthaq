// @awthaq/api-key — ApiKeyClientRecords
//
// MAPS-003/OCM-001/OCM-005. Persistence for `apikey_client`: the `client_credentials`
// clients that mint short-lived service tokens. Like `ApiKeyRecords`, only SHA-256
// hashes are stored. A client holds at most two valid secret hashes (ADR-EA-022): the
// current one and, for a bounded grace window after `rotateSecret`, the previous one,
// so a rotation never needs a hard cut-over.

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

export interface ApiKeyClientRecord {
  readonly clientId: string;
  readonly ownerId: Users.UserId;
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  readonly secretHash: string;
  /** The hash `rotateSecret` replaced; valid only until `previousExpiresAt`. */
  readonly previousSecretHash: Option.Option<string>;
  readonly previousExpiresAt: Option.Option<DateTime.Utc>;
  readonly createdAt: DateTime.Utc;
  readonly revokedAt: Option.Option<DateTime.Utc>;
}

export interface ApiKeyClientRecordsShape {
  readonly insert: (record: ApiKeyClientRecord) => Effect.Effect<void>;
  readonly findById: (clientId: string) => Effect.Effect<Option.Option<ApiKeyClientRecord>>;
  /** Newest first. */
  readonly listByOwner: (ownerId: Users.UserId) => Effect.Effect<ReadonlyArray<ApiKeyClientRecord>>;
  readonly revoke: (clientId: string, at: DateTime.Utc) => Effect.Effect<void>;
  /** The current hash becomes the previous one (valid until `previousExpiresAt`); `secretHash` becomes current. */
  readonly rotateSecret: (input: {
    readonly clientId: string;
    readonly secretHash: string;
    readonly previousExpiresAt: DateTime.Utc;
  }) => Effect.Effect<void>;
}

export class ApiKeyClientRecords extends Context.Service<
  ApiKeyClientRecords,
  ApiKeyClientRecordsShape
>()("awthaq/api-key/ApiKeyClientRecords") {}

// ---- layerMemory ------------------------------------------------------------

const newestFirst = (
  records: ReadonlyArray<ApiKeyClientRecord>,
): ReadonlyArray<ApiKeyClientRecord> =>
  [...records].sort((a, b) => {
    const byTime = DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);
    return byTime !== 0 ? byTime : a.clientId < b.clientId ? 1 : a.clientId > b.clientId ? -1 : 0;
  });

export const layerMemory = Layer.effect(
  ApiKeyClientRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<string, ApiKeyClientRecord>());
    const update = (clientId: string, change: (record: ApiKeyClientRecord) => ApiKeyClientRecord) =>
      Ref.update(state, (records) =>
        Option.match(HashMap.get(records, clientId), {
          onNone: () => records,
          onSome: (record) => HashMap.set(records, clientId, change(record)),
        }),
      );
    return ApiKeyClientRecords.of({
      insert: (record) => Ref.update(state, HashMap.set(record.clientId, record)),
      findById: (clientId) => Ref.get(state).pipe(Effect.map(HashMap.get(clientId))),
      listByOwner: (ownerId) =>
        Ref.get(state).pipe(
          Effect.map((records) =>
            newestFirst(HashMap.toValues(records).filter((record) => record.ownerId === ownerId)),
          ),
        ),
      revoke: (clientId, at) =>
        update(clientId, (record) =>
          Option.isSome(record.revokedAt) ? record : { ...record, revokedAt: Option.some(at) },
        ),
      rotateSecret: ({ clientId, secretHash, previousExpiresAt }) =>
        update(clientId, (record) => ({
          ...record,
          secretHash,
          previousSecretHash: Option.some(record.secretHash),
          previousExpiresAt: Option.some(previousExpiresAt),
        })),
    });
  }),
);

// ---- layerSql ---------------------------------------------------------------

const makeRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    clientId: Schema.String,
    ownerId: Schema.String,
    name: Schema.String,
    scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
    secretHash: Schema.String,
    previousSecretHash: Schema.NullOr(Schema.String),
    previousExpiresAt: wire.nullableDateTime,
    createdAt: wire.dateTime,
    revokedAt: wire.nullableDateTime,
  });

export const layerSql = Layer.effect(
  ApiKeyClientRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const Row = makeRow(wire);

    const toRecord = (row: typeof Row.Type): ApiKeyClientRecord => ({
      clientId: row.clientId,
      ownerId: Users.UserId(row.ownerId),
      name: row.name,
      scopes: row.scopes,
      secretHash: row.secretHash,
      previousSecretHash: Option.fromNullishOr(row.previousSecretHash),
      previousExpiresAt: Option.fromNullishOr(row.previousExpiresAt),
      createdAt: row.createdAt,
      revokedAt: Option.fromNullishOr(row.revokedAt),
    });

    const insertQuery = SqlSchema.void({
      Request: Row,
      execute: (r) => sql`
        INSERT INTO apikey_client
          ("clientId", "ownerId", name, scopes, "secretHash", "previousSecretHash", "previousExpiresAt", "createdAt", "revokedAt")
        VALUES
          (${r.clientId}, ${r.ownerId}, ${r.name}, ${r.scopes}, ${r.secretHash}, ${r.previousSecretHash}, ${r.previousExpiresAt}, ${r.createdAt}, ${r.revokedAt})
      `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Row,
      execute: (clientId) => sql`SELECT * FROM apikey_client WHERE "clientId" = ${clientId}`,
    });

    const listByOwnerQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: Row,
      execute: (ownerId) => sql`
        SELECT * FROM apikey_client WHERE "ownerId" = ${ownerId}
        ORDER BY "createdAt" DESC, "clientId" DESC
      `,
    });

    const revokeQuery = SqlSchema.void({
      Request: Schema.Struct({ clientId: Schema.String, at: wire.dateTime }),
      execute: (r) => sql`
        UPDATE apikey_client SET "revokedAt" = ${r.at}
        WHERE "clientId" = ${r.clientId} AND "revokedAt" IS NULL
      `,
    });

    // One statement, so the swap (current -> previous, new -> current) is atomic:
    // the right-hand `"secretHash"` in SET is the value before this UPDATE.
    const rotateQuery = SqlSchema.void({
      Request: Schema.Struct({
        clientId: Schema.String,
        secretHash: Schema.String,
        previousExpiresAt: wire.dateTime,
      }),
      execute: (r) => sql`
        UPDATE apikey_client
        SET "previousSecretHash" = "secretHash",
            "previousExpiresAt" = ${r.previousExpiresAt},
            "secretHash" = ${r.secretHash}
        WHERE "clientId" = ${r.clientId}
      `,
    });

    return ApiKeyClientRecords.of({
      insert: (record) =>
        insertQuery({
          clientId: record.clientId,
          ownerId: record.ownerId,
          name: record.name,
          scopes: record.scopes,
          secretHash: record.secretHash,
          previousSecretHash: Option.getOrNull(record.previousSecretHash),
          previousExpiresAt: Option.getOrNull(record.previousExpiresAt),
          createdAt: record.createdAt,
          revokedAt: Option.getOrNull(record.revokedAt),
        }).pipe(Effect.orDie),
      findById: (clientId) =>
        findByIdQuery(clientId).pipe(Effect.map(Option.map(toRecord)), Effect.orDie),
      listByOwner: (ownerId) =>
        listByOwnerQuery(ownerId).pipe(
          Effect.map((rows) => rows.map(toRecord)),
          Effect.orDie,
        ),
      revoke: (clientId, at) => revokeQuery({ clientId, at }).pipe(Effect.orDie),
      rotateSecret: (input) => rotateQuery(input).pipe(Effect.orDie),
    });
  }),
);
