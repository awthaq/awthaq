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
 * BEH-EA-217: the three ways an impersonation episode ends. IDS-004:
 * `"expired"` is produced by `closeExpired` — the session's own hard expiry
 * (recorded per episode as `expiresAt`) observed by `Admin`'s lazy
 * reconciliation on every read and by its exported sweep.
 */
export type EndedBy = "self" | "forcedByAdmin" | "expired";

export interface ImpersonationRecord {
  readonly id: string;
  readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly sessionId: string;
  readonly reason: string;
  readonly startedAt: DateTime.Utc;
  /** IDS-004: the impersonation session's hard expiry; `None` only for rows written before it was recorded. */
  readonly expiresAt: Option.Option<DateTime.Utc>;
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

/** ESS-006/BEH-EA-036: keyset position of the history — `(startedAt, id)`, newest-first. */
export interface ImpersonationCursor {
  readonly startedAt: DateTime.Utc;
  readonly id: string;
}

export interface ImpersonationPage {
  readonly items: ReadonlyArray<ImpersonationRecord>;
  /** `None` on the last page — an exactly-full final page does not invent a cursor. */
  readonly nextCursor: Option.Option<ImpersonationCursor>;
}

/** ESS-006: applied when a caller names no `limit`, so no read is ever unbounded. */
export const DEFAULT_PAGE_SIZE = 50;

export interface ImpersonationRecordsShape {
  /** BEH-EA-215: inserts one durable audit row at the moment `impersonate` issues a session. */
  readonly create: (input: {
    readonly adminUserId: UserId;
    readonly targetUserId: UserId;
    readonly sessionId: string;
    readonly reason: string;
    /** IDS-004: the issued session's `absoluteExpiresAt`. */
    readonly expiresAt: DateTime.Utc;
  }) => Effect.Effect<ImpersonationRecord>;
  readonly findBySessionId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<ImpersonationRecord>>;
  /** Sets `endedAt`/`endedBy` exactly once — fails `ImpersonationRecordNotFound` for an unknown or already-ended session id. */
  readonly endEpisode: (
    sessionId: string,
    endedBy: EndedBy,
  ) => Effect.Effect<ImpersonationRecord, ImpersonationRecordNotFound>;
  /**
   * IDS-004: atomically closes every still-open episode whose `expiresAt` is at
   * or before `now`, as `endedBy: "expired"` with `endedAt` = its own
   * `expiresAt`, and returns exactly the rows this call closed — so each
   * expired episode is closed (and announced) once however many callers race.
   */
  readonly closeExpired: (now: DateTime.Utc) => Effect.Effect<ReadonlyArray<ImpersonationRecord>>;
  /**
   * BEH-EA-219/ESS-006: history newest-first, keyset-paginated on
   * `(startedAt, id)`; `active: true` narrows to episodes with no `endedAt`
   * yet. Never loads more than `limit + 1` rows.
   */
  readonly list: (input?: {
    readonly active?: boolean | undefined;
    readonly cursor?: ImpersonationCursor | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ImpersonationPage>;
}

export class ImpersonationRecords extends Context.Service<
  ImpersonationRecords,
  ImpersonationRecordsShape
>()("awthaq/admin/ImpersonationRecords") {}

const notFound = (sessionId: string): ImpersonationRecordNotFound =>
  new ImpersonationRecordNotFound({
    message: `awthaq: no active impersonation episode for session: ${sessionId}`,
  });

/** Newest-first with `id` as the tiebreak, the same total order the SQL `ORDER BY startedAt DESC, id DESC` gives. */
const newestFirst = (
  records: ReadonlyArray<ImpersonationRecord>,
): ReadonlyArray<ImpersonationRecord> =>
  [...records].sort((a, b) => {
    const byTime = DateTime.toEpochMillis(b.startedAt) - DateTime.toEpochMillis(a.startedAt);
    return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

const isBeforeCursor = (record: ImpersonationRecord, cursor: ImpersonationCursor): boolean => {
  const recordMillis = DateTime.toEpochMillis(record.startedAt);
  const cursorMillis = DateTime.toEpochMillis(cursor.startedAt);
  return recordMillis < cursorMillis || (recordMillis === cursorMillis && record.id < cursor.id);
};

/** Turns `limit + 1` fetched rows into a page: the extra row proves there is a next one and is dropped. */
const toPage = (rows: ReadonlyArray<ImpersonationRecord>, limit: number): ImpersonationPage => {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined
        ? Option.some({ startedAt: last.startedAt, id: last.id })
        : Option.none(),
  };
};

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
        expiresAt: Option.some(input.expiresAt),
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

    const closeExpired: ImpersonationRecordsShape["closeExpired"] = (now) =>
      Ref.modify(state, (s) => {
        const closed: Array<ImpersonationRecord> = [];
        let next = s;
        for (const row of HashMap.values(s)) {
          if (
            Option.isNone(row.endedAt) &&
            Option.isSome(row.expiresAt) &&
            DateTime.toEpochMillis(row.expiresAt.value) <= DateTime.toEpochMillis(now)
          ) {
            const updated: ImpersonationRecord = {
              ...row,
              endedAt: row.expiresAt,
              endedBy: Option.some("expired"),
            };
            closed.push(updated);
            next = HashMap.set(next, row.id, updated);
          }
        }
        return [closed, next] as const;
      });

    const list: ImpersonationRecordsShape["list"] = (input) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
          const cursor = input?.cursor;
          const rows = newestFirst(Array.from(HashMap.values(s))).filter(
            (row) =>
              (input?.active !== true || Option.isNone(row.endedAt)) &&
              (cursor === undefined || isBeforeCursor(row, cursor)),
          );
          return toPage(rows.slice(0, limit + 1), limit);
        }),
      );

    return { create, findBySessionId, endEpisode, closeExpired, list };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const EndedBySchema = Schema.Literals(["self", "forcedByAdmin", "expired"]);

const ImpersonationRow = Schema.Struct({
  id: Schema.String,
  adminUserId: Schema.String,
  targetUserId: Schema.String,
  sessionId: Schema.String,
  reason: Schema.String,
  startedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  endedBy: Schema.NullOr(EndedBySchema),
});

const toRecord = (row: typeof ImpersonationRow.Type): ImpersonationRecord => ({
  id: row.id,
  adminUserId: Users.UserId(row.adminUserId),
  targetUserId: Users.UserId(row.targetUserId),
  sessionId: row.sessionId,
  reason: row.reason,
  startedAt: row.startedAt,
  expiresAt: Option.fromNullishOr(row.expiresAt),
  endedAt: Option.fromNullishOr(row.endedAt),
  endedBy: Option.fromNullishOr(row.endedBy),
});

export const layerSql = Layer.effect(
  ImpersonationRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        adminUserId: Schema.String,
        targetUserId: Schema.String,
        sessionId: Schema.String,
        reason: Schema.String,
        startedAt: Schema.DateTimeUtcFromString,
        expiresAt: Schema.DateTimeUtcFromString,
      }),
      Result: ImpersonationRow,
      execute: (r) => sql`
          INSERT INTO admin_impersonation
            (id, adminUserId, targetUserId, sessionId, reason, startedAt, expiresAt, endedAt, endedBy)
          VALUES
            (${r.id}, ${r.adminUserId}, ${r.targetUserId}, ${r.sessionId}, ${r.reason}, ${r.startedAt}, ${r.expiresAt}, NULL, NULL)
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
        endedAt: Schema.DateTimeUtcFromString,
        endedBy: EndedBySchema,
      }),
      Result: ImpersonationRow,
      execute: (r) => sql`
          UPDATE admin_impersonation SET endedAt = ${r.endedAt}, endedBy = ${r.endedBy}
          WHERE sessionId = ${r.sessionId} AND endedAt IS NULL
          RETURNING *
        `,
    });

    // IDS-004: one statement, so a racing reader can never close (and announce) the same row twice.
    const closeExpiredQuery = SqlSchema.findAll({
      Request: Schema.DateTimeUtcFromString,
      Result: ImpersonationRow,
      execute: (now) => sql`
          UPDATE admin_impersonation SET endedAt = expiresAt, endedBy = 'expired'
          WHERE endedAt IS NULL AND expiresAt IS NOT NULL AND expiresAt <= ${now}
          RETURNING *
        `,
    });

    // ESS-006: `(startedAt, id) < cursor`, spelled out for both dialects, `limit + 1` rows.
    const listQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        active: Schema.Boolean,
        cursorStartedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
        cursorId: Schema.NullOr(Schema.String),
        limit: Schema.Int,
      }),
      Result: ImpersonationRow,
      execute: (r) => {
        const conditions = [
          ...(r.active ? [sql`endedAt IS NULL`] : []),
          ...(r.cursorStartedAt === null || r.cursorId === null
            ? []
            : [
                sql`(startedAt < ${r.cursorStartedAt} OR (startedAt = ${r.cursorStartedAt} AND id < ${r.cursorId}))`,
              ]),
        ];
        return sql`SELECT * FROM admin_impersonation WHERE ${sql.and(conditions)} ORDER BY startedAt DESC, id DESC LIMIT ${r.limit + 1}`;
      },
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
        expiresAt: input.expiresAt,
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

    const closeExpired: ImpersonationRecordsShape["closeExpired"] = (now) =>
      closeExpiredQuery(now).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const list: ImpersonationRecordsShape["list"] = (input) => {
      const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
      return listQuery({
        active: input?.active === true,
        cursorStartedAt: input?.cursor?.startedAt ?? null,
        cursorId: input?.cursor?.id ?? null,
        limit,
      }).pipe(
        Effect.map((rows) => toPage(rows.map(toRecord), limit)),
        Effect.orDie,
      );
    };

    return { create, findBySessionId, endEpisode, closeExpired, list };
  }),
);
