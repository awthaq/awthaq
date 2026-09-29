// @awthaq/device-authorization — DeviceGrantRecords
//
// BEH-EA-300/312/313, spec/models/13-device-authorization.md "Design constraints". Persistence for
// `device_authorization_grant`, one row per pending, decided or unredeemed grant, built the way
// `@awthaq/api-key`'s records are: a records service with an in-memory and a SQL layer (SQLite and
// Postgres, ADR-EA-004), the row codecs following the client's dialect (`Models.dialectFields`).
//
// The service owns **storage and the compare-and-swap primitives**, not policy: every state change
// is one conditional statement, so two racing decisions or polls cannot both win (design constraints
// 1 to 4), whichever backend runs them.
//
//   claim        `status = pending` and no user yet           -> the first session to open the page wins
//   decide       `status = pending` and this user's claim      -> approved | denied, once
//   touchPoll    records the poll's time                       -> `lastPolledAt`, which the service compares
//                                                                with the row's interval (design constraint 4)
//   consume      `status = approved` and this user             -> the redemption claim: a delete that
//                                                                returns the row to exactly one caller
//
// Only SHA-256 hashes of the device and user codes are stored (`UserCode.hash*`), never a code.

import { Sessions, Users } from "@awthaq/core";
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

export type GrantStatus = "pending" | "approved" | "denied";

export interface DeviceGrantRecord {
  readonly id: string;
  readonly deviceCodeHash: string;
  readonly userCodeHash: string;
  readonly clientId: string;
  /** What the device asked for and the client was registered for. */
  readonly scopes: ReadonlyArray<string>;
  readonly status: GrantStatus;
  /** The user who claimed the code (by opening the verification page) and, later, decided it. */
  readonly userId: Option.Option<Users.UserId>;
  /** How the approving session authenticated; the redeemed session inherits it. Empty until approved. */
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
  /** Seconds the device must leave between polls; raised by each `slow_down`. */
  readonly pollInterval: number;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  readonly lastPolledAt: Option.Option<DateTime.Utc>;
}

export interface DeviceGrantRecordsShape {
  /** `false` when the user-code hash is already taken by a live row: the caller draws another code. */
  readonly insert: (record: DeviceGrantRecord) => Effect.Effect<boolean>;
  readonly findByDeviceHash: (hash: string) => Effect.Effect<Option.Option<DeviceGrantRecord>>;
  readonly findByUserHash: (hash: string) => Effect.Effect<Option.Option<DeviceGrantRecord>>;
  /** Compare-and-swap: sets `userId` only while `status = pending` and no user has claimed the row. */
  readonly claim: (id: string, userId: Users.UserId) => Effect.Effect<boolean>;
  /** Compare-and-swap: `pending` -> `status`, only for the user who claimed the row and only before `expiresAt`. */
  readonly decide: (input: {
    readonly id: string;
    readonly userId: Users.UserId;
    readonly status: "approved" | "denied";
    readonly amr: ReadonlyArray<Sessions.AuthMethod>;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<boolean>;
  /**
   * Records `now` as the row's last poll. Deliberately not a compare-and-swap: the interval check is a read
   * of `lastPolledAt` (design constraint 4), and two polls that arrive together both pass it and race at the
   * redemption claim (`consume`), where exactly one wins and the other is answered `invalid_grant`.
   */
  readonly touchPoll: (id: string, now: DateTime.Utc) => Effect.Effect<void>;
  /** RFC 8628 §3.5: adds `seconds` to the row's interval (atomically, so concurrent `slow_down`s each count). */
  readonly raiseInterval: (id: string, seconds: number) => Effect.Effect<void>;
  /**
   * The redemption claim: deletes the row only while it is `approved` for `userId` and hands it back to exactly
   * one caller. Of two concurrent redemptions one gets `Some`, the other `None`.
   */
  readonly consume: (
    id: string,
    userId: Users.UserId,
  ) => Effect.Effect<Option.Option<DeviceGrantRecord>>;
  /** Unconditional delete of one row (garbage collection on discovery). */
  readonly remove: (id: string) => Effect.Effect<void>;
  /** Retention: deletes every row whose `expiresAt` is before `before`; resolves to how many went. */
  readonly purgeExpired: (before: DateTime.Utc) => Effect.Effect<number>;
  /** Erasure and export: the rows the user claimed or decided. */
  readonly listByUser: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<DeviceGrantRecord>>;
  readonly deleteByUser: (userId: Users.UserId) => Effect.Effect<void>;
}

export class DeviceGrantRecords extends Context.Service<
  DeviceGrantRecords,
  DeviceGrantRecordsShape
>()("awthaq/device-authorization/DeviceGrantRecords") {}

// ---- layerMemory ------------------------------------------------------------

const millis = DateTime.toEpochMillis;

export const layerMemory = Layer.effect(
  DeviceGrantRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<string, DeviceGrantRecord>());

    /** One atomic step: `change` returns the successor row, or `None` when its precondition fails. */
    const swap = (
      id: string,
      change: (record: DeviceGrantRecord) => Option.Option<DeviceGrantRecord>,
    ) =>
      Ref.modify(state, (records) =>
        Option.match(Option.flatMap(HashMap.get(records, id), change), {
          onNone: () => [false, records] as const,
          onSome: (next) => [true, HashMap.set(records, id, next)] as const,
        }),
      );

    const find = (matches: (record: DeviceGrantRecord) => boolean) =>
      Ref.get(state).pipe(
        Effect.map((records) => Option.fromNullishOr(HashMap.toValues(records).find(matches))),
      );

    return DeviceGrantRecords.of({
      insert: (record) =>
        Ref.modify(state, (records) =>
          HashMap.toValues(records).some(
            (row) =>
              row.userCodeHash === record.userCodeHash ||
              row.deviceCodeHash === record.deviceCodeHash,
          )
            ? ([false, records] as const)
            : ([true, HashMap.set(records, record.id, record)] as const),
        ),
      findByDeviceHash: (hash) => find((record) => record.deviceCodeHash === hash),
      findByUserHash: (hash) => find((record) => record.userCodeHash === hash),
      claim: (id, userId) =>
        swap(id, (record) =>
          record.status === "pending" && Option.isNone(record.userId)
            ? Option.some({ ...record, userId: Option.some(userId) })
            : Option.none(),
        ),
      decide: ({ id, userId, status, amr, now }) =>
        swap(id, (record) =>
          record.status === "pending" &&
          Option.exists(record.userId, (owner) => owner === userId) &&
          millis(record.expiresAt) > millis(now)
            ? Option.some({ ...record, status, amr })
            : Option.none(),
        ),
      touchPoll: (id, now) =>
        swap(id, (record) => Option.some({ ...record, lastPolledAt: Option.some(now) })).pipe(
          Effect.asVoid,
        ),
      raiseInterval: (id, seconds) =>
        swap(id, (record) =>
          Option.some({ ...record, pollInterval: record.pollInterval + seconds }),
        ).pipe(Effect.asVoid),
      consume: (id, userId) =>
        Ref.modify(state, (records) => {
          const found = HashMap.get(records, id);
          return Option.isSome(found) &&
            found.value.status === "approved" &&
            Option.exists(found.value.userId, (owner) => owner === userId)
            ? ([found, HashMap.remove(records, id)] as const)
            : ([Option.none<DeviceGrantRecord>(), records] as const);
        }),
      remove: (id) => Ref.update(state, HashMap.remove(id)),
      purgeExpired: (before) =>
        Ref.modify(state, (records) => {
          const expired = HashMap.toValues(records).filter(
            (record) => millis(record.expiresAt) < millis(before),
          );
          return [
            expired.length,
            HashMap.removeMany(
              records,
              expired.map((record) => record.id),
            ),
          ] as const;
        }),
      listByUser: (userId) =>
        Ref.get(state).pipe(
          Effect.map((records) =>
            HashMap.toValues(records)
              .filter((record) => Option.exists(record.userId, (owner) => owner === userId))
              .toSorted((a, b) => millis(a.createdAt) - millis(b.createdAt)),
          ),
        ),
      deleteByUser: (userId) =>
        Ref.update(state, (records) =>
          HashMap.filter(
            records,
            (record) => !Option.exists(record.userId, (owner) => owner === userId),
          ),
        ),
    });
  }),
);

// ---- layerSql ---------------------------------------------------------------

const makeRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    deviceCodeHash: Schema.String,
    userCodeHash: Schema.String,
    clientId: Schema.String,
    scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
    status: Schema.Literals(["pending", "approved", "denied"]),
    userId: Schema.NullOr(Schema.String),
    amr: Schema.fromJsonString(Schema.Array(Schema.String)),
    pollInterval: Schema.Number,
    createdAt: wire.dateTime,
    expiresAt: wire.dateTime,
    lastPolledAt: wire.nullableDateTime,
  });

export const layerSql = Layer.effect(
  DeviceGrantRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const Row = makeRow(wire);

    const toRecord = (row: typeof Row.Type): DeviceGrantRecord => ({
      id: row.id,
      deviceCodeHash: row.deviceCodeHash,
      userCodeHash: row.userCodeHash,
      clientId: row.clientId,
      scopes: row.scopes,
      status: row.status,
      userId: Option.map(Option.fromNullishOr(row.userId), Users.UserId),
      amr: row.amr.filter(Sessions.isAuthMethod),
      pollInterval: row.pollInterval,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastPolledAt: Option.fromNullishOr(row.lastPolledAt),
    });

    const Id = Schema.Struct({ id: Schema.String });

    // `ON CONFLICT DO NOTHING RETURNING` reports the insert as a row only when it happened.
    const insertQuery = SqlSchema.findOneOption({
      Request: Row,
      Result: Id,
      execute: (r) => sql`
        INSERT INTO device_authorization_grant
          (id, "deviceCodeHash", "userCodeHash", "clientId", scopes, status, "userId", amr, "pollInterval", "createdAt", "expiresAt", "lastPolledAt")
        VALUES
          (${r.id}, ${r.deviceCodeHash}, ${r.userCodeHash}, ${r.clientId}, ${r.scopes}, ${r.status}, ${r.userId}, ${r.amr}, ${r.pollInterval}, ${r.createdAt}, ${r.expiresAt}, ${r.lastPolledAt})
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
    });

    const findByDeviceQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Row,
      execute: (hash) =>
        sql`SELECT * FROM device_authorization_grant WHERE "deviceCodeHash" = ${hash}`,
    });

    const findByUserQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Row,
      execute: (hash) =>
        sql`SELECT * FROM device_authorization_grant WHERE "userCodeHash" = ${hash}`,
    });

    const claimQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, userId: Schema.String }),
      Result: Id,
      execute: (r) => sql`
        UPDATE device_authorization_grant SET "userId" = ${r.userId}
        WHERE id = ${r.id} AND status = 'pending' AND "userId" IS NULL
        RETURNING id
      `,
    });

    const decideQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        userId: Schema.String,
        status: Schema.Literals(["approved", "denied"]),
        amr: Schema.fromJsonString(Schema.Array(Schema.String)),
        now: wire.dateTime,
      }),
      Result: Id,
      execute: (r) => sql`
        UPDATE device_authorization_grant SET status = ${r.status}, amr = ${r.amr}
        WHERE id = ${r.id} AND status = 'pending' AND "userId" = ${r.userId} AND "expiresAt" > ${r.now}
        RETURNING id
      `,
    });

    const touchQuery = SqlSchema.void({
      Request: Schema.Struct({ id: Schema.String, now: wire.dateTime }),
      execute: (r) => sql`
        UPDATE device_authorization_grant SET "lastPolledAt" = ${r.now} WHERE id = ${r.id}
      `,
    });

    const raiseQuery = SqlSchema.void({
      Request: Schema.Struct({ id: Schema.String, seconds: Schema.Number }),
      execute: (r) => sql`
        UPDATE device_authorization_grant SET "pollInterval" = "pollInterval" + ${r.seconds}
        WHERE id = ${r.id}
      `,
    });

    const consumeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, userId: Schema.String }),
      Result: Row,
      execute: (r) => sql`
        DELETE FROM device_authorization_grant
        WHERE id = ${r.id} AND status = 'approved' AND "userId" = ${r.userId}
        RETURNING *
      `,
    });

    const removeQuery = SqlSchema.void({
      Request: Schema.String,
      execute: (id) => sql`DELETE FROM device_authorization_grant WHERE id = ${id}`,
    });

    const purgeQuery = SqlSchema.findAll({
      Request: wire.dateTime,
      Result: Id,
      execute: (before) => sql`
        DELETE FROM device_authorization_grant WHERE "expiresAt" < ${before} RETURNING id
      `,
    });

    const listByUserQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: Row,
      execute: (userId) => sql`
        SELECT * FROM device_authorization_grant WHERE "userId" = ${userId}
        ORDER BY "createdAt" ASC, id ASC
      `,
    });

    const deleteByUserQuery = SqlSchema.void({
      Request: Schema.String,
      execute: (userId) => sql`DELETE FROM device_authorization_grant WHERE "userId" = ${userId}`,
    });

    return DeviceGrantRecords.of({
      insert: (record) =>
        insertQuery({
          id: record.id,
          deviceCodeHash: record.deviceCodeHash,
          userCodeHash: record.userCodeHash,
          clientId: record.clientId,
          scopes: record.scopes,
          status: record.status,
          userId: Option.getOrNull(record.userId),
          amr: record.amr,
          pollInterval: record.pollInterval,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          lastPolledAt: Option.getOrNull(record.lastPolledAt),
        }).pipe(Effect.map(Option.isSome), Effect.orDie),
      findByDeviceHash: (hash) =>
        findByDeviceQuery(hash).pipe(Effect.map(Option.map(toRecord)), Effect.orDie),
      findByUserHash: (hash) =>
        findByUserQuery(hash).pipe(Effect.map(Option.map(toRecord)), Effect.orDie),
      claim: (id, userId) =>
        claimQuery({ id, userId }).pipe(Effect.map(Option.isSome), Effect.orDie),
      decide: ({ id, userId, status, amr, now }) =>
        decideQuery({ id, userId, status, amr, now }).pipe(Effect.map(Option.isSome), Effect.orDie),
      touchPoll: (id, now) => touchQuery({ id, now }).pipe(Effect.orDie),
      raiseInterval: (id, seconds) => raiseQuery({ id, seconds }).pipe(Effect.orDie),
      consume: (id, userId) =>
        consumeQuery({ id, userId }).pipe(Effect.map(Option.map(toRecord)), Effect.orDie),
      remove: (id) => removeQuery(id).pipe(Effect.orDie),
      purgeExpired: (before) =>
        purgeQuery(before).pipe(
          Effect.map((rows) => rows.length),
          Effect.orDie,
        ),
      listByUser: (userId) =>
        listByUserQuery(userId).pipe(
          Effect.map((rows) => rows.map(toRecord)),
          Effect.orDie,
        ),
      deleteByUser: (userId) => deleteByUserQuery(userId).pipe(Effect.orDie),
    });
  }),
);
