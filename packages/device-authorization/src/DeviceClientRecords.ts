// @awthaq/device-authorization — DeviceClientRecords
//
// BEH-EA-316. Persistence for `device_authorization_client`: the public clients an operator registers at
// runtime (`DeviceAuthorization.registerClient`), beside the static ones `DeviceAuthorizationConfig.clients`
// lists. A device client is *public* by RFC 8628's own model — it has no secret, the device code is the
// credential — so this row holds only what the approval page shows the user (`name`) and the scopes the
// client may ask for; an unregistered or revoked `client_id` is refused at `POST /device/code`.

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

export interface DeviceClientRecord {
  readonly clientId: string;
  /** Shown to the person on the approval page: "awthaq CLI wants to sign in as you". */
  readonly name: string;
  /** The scopes the client may request; empty means it may request none (a plain login). */
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly revokedAt: Option.Option<DateTime.Utc>;
}

export interface DeviceClientRecordsShape {
  /** `false` when the `clientId` is already registered. */
  readonly insert: (record: DeviceClientRecord) => Effect.Effect<boolean>;
  readonly findById: (clientId: string) => Effect.Effect<Option.Option<DeviceClientRecord>>;
  /** Oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<DeviceClientRecord>>;
  /** Sets `revokedAt` once; resolves to whether a live client was revoked. */
  readonly revoke: (clientId: string, at: DateTime.Utc) => Effect.Effect<boolean>;
}

export class DeviceClientRecords extends Context.Service<
  DeviceClientRecords,
  DeviceClientRecordsShape
>()("awthaq/device-authorization/DeviceClientRecords") {}

// ---- layerMemory ------------------------------------------------------------

const oldestFirst = (records: ReadonlyArray<DeviceClientRecord>) =>
  records.toSorted((a, b) => {
    const byTime = DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt);
    return byTime !== 0 ? byTime : a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
  });

export const layerMemory = Layer.effect(
  DeviceClientRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<string, DeviceClientRecord>());
    return DeviceClientRecords.of({
      insert: (record) =>
        Ref.modify(state, (records) =>
          HashMap.has(records, record.clientId)
            ? ([false, records] as const)
            : ([true, HashMap.set(records, record.clientId, record)] as const),
        ),
      findById: (clientId) => Ref.get(state).pipe(Effect.map(HashMap.get(clientId))),
      list: Ref.get(state).pipe(Effect.map((records) => oldestFirst(HashMap.toValues(records)))),
      revoke: (clientId, at) =>
        Ref.modify(state, (records) => {
          const found = HashMap.get(records, clientId);
          return Option.isSome(found) && Option.isNone(found.value.revokedAt)
            ? ([
                true,
                HashMap.set(records, clientId, { ...found.value, revokedAt: Option.some(at) }),
              ] as const)
            : ([false, records] as const);
        }),
    });
  }),
);

// ---- layerSql ---------------------------------------------------------------

const makeRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    clientId: Schema.String,
    name: Schema.String,
    scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
    createdAt: wire.dateTime,
    revokedAt: wire.nullableDateTime,
  });

export const layerSql = Layer.effect(
  DeviceClientRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const Row = makeRow(wire);
    const ClientId = Schema.Struct({ clientId: Schema.String });

    const toRecord = (row: typeof Row.Type): DeviceClientRecord => ({
      clientId: row.clientId,
      name: row.name,
      scopes: row.scopes,
      createdAt: row.createdAt,
      revokedAt: Option.fromNullishOr(row.revokedAt),
    });

    const insertQuery = SqlSchema.findOneOption({
      Request: Row,
      Result: ClientId,
      execute: (r) => sql`
        INSERT INTO device_authorization_client ("clientId", name, scopes, "createdAt", "revokedAt")
        VALUES (${r.clientId}, ${r.name}, ${r.scopes}, ${r.createdAt}, ${r.revokedAt})
        ON CONFLICT DO NOTHING
        RETURNING "clientId"
      `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Row,
      execute: (clientId) =>
        sql`SELECT * FROM device_authorization_client WHERE "clientId" = ${clientId}`,
    });

    const listQuery = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Row,
      execute: () =>
        sql`SELECT * FROM device_authorization_client ORDER BY "createdAt" ASC, "clientId" ASC`,
    });

    const revokeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ clientId: Schema.String, at: wire.dateTime }),
      Result: ClientId,
      execute: (r) => sql`
        UPDATE device_authorization_client SET "revokedAt" = ${r.at}
        WHERE "clientId" = ${r.clientId} AND "revokedAt" IS NULL
        RETURNING "clientId"
      `,
    });

    return DeviceClientRecords.of({
      insert: (record) =>
        insertQuery({
          clientId: record.clientId,
          name: record.name,
          scopes: record.scopes,
          createdAt: record.createdAt,
          revokedAt: Option.getOrNull(record.revokedAt),
        }).pipe(Effect.map(Option.isSome), Effect.orDie),
      findById: (clientId) =>
        findByIdQuery(clientId).pipe(Effect.map(Option.map(toRecord)), Effect.orDie),
      list: listQuery(undefined).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      ),
      revoke: (clientId, at) =>
        revokeQuery({ clientId, at }).pipe(Effect.map(Option.isSome), Effect.orDie),
    });
  }),
);
