// @awthaq/sql — Repositories
//
// spec/behaviors/05-persistence-stratum.md, BEH-EA-035/036.
//
// Each repository is a `Context.Service` built with `SqlModel.makeRepository`
// over the ambient `SqlClient` (BEH-EA-035) — none opens its own
// transaction; the calling domain service (in `@awthaq/core`'s
// eventual SQL-backed `Layer`) holds that boundary, the same way
// `Verification.consume` and its caller's own state change are meant to
// commit together (BEH-EA-058). Every paginated query takes an opaque
// `(createdAt, id)` cursor, never an offset (BEH-EA-036).

import { Encryption, Sealed, Tenant } from "@awthaq/ports";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlModel from "effect/unstable/sql/SqlModel";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as CoreSealedColumns from "./CoreSealedColumns.ts";
import { sealCell, sealedCell, type ColumnCodec } from "./internal/Cells.ts";
import { traced } from "./internal/traced.ts";
import * as ReadRouting from "./ReadRouting.ts";
import * as SealedColumn from "./SealedColumn.ts";
import { SessionId, UserId, makeModels, resolveDialect } from "./Models.ts";
import type { Session, SessionInsert, SqlModels } from "./Models.ts";

/** BEH-EA-036: the one cursor shape every paginated repository query accepts. */
export interface Cursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

/** A page of rows plus the cursor to pass back in to fetch the next one, if any. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: Option.Option<Cursor>;
}

type RepositoryError = Schema.SchemaError | SqlError;

// ---- Sessions -----------------------------------------------------------

export interface SessionsRepositoryShape {
  /** TS-001: the dialect-resolved models this repository decodes with. */
  readonly models: SqlModels;
  /** CSG-006: the stored `ipAddress`/`userAgent` cells of a row this repository returned, as `Sealed`s (never opened here). */
  readonly piiOf: (row: Session) => {
    readonly ipAddress: Option.Option<Sealed.Sealed<string>>;
    readonly userAgent: Option.Option<Sealed.Sealed<string>>;
  };
  readonly insert: (input: SessionInsert) => Effect.Effect<Session, RepositoryError>;
  readonly findById: (
    id: SessionId,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /**
   * BEH-EA-036: `cursor` is opaque and derived from `(createdAt, id)`.
   * SMS-002/BEH-EA-054: lists only *live* rows — not tombstoned and past
   * neither `absoluteExpiresAt` nor `idleExpiresAt` at `now`. ESR-010:
   * `limit` is clamped to `[1, MAX_PAGE_SIZE]`.
   *
   * RRC-001: reads the primary unless `options.consistency` is `"eventual"`,
   * which a display-only caller (a device list) passes to allow a configured
   * read replica. Never pass it for a liveness or authorization decision.
   */
  readonly listByUser: (
    userId: UserId,
    now: DateTime.Utc,
    cursor?: Cursor,
    limit?: number,
    options?: ReadRouting.ReadOptions,
  ) => Effect.Effect<Page<Session>, RepositoryError>;
  /**
   * Upstream-hardening map, ticket 01: the throttled touch/rotation
   * write's own compare-and-swap — `expectedSecretHash` must still match
   * the row's *current* `secretHash` for the update to apply. Two
   * concurrent requests racing the same throttled window would otherwise
   * both blindly overwrite `secretHash` via a plain `update`, leaving
   * whichever response lost the race holding a token that no longer
   * verifies. `None` means another request already won that race — not a
   * failure — so the caller reports no rotation of its own rather than
   * clobbering the winner's write. Plan 02: a tombstoned row is never rotated
   * (`"supersededAt" IS NULL`): it is the evidence of reuse.
   */
  readonly touch: (input: {
    readonly id: SessionId;
    readonly expectedSecretHash: string;
    readonly secretHash: string;
    /** RRS-005: the replaced hash, kept until `previousSecretExpiresAt`; absent/`null` clears any earlier grace. */
    readonly previousSecretHash?: string | null | undefined;
    readonly previousSecretExpiresAt?: DateTime.Utc | null | undefined;
    readonly lastActiveAt: DateTime.Utc;
    readonly idleExpiresAt: DateTime.Utc;
  }) => Effect.Effect<Option.Option<Session>, RepositoryError>;
  readonly delete: (id: SessionId) => Effect.Effect<void, RepositoryError>;
  /** BEH-EA-054: bulk-revokes every session for `userId` except `keep`. Resolves to how many went. */
  readonly deleteAllForUserExcept: (
    userId: UserId,
    keep: SessionId,
  ) => Effect.Effect<number, RepositoryError>;
  /**
   * Upstream-hardening map, ticket 02: bulk-revokes every session for
   * `userId`, no exceptions — `revokeAll`'s own primitive, distinct from
   * `deleteAllForUserExcept`'s "all but one" shape. Resolves to how many went.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<number, RepositoryError>;
  /**
   * SMS-003: the user's live (not tombstoned, past neither expiry at `now`),
   * non-impersonation sessions' ids and last activity — what a concurrent-
   * session cap counts and evicts from. Impersonation (`actingAs`) rows are
   * excluded: an admin's support session never counts against the target.
   */
  readonly listLiveIds: (
    userId: UserId,
    now: DateTime.Utc,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: SessionId; readonly lastActiveAt: DateTime.Utc }>,
    RepositoryError
  >;
  /**
   * TIR-008/GC-005: deletes session `id` in ONE statement (`DELETE ... RETURNING`) and answers
   * the user it belonged to, so exactly one of two concurrent revokes sees the row and
   * publishes the event. When `owner` is given the row is deleted only if it belongs to that
   * user: ownership is enforced by the statement, not by a preceding lookup. `None` for an
   * unknown id and a foreign id alike, so a caller cannot tell them apart.
   */
  readonly deleteReturning: (
    id: SessionId,
    owner?: UserId,
  ) => Effect.Effect<Option.Option<UserId>, RepositoryError>;
  /**
   * RRS-003: tombstones the superseded row in a rotation — sets
   * `supersededBy`/`supersededAt`, never deletes it. Returns the
   * now-tombstoned row (its own `familyId` is what the new row inherits).
   * ESR-002: applies only to a still-live row (`supersededAt IS NULL`), so two
   * concurrent supersedes of one row cannot both tombstone it and fork its
   * family — the loser gets `NoSuchElementError`. INV-EA-018: and only a row
   * owned by `userId`; an id alone never acts on another user's session, so a
   * foreign row is `NoSuchElementError` too.
   */
  readonly tombstone: (input: {
    readonly id: SessionId;
    readonly userId: UserId;
    readonly supersededBy: SessionId;
    readonly supersededAt: DateTime.Utc;
  }) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /**
   * RRS-003: marks a tombstoned row's own `reusedAt`, ONCE: the statement applies only to a
   * tombstoned row whose `reusedAt` is still NULL, so of any number of concurrent presentations
   * exactly one gets `Some` (the row's family and owner) and publishes the reuse.
   */
  readonly markReusedOnce: (
    id: SessionId,
    reusedAt: DateTime.Utc,
  ) => Effect.Effect<
    Option.Option<{ readonly familyId: SessionId; readonly userId: UserId }>,
    RepositoryError
  >;
  /** RRS-003: bulk hard-deletes every still-live (non-tombstoned) row sharing `familyId` — a confirmed-compromised family has no further lineage worth preserving. */
  readonly revokeFamily: (familyId: SessionId) => Effect.Effect<void, SqlError>;
  /**
   * CSG-003: retention. Deletes up to `limit` rows whose absolute or idle expiry
   * is before `cutoff` — tombstoned rows included (they keep their original
   * expiry) — and resolves to how many went. One bounded statement, so a sweep
   * over a large backlog is a loop of short transactions, not one long lock.
   */
  readonly deleteExpiredBefore: (
    cutoff: DateTime.Utc,
    limit: number,
  ) => Effect.Effect<number, RepositoryError>;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001/BPAS-001): the one column `Sessions.reauthenticate` writes —
   * a targeted `UPDATE`, mirroring `tombstone`'s own shape, not the
   * generic `update` (which would also require supplying every other
   * `update`-variant field this call has no business touching).
   */
  readonly reauthenticate: (
    id: SessionId,
    /** BEH-EA-319: the row must belong to this user. */
    userId: UserId,
    /** The new `authenticatedAt`, and the instant liveness is judged at: a tombstoned or expired row is `NoSuchElementError`. */
    now: DateTime.Utc,
    /** THS-003: the already-unioned `amr` JSON to store; `undefined` leaves it untouched. */
    amr?: string,
    /** THS-003: with `amr`, the stored JSON the union was computed from: the write applies only if it is still that (compare-and-swap), so concurrent step-ups cannot lose a method. */
    expectedAmr?: string,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
}

export class SessionsRepository extends Context.Service<
  SessionsRepository,
  SessionsRepositoryShape
>()("awthaq/sql/SessionsRepository") {}

const DEFAULT_PAGE_SIZE = 50;

/**
 * ESR-010: the hard upper bound on any one session page. `listByUser` clamps
 * to it, and the request schema below enforces it as defense in depth, so no
 * caller-supplied limit can yield a `SqlError` (0, negative) or an unbounded
 * page.
 */
export const MAX_PAGE_SIZE = 200;

interface SessionPiiCodecs {
  readonly ipAddress: ColumnCodec;
  readonly userAgent: ColumnCodec;
}

const makeSessionsRepository = (pii: Option.Option<SessionPiiCodecs>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = makeModels(yield* resolveDialect(sql));
    const repo = yield* SqlModel.makeRepository(models.Session, {
      tableName: "sessions",
      spanPrefix: "Sessions",
      idColumn: "id",
    });

    // CSG-006: `ipAddress`/`userAgent` are the personal-data columns. With the default repository
    // these are no-ops; the encrypted variant seals them at insert (they are immutable afterwards)
    // and hands the stored cells out as `Sealed`s, from `SqlModel` or from a hand-written query alike.
    const concealPii = (
      id: string,
      columns: { readonly ipAddress: string | null; readonly userAgent: string | null },
    ) =>
      Effect.all({
        ipAddress: sealCell(
          Option.map(pii, (codecs) => codecs.ipAddress),
          id,
          columns.ipAddress,
        ),
        userAgent: sealCell(
          Option.map(pii, (codecs) => codecs.userAgent),
          id,
          columns.userAgent,
        ),
      });

    const piiOf: SessionsRepositoryShape["piiOf"] = (row) => ({
      ipAddress: sealedCell(
        Option.map(pii, (codecs) => codecs.ipAddress),
        row.id,
        row.ipAddress,
      ),
      userAgent: sealedCell(
        Option.map(pii, (codecs) => codecs.userAgent),
        row.id,
        row.userAgent,
      ),
    });

    const insert: SessionsRepositoryShape["insert"] = (input) =>
      concealPii(input.id, input).pipe(
        Effect.flatMap((columns) =>
          Effect.flatMap(Tenant.stamp(input), (stamped) =>
            repo.insert({
              ...stamped,
              ipAddress: columns.ipAddress,
              userAgent: columns.userAgent,
            }),
          ),
        ),
      );

    const findById: SessionsRepositoryShape["findById"] = (id) => repo.findById(id);

    // RRS-003: `"supersededAt" IS NULL` — load-bearing, not cosmetic. A
    // tombstoned row must never appear in a user's device list, and this
    // is also what makes `Sessions.verifyLive`/`Jwt.introspectLive`
    // correctly reject a reused/family-revoked session's JWT for free —
    // both call this same `list`.
    //
    // RRC-001: the one replica-eligible session read. Built once per client
    // (primary, and the replica when `ReadRouting.replica` is provided); the
    // default `consistency` is `"authoritative"`, i.e. the primary.
    const router = yield* ReadRouting.makeRouter;
    const pageOn = router.route((client) =>
      SqlSchema.findAll({
        Request: Schema.Struct({
          userId: UserId,
          /** SMS-002: the caller's clock (so `TestClock` controls it) — rows past either expiry are not listed. */
          now: models.wire.dateTime,
          cursorCreatedAt: models.wire.nullableDateTime,
          cursorId: Schema.NullOr(Schema.String),
          limit: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
          ),
        }),
        Result: models.Session,
        // SMS-002: the two expiry predicates make the list exactly the rows
        // `verify` would still accept (modulo the secret). PPS-002: the cursor
        // is a row-value comparison over `(createdAt, id)` so the partial
        // composite index `sessions_user_created_live` (migration 19) serves
        // both the filter and the order with no sort node.
        execute: (request) =>
          request.cursorCreatedAt === null || request.cursorId === null
            ? client`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  AND "absoluteExpiresAt" > ${request.now}
                  AND "idleExpiresAt" > ${request.now}
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
            : client`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  AND "absoluteExpiresAt" > ${request.now}
                  AND "idleExpiresAt" > ${request.now}
                  AND ("createdAt", id) > (${request.cursorCreatedAt}, ${request.cursorId})
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`,
      }),
    );

    const listByUser: SessionsRepositoryShape["listByUser"] = (
      userId,
      now,
      cursor,
      limit,
      options,
    ) => {
      const effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      return pageOn(options?.consistency ?? "authoritative").pipe(
        Effect.flatMap((page) =>
          page({
            userId,
            now,
            cursorCreatedAt: cursor?.createdAt ?? null,
            cursorId: cursor?.id ?? null,
            limit: effectiveLimit,
          }),
        ),
        Effect.map((items): Page<Session> => {
          const last = items.at(-1);
          const nextCursor =
            items.length === effectiveLimit && last !== undefined
              ? Option.some({ createdAt: last.createdAt, id: last.id })
              : Option.none();
          return { items, nextCursor };
        }),
        traced("Sessions.listByUser", { userId }),
      );
    };

    const touchQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: SessionId,
        expectedSecretHash: Schema.String,
        secretHash: Schema.String,
        previousSecretHash: Schema.NullOr(Schema.String),
        previousSecretExpiresAt: models.wire.nullableDateTime,
        lastActiveAt: models.wire.dateTime,
        idleExpiresAt: models.wire.dateTime,
      }),
      Result: models.Session,
      // Quoted column names: this table's Postgres DDL (`CoreMigrations.ts`)
      // declares `"secretHash"`/`"lastActiveAt"`/`"idleExpiresAt"` with
      // preserved mixed case, which only an equally-quoted reference
      // matches (Postgres folds an unquoted identifier to lowercase).
      // SQLite's own identifier resolution is case-insensitive regardless
      // of quoting, so the same quoted form is safe on both dialects.
      execute: (request) => sql`
          UPDATE sessions
          SET "secretHash" = ${request.secretHash},
              "previousSecretHash" = ${request.previousSecretHash},
              "previousSecretExpiresAt" = ${request.previousSecretExpiresAt},
              "lastActiveAt" = ${request.lastActiveAt},
              "idleExpiresAt" = ${request.idleExpiresAt}
          WHERE "id" = ${request.id}
            AND "secretHash" = ${request.expectedSecretHash}
            AND "supersededAt" IS NULL
          RETURNING *
        `,
    });

    const touch: SessionsRepositoryShape["touch"] = (input) =>
      touchQuery({
        ...input,
        previousSecretHash: input.previousSecretHash ?? null,
        previousSecretExpiresAt: input.previousSecretExpiresAt ?? null,
      }).pipe(traced("Sessions.touch", { id: input.id }));

    const deleteAllForUserExceptQuery = SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, keep: SessionId }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) =>
        sql`DELETE FROM sessions WHERE "userId" = ${r.userId} AND id != ${r.keep} RETURNING id`,
    });
    const deleteAllForUserExcept: SessionsRepositoryShape["deleteAllForUserExcept"] = (
      userId,
      keep,
    ) =>
      deleteAllForUserExceptQuery({ userId, keep }).pipe(
        Effect.map((rows) => rows.length),
        traced("Sessions.deleteAllForUserExcept", { userId }),
      );

    // Quoted `"userId"`: this table's Postgres DDL (`CoreMigrations.ts`)
    // declares the column with preserved mixed case, which only an
    // equally-quoted reference matches there (Postgres folds an
    // unquoted identifier to lowercase); SQLite's own identifier
    // resolution is case-insensitive regardless of quoting, so the same
    // quoted form is correct on both dialects.
    const deleteAllByUserQuery = SqlSchema.findAll({
      Request: UserId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (userId) => sql`DELETE FROM sessions WHERE "userId" = ${userId} RETURNING id`,
    });
    const deleteAllByUser: SessionsRepositoryShape["deleteAllByUser"] = (userId) =>
      deleteAllByUserQuery(userId).pipe(
        Effect.map((rows) => rows.length),
        traced("Sessions.deleteAllByUser", { userId }),
      );

    const deleteExpiredQuery = SqlSchema.findAll({
      Request: Schema.Struct({ cutoff: models.wire.dateTime, limit: Schema.Number }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) => sql`
          DELETE FROM sessions
          WHERE id IN (
            SELECT id FROM sessions
            WHERE "absoluteExpiresAt" < ${r.cutoff} OR "idleExpiresAt" < ${r.cutoff}
            LIMIT ${r.limit}
          )
          RETURNING id
        `,
    });

    const deleteExpiredBefore: SessionsRepositoryShape["deleteExpiredBefore"] = (cutoff, limit) =>
      deleteExpiredQuery({ cutoff, limit }).pipe(
        Effect.map((rows) => rows.length),
        traced("Sessions.deleteExpiredBefore"),
      );

    const liveIdsQuery = SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, now: models.wire.dateTime }),
      Result: Schema.Struct({ id: SessionId, lastActiveAt: models.wire.dateTime }),
      execute: (request) => sql`
          SELECT id, "lastActiveAt" FROM sessions
          WHERE "userId" = ${request.userId}
            AND "supersededAt" IS NULL
            AND "actingAsId" IS NULL
            AND "absoluteExpiresAt" > ${request.now}
            AND "idleExpiresAt" > ${request.now}
          ORDER BY "lastActiveAt" ASC, id ASC
        `,
    });

    const listLiveIds: SessionsRepositoryShape["listLiveIds"] = (userId, now) =>
      liveIdsQuery({ userId, now }).pipe(traced("Sessions.listLiveIds", { userId }));

    const deleteReturningQuery = SqlSchema.findAll({
      Request: Schema.Struct({ id: SessionId, owner: Schema.NullOr(UserId) }),
      Result: Schema.Struct({ userId: UserId }),
      execute: (request) =>
        request.owner === null
          ? sql`DELETE FROM sessions WHERE id = ${request.id} RETURNING "userId"`
          : sql`DELETE FROM sessions WHERE id = ${request.id} AND "userId" = ${request.owner} RETURNING "userId"`,
    });

    const deleteReturning: SessionsRepositoryShape["deleteReturning"] = (id, owner) =>
      deleteReturningQuery({ id, owner: owner ?? null }).pipe(
        Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.userId)),
        traced("Sessions.deleteReturning", { id }),
      );

    const tombstoneQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: SessionId,
        userId: UserId,
        supersededBy: SessionId,
        supersededAt: models.wire.dateTime,
      }),
      Result: models.Session,
      execute: (request) => sql`
          UPDATE sessions
          SET "supersededBy" = ${request.supersededBy}, "supersededAt" = ${request.supersededAt}
          WHERE "id" = ${request.id} AND "userId" = ${request.userId} AND "supersededAt" IS NULL
          RETURNING *
        `,
    });

    const tombstone: SessionsRepositoryShape["tombstone"] = (input) =>
      tombstoneQuery(input).pipe(traced("Sessions.tombstone", { id: input.id }));

    // SEA-005: like every other timestamp write here, `reusedAt` goes
    // through a `Request` schema, so the dialect's own wire codec is the
    // one and only encoder (interpolating a raw `DateTime.Utc` would bind
    // its internal fields instead of a timestamp).
    const markReusedQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: SessionId, reusedAt: models.wire.dateTime }),
      Result: Schema.Struct({ familyId: SessionId, userId: UserId }),
      execute: (request) =>
        sql`UPDATE sessions SET "reusedAt" = ${request.reusedAt}
            WHERE "id" = ${request.id} AND "supersededAt" IS NOT NULL AND "reusedAt" IS NULL
            RETURNING "familyId", "userId"`,
    });

    const markReusedOnce: SessionsRepositoryShape["markReusedOnce"] = (id, reusedAt) =>
      markReusedQuery({ id, reusedAt }).pipe(traced("Sessions.markReusedOnce", { id }));

    const revokeFamily: SessionsRepositoryShape["revokeFamily"] = (familyId) =>
      sql`DELETE FROM sessions WHERE "familyId" = ${familyId} AND "supersededAt" IS NULL`.pipe(
        Effect.asVoid,
        traced("Sessions.revokeFamily", { familyId }),
      );

    const reauthenticateQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: SessionId,
        userId: UserId,
        now: models.wire.dateTime,
        amr: Schema.NullOr(Schema.String),
        expectedAmr: Schema.NullOr(Schema.String),
      }),
      Result: models.Session,
      execute: (request) =>
        request.expectedAmr === null
          ? sql`
          UPDATE sessions
          SET "authenticatedAt" = ${request.now},
              "amr" = COALESCE(${request.amr}, "amr")
          WHERE "id" = ${request.id}
            AND "userId" = ${request.userId}
            AND "supersededAt" IS NULL
            AND "absoluteExpiresAt" > ${request.now}
            AND "idleExpiresAt" > ${request.now}
          RETURNING *
        `
          : sql`
          UPDATE sessions
          SET "authenticatedAt" = ${request.now},
              "amr" = COALESCE(${request.amr}, "amr")
          WHERE "id" = ${request.id}
            AND "userId" = ${request.userId}
            AND "amr" = ${request.expectedAmr}
            AND "supersededAt" IS NULL
            AND "absoluteExpiresAt" > ${request.now}
            AND "idleExpiresAt" > ${request.now}
          RETURNING *
        `,
    });

    const reauthenticate: SessionsRepositoryShape["reauthenticate"] = (
      id,
      userId,
      now,
      amr,
      expectedAmr,
    ) =>
      reauthenticateQuery({
        id,
        userId,
        now,
        amr: amr ?? null,
        expectedAmr: expectedAmr ?? null,
      }).pipe(traced("Sessions.reauthenticate", { id }));

    return {
      models,
      piiOf,
      insert,
      findById,
      delete: repo.delete,
      listByUser,
      touch,
      deleteAllForUserExcept,
      deleteAllByUser,
      deleteReturning,
      listLiveIds,
      tombstone,
      markReusedOnce,
      revokeFamily,
      reauthenticate,
      deleteExpiredBefore,
    };
  });

export const SessionsRepositoryLive: Layer.Layer<SessionsRepository, never, SqlClient.SqlClient> =
  Layer.effect(SessionsRepository, makeSessionsRepository(Option.none()));

/**
 * CSG-006 (option B, opt-in): `sessions.ipAddress` and `sessions.userAgent` are
 * encrypted at rest through `Encryption` (AAD `sessions:<id>:<field>`, the declared
 * `CoreSealedColumns.sessionsIpAddress`/`sessionsUserAgent`). `Persistence.sql({ encryptPii: true })`
 * chooses this layer. Rows written earlier as plaintext stay readable and are sealed on their next
 * read (`SealedColumnConfig.resealOnRead`) or `SealedColumn.sweepDeployed`. The secret hash is
 * unaffected (it is already hash-only), and lookups never filter on these columns.
 */
export const SessionsRepositoryEncryptedLive: Layer.Layer<
  SessionsRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  SessionsRepository,
  Effect.all({
    ipAddress: SealedColumn.sqlCodec(CoreSealedColumns.sessionsIpAddress),
    userAgent: SealedColumn.sqlCodec(CoreSealedColumns.sessionsUserAgent),
  }).pipe(Effect.flatMap((codecs) => makeSessionsRepository(Option.some(codecs)))),
);
