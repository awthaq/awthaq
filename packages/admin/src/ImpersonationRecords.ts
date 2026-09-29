// @awthaq/admin — ImpersonationRecords
//
// spec/behaviors/27-admin-impersonation.md, BEH-EA-215/219. This plugin's
// own persistence for the `admin_impersonation` table — a durable audit
// trail independent of the `Session` row's own lifecycle, built directly
// against `effect/unstable/sql`'s `SqlSchema` the same way
// `@awthaq/passkey`'s own `PasskeyCredentials.ts` builds its table:
// this table belongs to the plugin, not the shared persistence stratum.
//
// Keyed by the row's own generated `id`; `sessionId` is the practical lookup
// key `Admin.ts`'s `stopImpersonating`/`forceStop` use to find the episode
// to end — a session issued by `impersonate` is 1:1 with its own audit row.

import { Users } from "@awthaq/core";
import { Models as SqlModels } from "@awthaq/sql";
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

type UserId = Users.UserId;

/**
 * BEH-EA-217: the three ways an impersonation episode ends. `"expired"` is
 * declared for completeness with this closed set — like `@awthaq/passkey`'s
 * own `PasskeyCounterAnomaly` tag, it names a value no code path in this
 * plugin produces yet: nothing here observes a session's hard expiry and
 * calls `endEpisode(id, "expired")` on its behalf, so a naturally-expired
 * episode stays reported as `active` (BEH-EA-219) until a real
 * `stopImpersonating`/`forceStop` call ends it. Any future hard-expiry
 * observer is free to use this exact literal without a schema change.
 */
export type EndedBy = "self" | "forcedByAdmin" | "expired";

export interface ImpersonationRecord {
  readonly id: string;
  readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly sessionId: string;
  readonly reason: string;
  readonly startedAt: DateTime.Utc;
  readonly endedAt: Option.Option<DateTime.Utc>;
  readonly endedBy: Option.Option<EndedBy>;
}

/**
 * Enumeration-safe by construction (the same `PasskeyCredentialNotFound`
 * reasoning `PasskeyCredentials.ts` documents): an unknown `sessionId` and
 * one whose episode has already ended both answer this same error, so a
 * caller can never use `endEpisode` to probe whether a given session id was
 * ever a real impersonation episode.
 */
export class ImpersonationRecordNotFound extends Data.TaggedError("ImpersonationRecordNotFound")<{
  readonly message: string;
}> {}

export interface ImpersonationRecordsShape {
  /** BEH-EA-215: inserts one durable audit row at the moment `impersonate` issues a session. */
  readonly create: (input: {
    readonly adminUserId: UserId;
    readonly targetUserId: UserId;
    readonly sessionId: string;
    readonly reason: string;
  }) => Effect.Effect<ImpersonationRecord>;
  readonly findBySessionId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<ImpersonationRecord>>;
  /** Sets `endedAt`/`endedBy` exactly once — fails `ImpersonationRecordNotFound` for an unknown or already-ended session id. */
  readonly endEpisode: (
    sessionId: string,
    endedBy: EndedBy,
  ) => Effect.Effect<ImpersonationRecord, ImpersonationRecordNotFound>;
  /** BEH-EA-219: full history (newest-first) by default; `active: true` narrows to episodes with no `endedAt` yet. */
  readonly list: (input?: {
    readonly active?: boolean;
  }) => Effect.Effect<ReadonlyArray<ImpersonationRecord>>;
}

export class ImpersonationRecords extends Context.Service<
  ImpersonationRecords,
  ImpersonationRecordsShape
>()("awthaq/admin/ImpersonationRecords") {}

const notFound = (sessionId: string): ImpersonationRecordNotFound =>
  new ImpersonationRecordNotFound({
    message: `awthaq: no active impersonation episode for session: ${sessionId}`,
  });

const newestFirst = (
  records: ReadonlyArray<ImpersonationRecord>,
): ReadonlyArray<ImpersonationRecord> =>
  [...records].sort(
    (a, b) => DateTime.toEpochMillis(b.startedAt) - DateTime.toEpochMillis(a.startedAt),
  );

const applyActiveFilter = (
  records: ReadonlyArray<ImpersonationRecord>,
  input?: { readonly active?: boolean },
): ReadonlyArray<ImpersonationRecord> =>
  input?.active === true ? records.filter((row) => Option.isNone(row.endedAt)) : records;

// ---- layerMemory ------------------------------------------------------------

type RecordsState = HashMap.HashMap<string, ImpersonationRecord>;

export const layerMemory = Layer.effect(
  ImpersonationRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<RecordsState>(HashMap.empty());
    const crypto = yield* Crypto.Crypto;

    const create: ImpersonationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const record: ImpersonationRecord = {
        id,
        adminUserId: input.adminUserId,
        targetUserId: input.targetUserId,
        sessionId: input.sessionId,
        reason: input.reason,
        startedAt: now,
        endedAt: Option.none(),
        endedBy: Option.none(),
      };
      yield* Ref.update(state, (s) => HashMap.set(s, id, record));
      return record;
    });

    const findBySessionId: ImpersonationRecordsShape["findBySessionId"] = (sessionId) =>
      Ref.get(state).pipe(
        Effect.map((s) => Array.from(HashMap.values(s)).find((row) => row.sessionId === sessionId)),
        Effect.map(Option.fromNullishOr),
      );

    const endEpisode: ImpersonationRecordsShape["endEpisode"] = (sessionId, endedBy) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (
            s,
          ): readonly [
            Result.Result<ImpersonationRecord, ImpersonationRecordNotFound>,
            RecordsState,
          ] => {
            const existing = Array.from(HashMap.values(s)).find(
              (row) => row.sessionId === sessionId,
            );
            if (existing === undefined || Option.isSome(existing.endedAt)) {
              return [Result.fail(notFound(sessionId)), s] as const;
            }
            const updated: ImpersonationRecord = {
              ...existing,
              endedAt: Option.some(now),
              endedBy: Option.some(endedBy),
            };
            return [Result.succeed(updated), HashMap.set(s, existing.id, updated)] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const list: ImpersonationRecordsShape["list"] = (input) =>
      Ref.get(state).pipe(
        Effect.map((s) => applyActiveFilter(newestFirst(Array.from(HashMap.values(s))), input)),
      );

    return { create, findBySessionId, endEpisode, list };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const makeImpersonationRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    adminUserId: Schema.String,
    targetUserId: Schema.String,
    sessionId: Schema.String,
    reason: Schema.String,
    startedAt: wire.dateTime,
    endedAt: wire.nullableDateTime,
    endedBy: Schema.NullOr(Schema.Literals(["self", "forcedByAdmin", "expired"])),
  });

type ImpersonationRow = ReturnType<typeof makeImpersonationRow>["Type"];

const toRecord = (row: ImpersonationRow): ImpersonationRecord => ({
  id: row.id,
  adminUserId: Users.UserId(row.adminUserId),
  targetUserId: Users.UserId(row.targetUserId),
  sessionId: row.sessionId,
  reason: row.reason,
  startedAt: row.startedAt,
  endedAt: Option.fromNullishOr(row.endedAt),
  endedBy: Option.fromNullishOr(row.endedBy),
});

export const layerSql = Layer.effect(
  ImpersonationRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const ImpersonationRow = makeImpersonationRow(wire);
    const crypto = yield* Crypto.Crypto;

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        adminUserId: Schema.String,
        targetUserId: Schema.String,
        sessionId: Schema.String,
        reason: Schema.String,
        startedAt: wire.dateTime,
      }),
      Result: ImpersonationRow,
      execute: (r) => sql`
          INSERT INTO admin_impersonation
            (id, adminUserId, targetUserId, sessionId, reason, startedAt, endedAt, endedBy)
          VALUES
            (${r.id}, ${r.adminUserId}, ${r.targetUserId}, ${r.sessionId}, ${r.reason}, ${r.startedAt}, NULL, NULL)
          RETURNING *
        `,
    });

    const findBySessionIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ImpersonationRow,
      execute: (sessionId) => sql`SELECT * FROM admin_impersonation WHERE sessionId = ${sessionId}`,
    });

    const endEpisodeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: Schema.String,
        endedAt: wire.dateTime,
        endedBy: Schema.Literals(["self", "forcedByAdmin", "expired"]),
      }),
      Result: ImpersonationRow,
      execute: (r) => sql`
          UPDATE admin_impersonation SET endedAt = ${r.endedAt}, endedBy = ${r.endedBy}
          WHERE sessionId = ${r.sessionId} AND endedAt IS NULL
          RETURNING *
        `,
    });

    const listAllQuery = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ImpersonationRow,
      execute: () => sql`SELECT * FROM admin_impersonation ORDER BY startedAt DESC`,
    });

    const listActiveQuery = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ImpersonationRow,
      execute: () =>
        sql`SELECT * FROM admin_impersonation WHERE endedAt IS NULL ORDER BY startedAt DESC`,
    });

    const create: ImpersonationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const row = yield* insert({
        id,
        adminUserId: input.adminUserId,
        targetUserId: input.targetUserId,
        sessionId: input.sessionId,
        reason: input.reason,
        startedAt: now,
      }).pipe(Effect.orDie);
      return toRecord(row);
    });

    const findBySessionId: ImpersonationRecordsShape["findBySessionId"] = (sessionId) =>
      findBySessionIdQuery(sessionId).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const endEpisode: ImpersonationRecordsShape["endEpisode"] = (sessionId, endedBy) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const updated = yield* endEpisodeQuery({ sessionId, endedAt: now, endedBy }).pipe(
          Effect.orDie,
        );
        if (Option.isNone(updated)) return yield* Effect.fail(notFound(sessionId));
        return toRecord(updated.value);
      });

    const list: ImpersonationRecordsShape["list"] = (input) =>
      (input?.active === true ? listActiveQuery(undefined) : listAllQuery(undefined)).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    return { create, findBySessionId, endEpisode, list };
  }),
);
