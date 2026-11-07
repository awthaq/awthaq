// @awthaq/sql — SessionStoreSql
//
// Plan 02 / plan 16 (ADR-EA-041, ADR-EA-014): the SQL adapter of `@awthaq/ports`' `SessionStore`. It
// owns every statement over `sessions` (moved verbatim from the former `Repositories.ts`), both
// Postgres advisory locks beside the statements they serialize, the opt-in sealing of `ipAddress`
// and `userAgent` (CSG-006; both cross the port as `Sealed` cells, opened by `Sessions`), the tenant
// stamp (`Tenant.resolve`, BEH-EA-231), the read routing of `listLive` (ADR-EA-024) and the failure
// classification. It owns what used to leak into the domain: the model's insert and its
// `Model.Override`s, the `actingAsType`/`actingAsId` columns and the JSON text of `amr`.
//
// Two layers: `layer` stores `ipAddress`/`userAgent` as given; `layerSealedPii` seals them at rest
// through `Encryption` (AAD `sessions:<id>:<field>`, the declared
// `CoreSealedColumns.sessionsIpAddress`/`sessionsUserAgent`). Rows written earlier as plaintext stay
// readable and are sealed on their next read (`SealedColumnConfig.resealOnRead`) or
// `SealedColumn.sweepDeployed`. The secret hash is unaffected (it is already hash-only), and lookups
// never filter on these columns. Span names are the statements' (`Sessions.*`, EOTS-008).
//
// Atomicity, per primitive:
// - `insert`: one transaction (a savepoint inside a caller's) only when it has more than one statement
//   to commit (a `supersedes` or a `maxLive`): the ownership-checked tombstone, the insert, and the
//   eviction. A capped insert takes a per-user advisory transaction lock on Postgres, so racing
//   inserts for one user serialize and the cap holds exactly (READ COMMITTED alone let them all see room).
// - `rotate`: one compare-and-swap `UPDATE`; on a lost swap, one authoritative read tells the caller
//   what is there now.
// - `flagReuse`: one transaction whose first statement is `UPDATE ... WHERE "supersededAt" IS NOT NULL
//   AND "reusedAt" IS NULL RETURNING`, so of any number of racing presentations exactly one gets the
//   family, and the family revocation commits with it.
// - `remove`: one `DELETE ... RETURNING`.
// - `reauthenticate`: a compare-and-swap loop (queued per session by an advisory lock on Postgres) on the stored `amr` text (there is no JSON
//   function and no `FOR UPDATE` that is dialect-neutral): read, union, `UPDATE ... WHERE amr = <read>`,
//   and on a lost swap re-read and retry (five attempts, then `StoreUnavailable` for real contention).
// - Retried on a transient failure: `insert` and `rotate` (the unit that failed rolled back, and a lost
//   swap is an answer the domain already handles), `removeForUser`, `reauthenticate`, `purgeExpired`.
//   `flagReuse` and `remove` are not: repeating either after a success whose answer was lost would
//   lose the event the answer owes.
// - Writes that change what `listLive` returns capture the causal token (ADR-EA-024), so the writing
//   fiber's next eventual read sees its own write.

import { type Encryption, Sealed, SessionStore, SqlTransaction, Tenant } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Model from "effect/schema/Model";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlModel from "effect/sql/SqlModel";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as CoreSealedColumns from "./CoreSealedColumns.ts";
import { type ColumnCodec, sealCell, sealedCell } from "./internal/Cells.ts";
import { traced } from "./internal/traced.ts";
import { makeModels, resolveDialect, SessionId, UserId, type Session } from "./Models.ts";
import * as ReadRouting from "./ReadRouting.ts";
import * as SealedColumn from "./SealedColumn.ts";
import * as SqlStore from "./SqlStore.ts";
import { StoreUnavailable } from "./StoreFailure.ts";

/** How many times a step-up retries its compare-and-swap before the store is reported as contended. */
const REAUTHENTICATE_ATTEMPTS = 5;

/**
 * ESR-010: the page size `listLive` drains with, and the hard upper bound on any one session page.
 * The request schema below enforces it as defense in depth, so no value can yield a `SqlError` (0,
 * negative) or an unbounded page. It is the adapter's constant, never a caller's input.
 */
const PAGE = 200;

/** The keyset position within the drain: `(createdAt, id)` of the last row of the previous page. */
interface Cursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

/** The stored `amr` JSON text as the strings it holds; anything that is not an array of strings is none. */
const parseAmr = (text: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((method): method is string => typeof method === "string")
      : [];
  } catch {
    return [];
  }
};

/** A row as the port carries it. `pii` holds the stored `ipAddress`/`userAgent` cells, unopened (CSG-006). */
const toRecord = (
  row: Session,
  pii: Pick<SessionStore.SessionRecord, "ipAddress" | "userAgent">,
): SessionStore.SessionRecord => ({
  id: row.id,
  userId: row.userId,
  secretHash: row.secretHash,
  createdAt: row.createdAt,
  authenticatedAt: row.authenticatedAt,
  lastActiveAt: row.lastActiveAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  idleExpiresAt: row.idleExpiresAt,
  ipAddress: pii.ipAddress,
  userAgent: pii.userAgent,
  actingAs:
    row.actingAsType === null || row.actingAsId === null
      ? Option.none()
      : Option.some({ type: row.actingAsType, id: row.actingAsId }),
  amr: parseAmr(row.amr),
  tenantId: Option.fromNullOr(row.tenantId),
  previousSecretHash: Option.fromNullOr(row.previousSecretHash),
  previousSecretExpiresAt: Option.fromNullOr(row.previousSecretExpiresAt),
  familyId: row.familyId,
  supersededBy: Option.fromNullOr(row.supersededBy),
  supersededAt: Option.fromNullOr(row.supersededAt),
  reusedAt: Option.fromNullOr(row.reusedAt),
});

interface PiiCodecs {
  readonly ipAddress: ColumnCodec;
  readonly userAgent: ColumnCodec;
}

const make = (pii: Option.Option<PiiCodecs>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = makeModels(yield* resolveDialect(sql));
    const crud = yield* SqlModel.makeRepository(models.Session, {
      tableName: "sessions",
      spanPrefix: "Sessions",
      idColumn: "id",
    });
    const { write, read, once } = SqlStore.make(sql);

    // CSG-006: `ipAddress`/`userAgent` are the personal-data columns. Without codecs these are
    // no-ops; with them they are sealed at insert (they are immutable afterwards) and the stored
    // cells are handed out as `Sealed`s, from `SqlModel` or from a hand-written query alike.
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

    /** One row as the port's record, its PII cells wrapped (never opened here). */
    const record = (row: Session) =>
      toRecord(row, {
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

    /** `crud.findById` raises `NoSuchElementError` for an absent row; the adapter wants an `Option`. */
    const findByIdOption = (id: SessionId) =>
      crud.findById(id).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NoSuchElementError", () => Effect.succeed(Option.none<Session>())),
      );

    // RRS-003: `"supersededAt" IS NULL` — load-bearing, not cosmetic. A tombstoned row must never
    // appear in a user's device list, and this is also what makes `Sessions.verifyLive`/
    // `Jwt.introspectLive` correctly reject a reused/family-revoked session's JWT for free — both
    // call this same page.
    //
    // RRC-001: the one replica-eligible session read. Built once per client (primary, and the
    // replica when `ReadRouting.replica` is provided) when the layer is built; the default
    // `consistency` is `"authoritative"`, i.e. the primary.
    const router = yield* ReadRouting.makeRouter;
    const pageOn = router.route((client) =>
      SqlSchema.findAll({
        Request: Schema.Struct({
          userId: UserId,
          /** SMS-002: the caller's clock (so `TestClock` controls it) — rows past either expiry are not listed. */
          now: models.wire.dateTime,
          cursorCreatedAt: models.wire.nullableDateTime,
          cursorId: Schema.NullOr(Schema.String),
          limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: PAGE }))),
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

    // Upstream-hardening map, ticket 01: the throttled touch/rotation write's own compare-and-swap —
    // `expectedSecretHash` must still match the row's *current* `secretHash` for the update to apply.
    // Two concurrent requests racing the same throttled window would otherwise both blindly
    // overwrite `secretHash` via a plain `update`, leaving whichever response lost the race holding
    // a token that no longer verifies. No row means another request already won that race — not a
    // failure. Plan 02: a tombstoned row is never rotated (`"supersededAt" IS NULL`): it is the
    // evidence of reuse. RRS-005: the replaced hash is kept until `previousSecretExpiresAt`.
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

    // BEH-EA-054: bulk-revokes every session for `userId` except `keep`. Resolves to how many went.
    const deleteAllForUserExceptQuery = SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, keep: SessionId }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) =>
        sql`DELETE FROM sessions WHERE "userId" = ${r.userId} AND id != ${r.keep} RETURNING id`,
    });

    // Upstream-hardening map, ticket 02: bulk-revokes every session for `userId`, no exceptions.
    // Quoted `"userId"`: this table's Postgres DDL (`CoreMigrations.ts`) declares the column with
    // preserved mixed case, which only an equally-quoted reference matches there (Postgres folds an
    // unquoted identifier to lowercase); SQLite's own identifier resolution is case-insensitive
    // regardless of quoting, so the same quoted form is correct on both dialects.
    const deleteAllByUserQuery = SqlSchema.findAll({
      Request: UserId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (userId) => sql`DELETE FROM sessions WHERE "userId" = ${userId} RETURNING id`,
    });

    // CSG-003: retention. Deletes up to `limit` rows whose absolute or idle expiry is before
    // `cutoff` — tombstoned rows included (they keep their original expiry). One bounded statement,
    // so a sweep over a large backlog is a loop of short transactions, not one long lock.
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

    // SMS-003: the user's live (not tombstoned, past neither expiry at `now`), non-impersonation
    // sessions' ids and last activity — what a concurrent-session cap counts and evicts from.
    // Impersonation (`actingAs`) rows are excluded: an admin's support session never counts against
    // the target.
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

    // TIR-008/GC-005: deletes session `id` in ONE statement (`DELETE ... RETURNING`) and answers the
    // user it belonged to, so exactly one of two concurrent revokes sees the row and publishes the
    // event. When `owner` is given the row is deleted only if it belongs to that user: ownership is
    // enforced by the statement, not by a preceding lookup. No row for an unknown id and a foreign
    // id alike, so a caller cannot tell them apart.
    const deleteReturningQuery = SqlSchema.findAll({
      Request: Schema.Struct({ id: SessionId, owner: Schema.NullOr(UserId) }),
      Result: Schema.Struct({ userId: UserId }),
      execute: (request) =>
        request.owner === null
          ? sql`DELETE FROM sessions WHERE id = ${request.id} RETURNING "userId"`
          : sql`DELETE FROM sessions WHERE id = ${request.id} AND "userId" = ${request.owner} RETURNING "userId"`,
    });

    // RRS-003: tombstones the superseded row in a rotation — sets `supersededBy`/`supersededAt`,
    // never deletes it. Returns the now-tombstoned row (its own `familyId` is what the new row
    // inherits). ESR-002: applies only to a still-live row (`supersededAt IS NULL`), so two
    // concurrent supersedes of one row cannot both tombstone it and fork its family — the loser
    // gets no row. INV-EA-018: and only a row owned by `userId`; an id alone never acts on another
    // user's session, so a foreign row is no row too.
    const tombstoneQuery = SqlSchema.findOneOption({
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

    // RRS-003: marks a tombstoned row's own `reusedAt`, ONCE: the statement applies only to a
    // tombstoned row whose `reusedAt` is still NULL, so of any number of concurrent presentations
    // exactly one gets a row (the row's family and owner) and publishes the reuse. SEA-005: like
    // every other timestamp write here, `reusedAt` goes through a `Request` schema, so the dialect's
    // own wire codec is the one and only encoder (interpolating a raw `DateTime.Utc` would bind its
    // internal fields instead of a timestamp).
    const markReusedQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: SessionId, reusedAt: models.wire.dateTime }),
      Result: Schema.Struct({ familyId: SessionId, userId: UserId }),
      execute: (request) =>
        sql`UPDATE sessions SET "reusedAt" = ${request.reusedAt}
            WHERE "id" = ${request.id} AND "supersededAt" IS NOT NULL AND "reusedAt" IS NULL
            RETURNING "familyId", "userId"`,
    });

    // RRS-003: bulk hard-deletes every still-live (non-tombstoned) row sharing `familyId` — a
    // confirmed-compromised family has no further lineage worth preserving.
    const revokeFamily = (familyId: SessionId) =>
      sql`DELETE FROM sessions WHERE "familyId" = ${familyId} AND "supersededAt" IS NULL`.pipe(
        Effect.asVoid,
        traced("Sessions.revokeFamily", { familyId }),
      );

    // Wayfinder map ticket 15 (AAPS-001/BPAS-001): the one column `reauthenticate` writes — a
    // targeted `UPDATE`, not the generic `update` (which would also require supplying every other
    // `update`-variant field this call has no business touching). `now` is the new
    // `authenticatedAt` and the instant liveness is judged at: a tombstoned or expired row is no row.
    // THS-003: `amr` is the already-unioned JSON to store (`null` leaves it untouched), and with
    // `expectedAmr` the write applies only if the stored JSON is still that (compare-and-swap), so
    // concurrent step-ups cannot lose a method.
    const reauthenticateQuery = SqlSchema.findOneOption({
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

    return SessionStore.SessionStore.of({
      insert: ({ session, supersedes, maxLive }) => {
        const persist = Effect.gen(function* () {
          // SMS-003: the cap is read-then-evict, so under READ COMMITTED racing inserts each saw room and
          // all landed. A per-user transaction-scoped advisory lock serializes them (the next one reads
          // the previous one's commit); SQLite already serializes writers.
          if (Option.isSome(maxLive)) {
            yield* sql.onDialectOrElse({
              pg: () =>
                sql`SELECT pg_advisory_xact_lock(hashtext(${`session-cap:${session.userId}`}))`,
              orElse: () => Effect.void,
            });
          }
          // RRS-003: tombstoned, not deleted; an ancestor owned by another user, already tombstoned or
          // absent is "no ancestor", and the new row founds a fresh family (INV-EA-018).
          const ancestor = Option.isNone(supersedes)
            ? Option.none<Session>()
            : yield* tombstoneQuery({
                id: supersedes.value,
                userId: session.userId,
                supersededBy: session.id,
                supersededAt: session.at,
              }).pipe(traced("Sessions.tombstone", { id: supersedes.value }));
          const tenantId = yield* Tenant.resolve(Option.none());
          const columns = yield* concealPii(session.id, {
            ipAddress: Option.getOrNull(session.ipAddress),
            userAgent: Option.getOrNull(session.userAgent),
          });
          const row = yield* models.Session.insert
            .makeEffect({
              id: session.id,
              userId: session.userId,
              secretHash: session.secretHash,
              ipAddress: columns.ipAddress,
              userAgent: columns.userAgent,
              tenantId: Option.getOrNull(tenantId),
              absoluteExpiresAt: session.absoluteExpiresAt,
              idleExpiresAt: Model.Override(session.idleExpiresAt),
              createdAt: Model.Override(session.at),
              authenticatedAt: Model.Override(session.at),
              lastActiveAt: Model.Override(session.at),
              actingAsType: Option.getOrNull(Option.map(session.actingAs, (acting) => acting.type)),
              actingAsId: Option.getOrNull(Option.map(session.actingAs, (acting) => acting.id)),
              amr: JSON.stringify(session.amr),
              familyId: Option.match(ancestor, {
                onNone: () => session.id,
                onSome: (superseded) => superseded.familyId,
              }),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            })
            .pipe(Effect.orDie);
          const inserted = yield* crud.insert(row);
          // SMS-003: list the user's other live, non-impersonation sessions (oldest activity first) and
          // delete the surplus, in this same unit.
          const evicted =
            Option.isNone(maxLive) || Option.isSome(session.actingAs)
              ? []
              : SessionStore.evictionOrder(
                  maxLive.value,
                  (yield* liveIdsQuery({ userId: session.userId, now: session.at }).pipe(
                    traced("Sessions.listLiveIds", { userId: session.userId }),
                  )).filter((live) => live.id !== session.id),
                );
          for (const id of evicted) yield* crud.delete(id);
          const outcome: SessionStore.InsertOutcome = {
            // What was just written is handed back as written, never reopened (and never decrypted).
            inserted: toRecord(inserted, {
              ipAddress: Option.map(session.ipAddress, Sealed.plain),
              userAgent: Option.map(session.userAgent, Sealed.plain),
            }),
            superseded: Option.map(ancestor, record),
            evicted,
          };
          return outcome;
        });
        // A lone insert is one statement; only a supersede or a cap makes it a unit that must commit whole.
        return (
          Option.isNone(supersedes) && Option.isNone(maxLive)
            ? persist
            : SqlTransaction.transactional(sql)(persist)
        ).pipe(write("SessionStore.insert", { capture: true }));
      },

      get: (id) =>
        findByIdOption(id).pipe(Effect.map(Option.map(record)), read("SessionStore.get")),

      rotate: (input) =>
        Effect.gen(function* () {
          const touched = yield* touchQuery({
            id: input.id,
            expectedSecretHash: input.expectedSecretHash,
            secretHash: input.secretHash,
            previousSecretHash: Option.getOrNull(
              Option.map(input.previous, (previous) => previous.hash),
            ),
            previousSecretExpiresAt: Option.getOrNull(
              Option.map(input.previous, (previous) => previous.expiresAt),
            ),
            lastActiveAt: input.lastActiveAt,
            idleExpiresAt: input.idleExpiresAt,
          }).pipe(traced("Sessions.touch", { id: input.id }));
          if (Option.isSome(touched)) {
            const rotated: SessionStore.RotateOutcome = {
              _tag: "Rotated",
              session: record(touched.value),
            };
            return rotated;
          }
          // Lost the swap (or the row is tombstoned or gone): say what is there now, authoritatively.
          const current = Option.map(yield* findByIdOption(input.id), record);
          const lost: SessionStore.RotateOutcome = { _tag: "Lost", current };
          return lost;
        }).pipe(write("SessionStore.rotate")),

      flagReuse: (id, at) =>
        SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            const flagged = yield* markReusedQuery({ id, reusedAt: at }).pipe(
              traced("Sessions.markReusedOnce", { id }),
            );
            if (Option.isSome(flagged)) yield* revokeFamily(flagged.value.familyId);
            return flagged;
          }),
        ).pipe(once("SessionStore.flagReuse", { capture: true })),

      remove: (id, owner) =>
        deleteReturningQuery({ id, owner: Option.getOrNull(owner) }).pipe(
          Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.userId)),
          traced("Sessions.deleteReturning", { id }),
          once("SessionStore.remove", { capture: true }),
        ),

      removeForUser: (userId, keep) =>
        (Option.isSome(keep)
          ? deleteAllForUserExceptQuery({ userId, keep: keep.value }).pipe(
              Effect.map((rows) => rows.length),
              traced("Sessions.deleteAllForUserExcept", { userId }),
            )
          : deleteAllByUserQuery(userId).pipe(
              Effect.map((rows) => rows.length),
              traced("Sessions.deleteAllByUser", { userId }),
            )
        ).pipe(write("SessionStore.removeForUser", { capture: true })),

      // TIR-003/ESS-005: pages the user's live rows (`isLive` at `now` is in the statement, SMS-002)
      // until `limit + 1` have been seen, which is all it takes to know whether there are more.
      listLive: ({ userId, now, limit, consistency }) =>
        Effect.gen(function* () {
          const rows: Array<Session> = [];
          let cursor = Option.none<Cursor>();
          while (rows.length <= limit) {
            const items = yield* pageOn(consistency).pipe(
              Effect.flatMap((page) =>
                page({
                  userId,
                  now,
                  cursorCreatedAt: Option.getOrNull(Option.map(cursor, (c) => c.createdAt)),
                  cursorId: Option.getOrNull(Option.map(cursor, (c) => c.id)),
                  limit: PAGE,
                }),
              ),
              traced("Sessions.listByUser", { userId }),
            );
            rows.push(...items);
            const last = items.at(-1);
            if (items.length < PAGE || last === undefined) break;
            cursor = Option.some({ createdAt: last.createdAt, id: last.id });
          }
          return { items: rows.slice(0, limit).map(record), truncated: rows.length > limit };
        }).pipe(read("SessionStore.listLive")),

      reauthenticate: (input) =>
        SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            // THS-003: a compare-and-swap loses once per concurrent winner, so N racing step-ups can exhaust
            // any fixed attempt count. On Postgres a per-session advisory transaction lock queues them, and
            // the loop below stays as the guard for a writer that does not take the lock.
            yield* sql.onDialectOrElse({
              pg: () => sql`SELECT pg_advisory_xact_lock(hashtext(${`session-amr:${input.id}`}))`,
              orElse: () => Effect.void,
            });
            // THS-003: union the newly proven methods into the stored `amr` (monotone), written back only
            // while the row still holds the text the union was computed from, so concurrent step-ups both land.
            for (let attempt = 0; attempt < REAUTHENTICATE_ATTEMPTS; attempt++) {
              const current = yield* findByIdOption(input.id);
              // BEH-EA-319: a dead, foreign or absent row is refused; the UPDATE's own WHERE repeats the guard.
              if (
                Option.isNone(current) ||
                current.value.userId !== input.owner ||
                !SessionStore.isLive(
                  {
                    absoluteExpiresAt: current.value.absoluteExpiresAt,
                    idleExpiresAt: current.value.idleExpiresAt,
                    supersededAt: Option.fromNullOr(current.value.supersededAt),
                  },
                  input.at,
                )
              ) {
                return Option.none<SessionStore.SessionRecord>();
              }
              const updated = yield* reauthenticateQuery({
                id: input.id,
                userId: input.owner,
                now: input.at,
                amr:
                  input.addAmr.length === 0
                    ? null
                    : JSON.stringify(
                        SessionStore.unionMethods(parseAmr(current.value.amr), input.addAmr),
                      ),
                expectedAmr: input.addAmr.length === 0 ? null : current.value.amr,
              }).pipe(traced("Sessions.reauthenticate", { id: input.id }));
              if (Option.isSome(updated)) return Option.some(record(updated.value));
            }
            return yield* Effect.fail(
              new StoreUnavailable({ operation: "SessionStore.reauthenticate" }),
            );
          }),
        ).pipe(write("SessionStore.reauthenticate")),

      purgeExpired: (before) =>
        SqlStore.drainBatches((limit) =>
          deleteExpiredQuery({ cutoff: before, limit }).pipe(
            Effect.map((rows) => rows.length),
            traced("Sessions.deleteExpiredBefore"),
            write("SessionStore.purgeExpired"),
          ),
        ),
    });
  });

/** What the sealing variant requires: the one client, and the `Encryption` the PII is sealed with. */
export type SealedRequires = SqlClient.SqlClient | Encryption.Encryption;

/** `ipAddress`/`userAgent` stored as given. Requires `SqlClient`. */
export const layer = Layer.effect(SessionStore.SessionStore, make(Option.none()));

/** CSG-006 (opt-in): `ipAddress`/`userAgent` sealed at rest (AAD `sessions:<id>:<field>`). Requires `SqlClient | Encryption`. */
export const layerSealedPii = Layer.effect(
  SessionStore.SessionStore,
  Effect.all({
    ipAddress: SealedColumn.sqlCodec(CoreSealedColumns.sessionsIpAddress),
    userAgent: SealedColumn.sqlCodec(CoreSealedColumns.sessionsUserAgent),
  }).pipe(Effect.flatMap((codecs) => make(Option.some(codecs)))),
);
