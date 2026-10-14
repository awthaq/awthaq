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
//
// ALF-005: tamper-evidence. `admin_impersonation` is a read model the
// database itself protects (triggers in `Admin.ts`'s migrations reject DELETE
// and any UPDATE beyond closing an open episode), and every start/end is also
// appended to `admin_impersonation_chain`, an append-only ledger whose rows are
// hash-chained by `@awthaq/core`'s `AuditChain`. `verifyChain` re-walks the
// ledger and cross-checks the read model against it, so a rewrite that bypassed
// the triggers is reported with the exact first episode/link it touched.

import { SqlTransaction } from "@awthaq/ports";
import { AuditChain, Users } from "@awthaq/core";
import { Models as SqlModels, StoreFailure, TenantScoped } from "@awthaq/sql";
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
import * as Semaphore from "effect/Semaphore";
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
  /**
   * IDS-002 (ADR-EA-018): the ambient tenant when the episode started — `None`
   * for a single-tenant deployment. Frozen with the rest of the start facts.
   */
  readonly tenantId: Option.Option<string>;
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

/** ALF-005: the first anomaly `verifyChain` found, in ledger order. */
export interface ChainBreak {
  /** The ledger position involved; `None` for a read-model row with no ledger link at all. */
  readonly seq: Option.Option<number>;
  readonly episodeId: string;
  readonly reason:
    /** a link's hash (or its predecessor link) no longer verifies — the ledger itself was edited */
    | "chain-broken"
    /** a ledger link names an episode whose row is gone */
    | "row-missing"
    /** the episode row no longer matches what its ledger link recorded */
    | "row-mismatch"
    /** a row (or its ended state) exists that the ledger never recorded */
    | "row-unledgered";
}

/** ESS-006: applied when a caller names no `limit`, so no read is ever unbounded. */
export const DEFAULT_PAGE_SIZE = 50;

export interface ImpersonationRecordsShape {
  /**
   * BEH-EA-215: inserts one durable audit row at the moment `impersonate` issues a
   * session, stamped with the ambient `TenantContext` (IDS-002).
   *
   * IDS-002: `findBySessionId`, `endEpisode` and `list` see only the *ambient*
   * tenant's episodes (`None` sees the untenanted ones, i.e. everything in a
   * single-tenant deployment) unless the caller presents a `TenantScoped.CrossTenant`
   * witness, which `Admin` mints only for a caller that passes `canAdministerTenants` (and
   * for its own tenant-blind "is this an impersonation session" classification);
   * `closeExpired` and `verifyChain` are maintenance over every tenant and take a witness
   * too. Every method fails `StoreUnavailable` when the store is down (ADR-EA-028).
   */
  readonly create: (input: {
    readonly adminUserId: UserId;
    readonly targetUserId: UserId;
    readonly sessionId: string;
    readonly reason: string;
    /** IDS-004: the issued session's `absoluteExpiresAt`. */
    readonly expiresAt: DateTime.Utc;
  }) => Effect.Effect<ImpersonationRecord, StoreFailure.StoreUnavailable>;
  readonly findBySessionId: (
    sessionId: string,
    grant?: TenantScoped.CrossTenant,
  ) => Effect.Effect<Option.Option<ImpersonationRecord>, StoreFailure.StoreUnavailable>;
  /** Sets `endedAt`/`endedBy` exactly once — fails `ImpersonationRecordNotFound` for an unknown or already-ended session id. */
  readonly endEpisode: (
    sessionId: string,
    endedBy: EndedBy,
    grant?: TenantScoped.CrossTenant,
  ) => Effect.Effect<
    ImpersonationRecord,
    ImpersonationRecordNotFound | StoreFailure.StoreUnavailable
  >;
  /**
   * IDS-004: atomically closes every still-open episode whose `expiresAt` is at
   * or before `now`, as `endedBy: "expired"` with `endedAt` = its own
   * `expiresAt`, and returns exactly the rows this call closed — so each
   * expired episode is closed (and announced) once however many callers race.
   */
  readonly closeExpired: (
    grant: TenantScoped.CrossTenant,
    now: DateTime.Utc,
  ) => Effect.Effect<ReadonlyArray<ImpersonationRecord>, StoreFailure.StoreUnavailable>;
  /**
   * BEH-EA-219/ESS-006: history newest-first, keyset-paginated on
   * `(startedAt, id)`; `active: true` narrows to episodes with no `endedAt`
   * yet. Never loads more than `limit + 1` rows.
   */
  readonly list: (
    input?: {
      readonly active?: boolean | undefined;
      readonly cursor?: ImpersonationCursor | undefined;
      readonly limit?: number | undefined;
    },
    grant?: TenantScoped.CrossTenant,
  ) => Effect.Effect<ImpersonationPage, StoreFailure.StoreUnavailable>;
  /**
   * ALF-005: verifies the whole hash-chained ledger and that every episode row still
   * matches it. Resolves `None` when intact, else the first anomaly. Reads everything
   * — an operator/scheduled-job tool, not a request-path call.
   */
  readonly verifyChain: (
    grant: TenantScoped.CrossTenant,
  ) => Effect.Effect<Option.Option<ChainBreak>, StoreFailure.StoreUnavailable>;
}

export class ImpersonationRecords extends Context.Service<
  ImpersonationRecords,
  ImpersonationRecordsShape
>()("awthaq/admin/records/ImpersonationRecords") {}

const notFound = (sessionId: string): ImpersonationRecordNotFound =>
  new ImpersonationRecordNotFound({
    message: `awthaq: no active impersonation episode for session: ${sessionId}`,
  });

/** A store outage is the typed `StoreUnavailable`; the id minting is a `Crypto` call that can fail too. */
const mintId = <E>(minted: Effect.Effect<string, E>) =>
  Effect.catch(minted, StoreFailure.storeUnavailable("ImpersonationRecords.create"));

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

// ---- ledger (shared by both layers) -------------------------------------------

/** One `admin_impersonation_chain` row, as persisted. */
interface LedgerEntry {
  readonly seq: number;
  readonly kind: "started" | "ended";
  readonly episodeId: string;
  readonly prevHash: string;
  readonly payload: string;
  readonly rowHash: string;
}

const iso = (value: Option.Option<DateTime.Utc>): string | null =>
  Option.match(value, { onNone: () => null, onSome: DateTime.formatIso });

/** The immutable facts of an episode's start — exactly the columns the triggers freeze. */
const startedPayload = (record: ImpersonationRecord): string =>
  AuditChain.canonicalize([
    "started",
    record.id,
    record.adminUserId,
    record.targetUserId,
    record.sessionId,
    record.reason,
    DateTime.formatIso(record.startedAt),
    iso(record.expiresAt),
    // IDS-002: appended only when set, so every link written before the tenant
    // column existed (and every single-tenant one) still recomputes byte-for-byte.
    ...Option.match(record.tenantId, { onNone: () => [], onSome: (tenantId) => [tenantId] }),
  ]);

/** `None` for a row that is not (or no longer) ended — it cannot match any "ended" link. */
const endedPayload = (record: ImpersonationRecord): Option.Option<string> =>
  Option.all({ endedAt: record.endedAt, endedBy: record.endedBy }).pipe(
    Option.map(({ endedAt, endedBy }) =>
      AuditChain.canonicalize(["ended", record.id, DateTime.formatIso(endedAt), endedBy]),
    ),
  );

/** Episodes are closed in a deterministic order so their "ended" links chain reproducibly. */
const closeOrder = (
  records: ReadonlyArray<ImpersonationRecord>,
): ReadonlyArray<ImpersonationRecord> =>
  [...records].sort((a, b) => {
    const byTime =
      Option.match(a.endedAt, { onNone: () => 0, onSome: DateTime.toEpochMillis }) -
      Option.match(b.endedAt, { onNone: () => 0, onSome: DateTime.toEpochMillis });
    return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

/**
 * ALF-005: the earliest anomaly in ledger order — a read-model discrepancy on a link
 * strictly before the first broken hash is reported first, so the answer is "the first
 * tampered thing" whichever side was touched.
 */
const verifyLedger = Effect.fnUntraced(function* (
  chain: AuditChain.AuditChainShape,
  entries: ReadonlyArray<LedgerEntry>,
  rows: ReadonlyArray<ImpersonationRecord>,
) {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const brokenAt = yield* chain.verify(entries);
  const checked = Option.getOrElse(brokenAt, () => entries.length);
  for (const entry of entries.slice(0, checked)) {
    const row = byId.get(entry.episodeId);
    if (row === undefined) {
      return Option.some<ChainBreak>({
        seq: Option.some(entry.seq),
        episodeId: entry.episodeId,
        reason: "row-missing",
      });
    }
    const expected =
      entry.kind === "started" ? Option.some(startedPayload(row)) : endedPayload(row);
    if (!Option.isSome(expected) || expected.value !== entry.payload) {
      return Option.some<ChainBreak>({
        seq: Option.some(entry.seq),
        episodeId: entry.episodeId,
        reason: "row-mismatch",
      });
    }
  }
  if (Option.isSome(brokenAt)) {
    const entry = entries[brokenAt.value];
    if (entry !== undefined) {
      return Option.some<ChainBreak>({
        seq: Option.some(entry.seq),
        episodeId: entry.episodeId,
        reason: "chain-broken",
      });
    }
  }
  const startedIds = new Set(entries.filter((e) => e.kind === "started").map((e) => e.episodeId));
  const endedIds = new Set(entries.filter((e) => e.kind === "ended").map((e) => e.episodeId));
  for (const row of rows) {
    if (!startedIds.has(row.id) || (Option.isSome(row.endedAt) && !endedIds.has(row.id))) {
      return Option.some<ChainBreak>({
        seq: Option.none(),
        episodeId: row.id,
        reason: "row-unledgered",
      });
    }
  }
  return Option.none<ChainBreak>();
});

// ---- layerMemory ------------------------------------------------------------

type RecordsState = HashMap.HashMap<string, ImpersonationRecord>;

export const layerMemory = Layer.effect(
  ImpersonationRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<RecordsState>(HashMap.empty());
    const ledger = yield* Ref.make<ReadonlyArray<LedgerEntry>>([]);
    const appendLock = yield* Semaphore.make(1);
    const crypto = yield* Crypto.Crypto;
    const chain = yield* AuditChain.AuditChain;

    /** Reads the tail and appends as one step, so two writers cannot chain off the same predecessor. */
    const append = (kind: LedgerEntry["kind"], episodeId: string, payload: string) =>
      appendLock.withPermit(
        Effect.gen(function* () {
          const entries = yield* Ref.get(ledger);
          const prevHash = entries.at(-1)?.rowHash ?? AuditChain.GENESIS_HASH;
          const rowHash = yield* chain.link(prevHash, payload);
          yield* Ref.set(ledger, [
            ...entries,
            { seq: entries.length + 1, kind, episodeId, prevHash, payload, rowHash },
          ]);
        }),
      );

    const create: ImpersonationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* mintId(crypto.randomUUIDv7);
      const now = yield* DateTime.now;
      const tenantId = Option.fromNullishOr(
        (yield* TenantScoped.stamp({ tenantId: null })).tenantId,
      );
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
        tenantId,
      };
      yield* Ref.update(state, (s) => HashMap.set(s, id, record));
      yield* append("started", record.id, startedPayload(record));
      return record;
    });

    const findBySessionId: ImpersonationRecordsShape["findBySessionId"] = (sessionId, grant) =>
      Effect.gen(function* () {
        const seen = yield* TenantScoped.visibility(grant);
        const s = yield* Ref.get(state);
        return Option.fromNullishOr(
          Array.from(HashMap.values(s)).find(
            (row) =>
              row.sessionId === sessionId &&
              TenantScoped.matches(Option.getOrNull(row.tenantId), seen),
          ),
        );
      });

    const endEpisode: ImpersonationRecordsShape["endEpisode"] = (sessionId, endedBy, grant) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const seen = yield* TenantScoped.visibility(grant);
        const outcome = yield* Ref.modify(
          state,
          (
            s,
          ): readonly [
            Result.Result<ImpersonationRecord, ImpersonationRecordNotFound>,
            RecordsState,
          ] => {
            const existing = Array.from(HashMap.values(s)).find(
              (row) =>
                row.sessionId === sessionId &&
                TenantScoped.matches(Option.getOrNull(row.tenantId), seen),
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
        const ended = yield* Effect.fromResult(outcome);
        yield* Option.match(endedPayload(ended), {
          onNone: () => Effect.void,
          onSome: (payload) => append("ended", ended.id, payload),
        });
        return ended;
      });

    const closeExpired: ImpersonationRecordsShape["closeExpired"] = (_grant, now) =>
      Effect.gen(function* () {
        const closed = closeOrder(yield* closeExpiredInState(now));
        for (const episode of closed) {
          yield* Option.match(endedPayload(episode), {
            onNone: () => Effect.void,
            onSome: (payload) => append("ended", episode.id, payload),
          });
        }
        return closed;
      });

    const closeExpiredInState = (now: DateTime.Utc) =>
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

    const list: ImpersonationRecordsShape["list"] = (input, grant) =>
      Effect.gen(function* () {
        const seen = yield* TenantScoped.visibility(grant);
        const s = yield* Ref.get(state);
        const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
        const cursor = input?.cursor;
        const rows = newestFirst(Array.from(HashMap.values(s))).filter(
          (row) =>
            TenantScoped.matches(Option.getOrNull(row.tenantId), seen) &&
            (input?.active !== true || Option.isNone(row.endedAt)) &&
            (cursor === undefined || isBeforeCursor(row, cursor)),
        );
        return toPage(rows.slice(0, limit + 1), limit);
      });

    const verifyChain: ImpersonationRecordsShape["verifyChain"] = (_grant) =>
      Effect.gen(function* () {
        const entries = yield* Ref.get(ledger);
        const rows = Array.from(HashMap.values(yield* Ref.get(state)));
        return yield* verifyLedger(chain, entries, rows);
      });

    return { create, findBySessionId, endEpisode, closeExpired, list, verifyChain };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const EndedBySchema = Schema.Literals(["self", "forcedByAdmin", "expired"]);

const makeImpersonationRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    adminUserId: Schema.String,
    targetUserId: Schema.String,
    sessionId: Schema.String,
    reason: Schema.String,
    startedAt: wire.dateTime,
    expiresAt: wire.nullableDateTime,
    endedAt: wire.nullableDateTime,
    endedBy: Schema.NullOr(EndedBySchema),
    tenantId: Schema.NullOr(Schema.String),
  });

type ImpersonationRow = ReturnType<typeof makeImpersonationRow>["Type"];

const toRecord = (row: ImpersonationRow): ImpersonationRecord => ({
  id: row.id,
  adminUserId: Users.UserId(row.adminUserId),
  targetUserId: Users.UserId(row.targetUserId),
  sessionId: row.sessionId,
  reason: row.reason,
  startedAt: row.startedAt,
  expiresAt: Option.fromNullishOr(row.expiresAt),
  endedAt: Option.fromNullishOr(row.endedAt),
  endedBy: Option.fromNullishOr(row.endedBy),
  tenantId: Option.fromNullishOr(row.tenantId),
});

/** What a statement may see, carried through a `SqlSchema` request so the predicate is built in the query. */
const VisibilitySchema = Schema.declare(
  (u): u is TenantScoped.Visibility =>
    typeof u === "object" &&
    u !== null &&
    "_tag" in u &&
    (u._tag === "Tenant" || u._tag === "Everywhere"),
);

const LedgerRow = Schema.Struct({
  seq: Schema.Int,
  kind: Schema.Literals(["started", "ended"]),
  episodeId: Schema.String,
  prevHash: Schema.String,
  payload: Schema.String,
  rowHash: Schema.String,
});

/** ALF-005: a constant key for `pg_advisory_xact_lock`, serialising writers of this one ledger. */
const CHAIN_LOCK_KEY = 7_313_370_001;

export const layerSql = Layer.effect(
  ImpersonationRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const ImpersonationRow = makeImpersonationRow(wire);
    const crypto = yield* Crypto.Crypto;
    const chain = yield* AuditChain.AuditChain;
    /** Lifts RLS for the one statement when (and only when) the caller presents a witness. */
    const liftFor =
      (grant: TenantScoped.CrossTenant | undefined) =>
      <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        Effect.provideService(
          grant === undefined ? effect : TenantScoped.lift(grant)(effect),
          SqlClient.SqlClient,
          sql,
        );
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`ImpersonationRecords.${operation}`);

    const ledgerTail = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Schema.Struct({ rowHash: Schema.String }),
      execute: () => sql`SELECT "rowHash" FROM admin_impersonation_chain ORDER BY seq DESC LIMIT 1`,
    });

    const ledgerInsert = SqlSchema.void({
      Request: Schema.Struct({
        kind: Schema.String,
        episodeId: Schema.String,
        prevHash: Schema.String,
        payload: Schema.String,
        rowHash: Schema.String,
      }),
      execute: (r) => sql`
        INSERT INTO admin_impersonation_chain (kind, "episodeId", "prevHash", payload, "rowHash")
        VALUES (${r.kind}, ${r.episodeId}, ${r.prevHash}, ${r.payload}, ${r.rowHash})
      `,
    });

    const ledgerAll = SqlSchema.findAll({
      Request: Schema.Void,
      Result: LedgerRow,
      execute: () =>
        sql`SELECT seq, kind, "episodeId", "prevHash", payload, "rowHash" FROM admin_impersonation_chain ORDER BY seq ASC`,
    });

    const rowsAll = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ImpersonationRow,
      execute: () => sql`SELECT * FROM admin_impersonation`,
    });

    /** Chain writers are serialised (Postgres: a transaction-scoped advisory lock; SQLite is single-writer). */
    const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      SqlTransaction.transactional(sql)(
        Effect.andThen(
          sql.onDialectOrElse({
            pg: () => Effect.asVoid(sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`),
            orElse: () => Effect.void,
          }),
          effect,
        ),
      );

    const append = Effect.fnUntraced(function* (
      kind: LedgerEntry["kind"],
      episodeId: string,
      payload: string,
    ) {
      const tail = yield* ledgerTail(undefined);
      const prevHash = Option.match(tail, {
        onNone: () => AuditChain.GENESIS_HASH,
        onSome: (last) => last.rowHash,
      });
      const rowHash = yield* chain.link(prevHash, payload);
      yield* ledgerInsert({ kind, episodeId, prevHash, payload, rowHash });
    });

    const appendEnded = (record: ImpersonationRecord) =>
      Option.match(endedPayload(record), {
        onNone: () => Effect.void,
        onSome: (payload) => append("ended", record.id, payload),
      });

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        adminUserId: Schema.String,
        targetUserId: Schema.String,
        sessionId: Schema.String,
        reason: Schema.String,
        startedAt: wire.dateTime,
        expiresAt: wire.dateTime,
        tenantId: Schema.NullOr(Schema.String),
      }),
      Result: ImpersonationRow,
      execute: (r) => sql`
          INSERT INTO admin_impersonation
            (id, "adminUserId", "targetUserId", "sessionId", reason, "startedAt", "expiresAt", "endedAt", "endedBy", "tenantId")
          VALUES
            (${r.id}, ${r.adminUserId}, ${r.targetUserId}, ${r.sessionId}, ${r.reason}, ${r.startedAt}, ${r.expiresAt}, NULL, NULL, ${r.tenantId})
          RETURNING *
        `,
    });

    const findBySessionIdQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: Schema.String,
        seen: VisibilitySchema,
      }),
      Result: ImpersonationRow,
      execute: (r) =>
        sql`SELECT * FROM admin_impersonation WHERE "sessionId" = ${r.sessionId} AND ${TenantScoped.predicate(sql, "tenantId", r.seen)}`,
    });

    const endEpisodeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: Schema.String,
        endedAt: wire.dateTime,
        endedBy: EndedBySchema,
        seen: VisibilitySchema,
      }),
      Result: ImpersonationRow,
      execute: (r) => sql`
          UPDATE admin_impersonation SET "endedAt" = ${r.endedAt}, "endedBy" = ${r.endedBy}
          WHERE "sessionId" = ${r.sessionId} AND "endedAt" IS NULL
            AND ${TenantScoped.predicate(sql, "tenantId", r.seen)}
          RETURNING *
        `,
    });

    // IDS-004: one statement, so a racing reader can never close (and announce) the same row twice.
    const closeExpiredQuery = SqlSchema.findAll({
      Request: wire.dateTime,
      Result: ImpersonationRow,
      execute: (now) => sql`
          UPDATE admin_impersonation SET "endedAt" = "expiresAt", "endedBy" = 'expired'
          WHERE "endedAt" IS NULL AND "expiresAt" IS NOT NULL AND "expiresAt" <= ${now}
          RETURNING *
        `,
    });

    // ESS-006: `(startedAt, id) < cursor`, spelled out for both dialects, `limit + 1` rows.
    const listQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        active: Schema.Boolean,
        cursorStartedAt: wire.nullableDateTime,
        cursorId: Schema.NullOr(Schema.String),
        limit: Schema.Int,
        seen: VisibilitySchema,
      }),
      Result: ImpersonationRow,
      execute: (r) => {
        const conditions = [
          TenantScoped.predicate(sql, "tenantId", r.seen),
          ...(r.active ? [sql`"endedAt" IS NULL`] : []),
          ...(r.cursorStartedAt === null || r.cursorId === null
            ? []
            : [
                sql`("startedAt" < ${r.cursorStartedAt} OR ("startedAt" = ${r.cursorStartedAt} AND id < ${r.cursorId}))`,
              ]),
        ];
        return sql`SELECT * FROM admin_impersonation WHERE ${sql.and(conditions)} ORDER BY "startedAt" DESC, id DESC LIMIT ${r.limit + 1}`;
      },
    });

    const create: ImpersonationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* mintId(crypto.randomUUIDv7);
      const now = yield* DateTime.now;
      const { tenantId } = yield* TenantScoped.stamp({ tenantId: null });
      return yield* inTransaction(
        Effect.gen(function* () {
          const row = yield* insert({
            id,
            adminUserId: input.adminUserId,
            targetUserId: input.targetUserId,
            sessionId: input.sessionId,
            reason: input.reason,
            startedAt: now,
            expiresAt: input.expiresAt,
            tenantId,
          });
          const record = toRecord(row);
          yield* append("started", record.id, startedPayload(record));
          return record;
        }),
      ).pipe(Effect.catchTag("NoSuchElementError", Effect.die), unavailable("create"));
    });

    const findBySessionId: ImpersonationRecordsShape["findBySessionId"] = (sessionId, grant) =>
      TenantScoped.visibility(grant).pipe(
        Effect.flatMap((seen) => findBySessionIdQuery({ sessionId, seen })),
        Effect.map(Option.map(toRecord)),
        liftFor(grant),
        unavailable("findBySessionId"),
      );

    const endEpisode: ImpersonationRecordsShape["endEpisode"] = (sessionId, endedBy, grant) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const seen = yield* TenantScoped.visibility(grant);
        const updated = yield* inTransaction(
          Effect.gen(function* () {
            const row = yield* endEpisodeQuery({
              sessionId,
              endedAt: now,
              endedBy,
              seen,
            });
            const record = Option.map(row, toRecord);
            if (Option.isSome(record)) yield* appendEnded(record.value);
            return record;
          }),
        ).pipe(liftFor(grant), unavailable("endEpisode"));
        if (Option.isNone(updated)) return yield* Effect.fail(notFound(sessionId));
        return updated.value;
      });

    const closeExpired: ImpersonationRecordsShape["closeExpired"] = (grant, now) =>
      inTransaction(
        Effect.gen(function* () {
          const closed = closeOrder((yield* closeExpiredQuery(now)).map(toRecord));
          for (const record of closed) yield* appendEnded(record);
          return closed;
        }),
      ).pipe(liftFor(grant), unavailable("closeExpired"));

    const list: ImpersonationRecordsShape["list"] = (input, grant) => {
      const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
      return TenantScoped.visibility(grant).pipe(
        Effect.flatMap((seen) =>
          listQuery({
            active: input?.active === true,
            cursorStartedAt: input?.cursor?.startedAt ?? null,
            cursorId: input?.cursor?.id ?? null,
            limit,
            seen,
          }),
        ),
        Effect.map((rows) => toPage(rows.map(toRecord), limit)),
        liftFor(grant),
        unavailable("list"),
      );
    };

    const verifyChain: ImpersonationRecordsShape["verifyChain"] = (grant) =>
      Effect.gen(function* () {
        const entries = yield* ledgerAll(undefined);
        const rows = (yield* rowsAll(undefined)).map(toRecord);
        return yield* verifyLedger(chain, entries, rows);
      }).pipe(liftFor(grant), unavailable("verifyChain"));

    return { create, findBySessionId, endEpisode, closeExpired, list, verifyChain };
  }),
);
