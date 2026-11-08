// @awthaq/api-key — ApiKeyRecords
//
// OCM-002. This plugin's own persistence for the `apikey_key` table, built the way
// `@awthaq/jwt`'s `SigningKeyRecords` builds its own: a records service with an
// in-memory and a SQL layer (SQLite and Postgres, ADR-EA-004), the row codecs following
// the ambient client's dialect (`Models.dialectFields`, TS-001).
//
// Only `secretHash` (SHA-256, `SecretHash.digest`) is persisted, never the secret. The
// records service owns storage, not policy: ownership checks, expiry, scopes and
// rotation policy are `ApiKey.ts`'s job. What must be decided with the write is decided here
// (plan 25 F6/F10): `rotate` stores a successor only while the predecessor is live, and
// `revoke` answers whether this call is the one that revoked the key.

import { Users } from "@awthaq/core";
import { Defects, SqlTransaction } from "@awthaq/ports";
import { Models as SqlModels, StoreFailure } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

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

/** `rotate`'s input: the successor is fully built by the caller; the store decides whether it may exist. */
export interface Rotation {
  readonly predecessorId: string;
  readonly successor: ApiKeyRecord;
  /** The predecessor's expiry is shortened (never extended) to this instant. */
  readonly graceUntil: DateTime.Utc;
  /** Liveness is judged at this instant: not revoked, and no expiry at or before it. */
  readonly now: DateTime.Utc;
}

export interface ApiKeyRecordsShape {
  /** A record whose id already exists is a defect (ids are fresh UUIDv7s), on every adapter. */
  readonly insert: (record: ApiKeyRecord) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  readonly findById: (
    id: string,
  ) => Effect.Effect<Option.Option<ApiKeyRecord>, StoreFailure.StoreUnavailable>;
  /** Newest first. */
  readonly listByOwner: (
    ownerId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<ApiKeyRecord>, StoreFailure.StoreUnavailable>;
  /**
   * Sets `revokedAt` once; a key already revoked keeps its first revocation time. `true` only for
   * the call that revoked it, so of any number of concurrent revocations exactly one answers `true`.
   */
  readonly revoke: (
    id: string,
    at: DateTime.Utc,
  ) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
  /**
   * OCM-005, decided at the write: while the predecessor is live at `now`, shortens its expiry to
   * `graceUntil` (never lengthens it) and stores the successor, as one step; otherwise stores
   * nothing and answers `"notLive"` (unknown, revoked or expired). A revocation racing the
   * rotation either precedes it (no successor) or follows it.
   */
  readonly rotate: (
    rotation: Rotation,
  ) => Effect.Effect<"rotated" | "notLive", StoreFailure.StoreUnavailable>;
  readonly touch: (
    id: string,
    at: DateTime.Utc,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** Erasure: every key the user owns, revoked or not. Idempotent. */
  readonly deleteByOwner: (
    ownerId: Users.UserId,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
}

export class ApiKeyRecords extends Context.Service<ApiKeyRecords, ApiKeyRecordsShape>()(
  "awthaq/api-key/records/ApiKeyRecords",
) {}

// ---- layerMemory ------------------------------------------------------------

const newestFirst = (records: ReadonlyArray<ApiKeyRecord>): ReadonlyArray<ApiKeyRecord> =>
  [...records].sort((a, b) => {
    const byTime = DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);
    return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

const millis = DateTime.toEpochMillis;

/** Not revoked, and no expiry at or before `now` (the same test as `ApiKey.isLive`). */
const liveAt = (record: ApiKeyRecord, now: DateTime.Utc) =>
  Option.isNone(record.revokedAt) &&
  !Option.exists(record.expiresAt, (expiresAt) => millis(expiresAt) <= millis(now));

/** The earlier of the key's own expiry and `until`: a grace window never lengthens a key. */
const capExpiry = (record: ApiKeyRecord, until: DateTime.Utc) =>
  Option.exists(record.expiresAt, (expiresAt) => millis(expiresAt) <= millis(until))
    ? record.expiresAt
    : Option.some(until);

type Keys = HashMap.HashMap<string, ApiKeyRecord>;

/** The memory twin of SQL's primary-key violation: a caller-minted id is never reused. */
const duplicateId = (id: string) =>
  Defects.invariantViolation(
    "ApiKeyRecords.duplicateId",
    `awthaq: ApiKeyRecords already holds a key with id ${id}`,
  );

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
      insert: (record) =>
        Effect.flatMap(
          Ref.modify(state, (records): [boolean, Keys] =>
            HashMap.has(records, record.id)
              ? [false, records]
              : [true, HashMap.set(records, record.id, record)],
          ),
          (stored) => (stored ? Effect.void : duplicateId(record.id)),
        ),
      findById: (id) => Ref.get(state).pipe(Effect.map(HashMap.get(id))),
      listByOwner: (ownerId) =>
        Ref.get(state).pipe(
          Effect.map((records) =>
            newestFirst(HashMap.toValues(records).filter((record) => record.ownerId === ownerId)),
          ),
        ),
      revoke: (id, at) =>
        Ref.modify(state, (records): [boolean, Keys] => {
          const found = HashMap.get(records, id);
          return Option.isNone(found) || Option.isSome(found.value.revokedAt)
            ? [false, records]
            : [true, HashMap.set(records, id, { ...found.value, revokedAt: Option.some(at) })];
        }),
      rotate: ({ predecessorId, successor, graceUntil, now }) =>
        Effect.flatMap(
          Ref.modify(state, (records): ["rotated" | "notLive" | "duplicate", Keys] => {
            const found = HashMap.get(records, predecessorId);
            if (Option.isNone(found) || !liveAt(found.value, now)) return ["notLive", records];
            if (HashMap.has(records, successor.id)) return ["duplicate", records];
            const capped = { ...found.value, expiresAt: capExpiry(found.value, graceUntil) };
            return [
              "rotated",
              HashMap.set(HashMap.set(records, predecessorId, capped), successor.id, successor),
            ];
          }),
          (outcome) =>
            outcome === "duplicate" ? duplicateId(successor.id) : Effect.succeed(outcome),
        ),
      touch: (id, at) => update(id, (record) => ({ ...record, lastUsedAt: Option.some(at) })),
      deleteByOwner: (ownerId) =>
        Ref.update(state, (records) =>
          HashMap.filter(records, (record) => record.ownerId !== ownerId),
        ),
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
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`ApiKeyRecords.${operation}`);
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

    const Touched = Schema.Struct({ id: Schema.String });

    // `revokedAt IS NULL` keeps the first revocation time; the returned row says this call revoked it.
    const revokeQuery = SqlSchema.findAll({
      Request: Schema.Struct({ id: Schema.String, at: wire.dateTime }),
      Result: Touched,
      execute: (r) => sql`
        UPDATE apikey_key SET "revokedAt" = ${r.at}
        WHERE id = ${r.id} AND "revokedAt" IS NULL
        RETURNING id
      `,
    });

    // F6: the liveness check and the grace cap are one conditional statement. On Postgres it holds
    // the predecessor's row lock until the successor's insert commits, so a racing revoke (or a
    // second rotation) either sees the row already rotated or is seen by this one.
    const capPredecessorQuery = SqlSchema.findAll({
      Request: Schema.Struct({ id: Schema.String, graceUntil: wire.dateTime, now: wire.dateTime }),
      Result: Touched,
      execute: (r) => sql`
        UPDATE apikey_key
        SET "expiresAt" = CASE
          WHEN "expiresAt" IS NOT NULL AND "expiresAt" <= ${r.graceUntil} THEN "expiresAt"
          ELSE ${r.graceUntil}
        END
        WHERE id = ${r.id} AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > ${r.now})
        RETURNING id
      `,
    });

    const touchQuery = SqlSchema.void({
      Request: Schema.Struct({ id: Schema.String, at: wire.dateTime }),
      execute: (r) => sql`UPDATE apikey_key SET "lastUsedAt" = ${r.at} WHERE id = ${r.id}`,
    });

    const deleteByOwnerQuery = SqlSchema.void({
      Request: Schema.String,
      execute: (ownerId) => sql`DELETE FROM apikey_key WHERE "ownerId" = ${ownerId}`,
    });

    const insertRecord = (record: ApiKeyRecord) =>
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
      }).pipe(
        // A reused id is a bug in the caller, not an outage: a defect, like the memory layer's.
        Effect.catchIf(StoreFailure.isUniqueViolation, (error) => Effect.die(error)),
      );

    return ApiKeyRecords.of({
      insert: (record) => insertRecord(record).pipe(unavailable("insert")),
      findById: (id) =>
        findByIdQuery(id).pipe(Effect.map(Option.map(toRecord)), unavailable("findById")),
      listByOwner: (ownerId) =>
        listByOwnerQuery(ownerId).pipe(
          Effect.map((rows) => rows.map(toRecord)),
          unavailable("listByOwner"),
        ),
      revoke: (id, at) =>
        revokeQuery({ id, at }).pipe(
          Effect.map((rows) => rows.length > 0),
          unavailable("revoke"),
        ),
      rotate: ({ predecessorId, successor, graceUntil, now }) =>
        Effect.gen(function* () {
          const capped = yield* capPredecessorQuery({ id: predecessorId, graceUntil, now });
          if (capped.length === 0) return "notLive";
          yield* insertRecord(successor);
          return "rotated";
        }).pipe(SqlTransaction.transactional(sql), unavailable("rotate")),
      touch: (id, at) => touchQuery({ id, at }).pipe(unavailable("touch")),
      deleteByOwner: (ownerId) => deleteByOwnerQuery(ownerId).pipe(unavailable("deleteByOwner")),
    });
  }),
);
