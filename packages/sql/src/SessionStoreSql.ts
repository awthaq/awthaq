// @awthaq/sql — SessionStoreSql
//
// Plan 02 (ADR-EA-041, ADR-EA-014): the SQL adapter of `@awthaq/ports`' `SessionStore`, built over
// `SessionsRepository` (so `SessionsRepositoryEncryptedLive`, which seals `ipAddress` and `userAgent`
// at rest (CSG-006), still swaps in). It owns what used to leak into the domain: the model's insert
// and its `Model.Override`s, the `actingAsType`/`actingAsId` columns and the JSON text of `amr`.
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

import { SessionStore, SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Model from "effect/unstable/schema/Model";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Session } from "./Models.ts";
import { MAX_PAGE_SIZE, type Cursor, SessionsRepository } from "./Repositories.ts";
import * as SqlStore from "./SqlStore.ts";
import { StoreUnavailable } from "./StoreFailure.ts";

/** How many times a step-up retries its compare-and-swap before the store is reported as contended. */
const REAUTHENTICATE_ATTEMPTS = 5;

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

const toRecord = (row: Session): SessionStore.SessionRecord => ({
  id: row.id,
  userId: row.userId,
  secretHash: row.secretHash,
  createdAt: row.createdAt,
  authenticatedAt: row.authenticatedAt,
  lastActiveAt: row.lastActiveAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  idleExpiresAt: row.idleExpiresAt,
  ipAddress: Option.fromNullOr(row.ipAddress),
  userAgent: Option.fromNullOr(row.userAgent),
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

/** The SQL adapter. Requires the sessions repository and the client its transactions run on. */
export const layer = Layer.effect(
  SessionStore.SessionStore,
  Effect.gen(function* () {
    const repo = yield* SessionsRepository;
    const sql = yield* SqlClient.SqlClient;
    const { write, read, once } = SqlStore.make(sql);

    const insert: SessionStore.SessionStoreShape["insert"] = ({ session, supersedes, maxLive }) => {
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
          : yield* repo
              .tombstone({
                id: supersedes.value,
                userId: session.userId,
                supersededBy: session.id,
                supersededAt: session.at,
              })
              .pipe(
                Effect.map(Option.some),
                Effect.catchTag("NoSuchElementError", () => Effect.succeed(Option.none<Session>())),
              );
        const row = yield* repo.models.Session.insert
          .makeEffect({
            id: session.id,
            userId: session.userId,
            secretHash: session.secretHash,
            ipAddress: Option.getOrNull(session.ipAddress),
            userAgent: Option.getOrNull(session.userAgent),
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
        const inserted = yield* repo.insert(row);
        // SMS-003: list the user's other live, non-impersonation sessions (oldest activity first) and
        // delete the surplus, in this same unit.
        const evicted =
          Option.isNone(maxLive) || Option.isSome(session.actingAs)
            ? []
            : SessionStore.evictionOrder(
                maxLive.value,
                (yield* repo.listLiveIds(session.userId, session.at)).filter(
                  (live) => live.id !== session.id,
                ),
              );
        for (const id of evicted) yield* repo.delete(id);
        const outcome: SessionStore.InsertOutcome = {
          inserted: toRecord(inserted),
          superseded: Option.map(ancestor, toRecord),
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
    };

    const get: SessionStore.SessionStoreShape["get"] = (id) =>
      repo.findById(id).pipe(
        Effect.map((row) => Option.some(toRecord(row))),
        Effect.catchTag("NoSuchElementError", () =>
          Effect.succeed(Option.none<SessionStore.SessionRecord>()),
        ),
        read("SessionStore.get"),
      );

    const rotate: SessionStore.SessionStoreShape["rotate"] = (input) =>
      Effect.gen(function* () {
        const touched = yield* repo.touch({
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
        });
        if (Option.isSome(touched)) {
          const rotated: SessionStore.RotateOutcome = {
            _tag: "Rotated",
            session: toRecord(touched.value),
          };
          return rotated;
        }
        // Lost the swap (or the row is tombstoned or gone): say what is there now, authoritatively.
        const current = yield* repo.findById(input.id).pipe(
          Effect.map((row) => Option.some(toRecord(row))),
          Effect.catchTag("NoSuchElementError", () =>
            Effect.succeed(Option.none<SessionStore.SessionRecord>()),
          ),
        );
        const lost: SessionStore.RotateOutcome = { _tag: "Lost", current };
        return lost;
      }).pipe(write("SessionStore.rotate"));

    const flagReuse: SessionStore.SessionStoreShape["flagReuse"] = (id, at) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          const flagged = yield* repo.markReusedOnce(id, at);
          if (Option.isSome(flagged)) yield* repo.revokeFamily(flagged.value.familyId);
          return flagged;
        }),
      ).pipe(once("SessionStore.flagReuse", { capture: true }));

    const remove: SessionStore.SessionStoreShape["remove"] = (id, owner) =>
      repo
        .deleteReturning(id, Option.getOrUndefined(owner))
        .pipe(once("SessionStore.remove", { capture: true }));

    const removeForUser: SessionStore.SessionStoreShape["removeForUser"] = (userId, keep) =>
      (Option.isSome(keep)
        ? repo.deleteAllForUserExcept(userId, keep.value)
        : repo.deleteAllByUser(userId)
      ).pipe(write("SessionStore.removeForUser", { capture: true }));

    // TIR-003/ESS-005: pages the user's live rows (the repository applies `isLive` at `now`, SMS-002)
    // until `limit + 1` have been seen, which is all it takes to know whether there are more.
    const listLive: SessionStore.SessionStoreShape["listLive"] = ({
      userId,
      now,
      limit,
      consistency,
    }) =>
      Effect.gen(function* () {
        const rows: Array<Session> = [];
        let cursor = Option.none<Cursor>();
        while (rows.length <= limit) {
          const page = yield* repo.listByUser(
            userId,
            now,
            Option.getOrUndefined(cursor),
            MAX_PAGE_SIZE,
            { consistency },
          );
          rows.push(...page.items);
          if (Option.isNone(page.nextCursor)) break;
          cursor = page.nextCursor;
        }
        return { items: rows.slice(0, limit).map(toRecord), truncated: rows.length > limit };
      }).pipe(read("SessionStore.listLive"));

    const reauthenticate: SessionStore.SessionStoreShape["reauthenticate"] = (input) =>
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
            const current = yield* repo.findById(input.id).pipe(
              Effect.map(Option.some),
              Effect.catchTag("NoSuchElementError", () => Effect.succeed(Option.none<Session>())),
            );
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
            const updated = yield* (
              input.addAmr.length === 0
                ? repo.reauthenticate(input.id, input.owner, input.at)
                : repo.reauthenticate(
                    input.id,
                    input.owner,
                    input.at,
                    JSON.stringify(
                      SessionStore.unionMethods(parseAmr(current.value.amr), input.addAmr),
                    ),
                    current.value.amr,
                  )
            ).pipe(
              Effect.map(Option.some),
              Effect.catchTag("NoSuchElementError", () => Effect.succeed(Option.none<Session>())),
            );
            if (Option.isSome(updated)) return Option.some(toRecord(updated.value));
          }
          return yield* Effect.fail(
            new StoreUnavailable({ operation: "SessionStore.reauthenticate" }),
          );
        }),
      ).pipe(write("SessionStore.reauthenticate"));

    const purgeExpired: SessionStore.SessionStoreShape["purgeExpired"] = (before) =>
      SqlStore.drainBatches((limit) =>
        repo.deleteExpiredBefore(before, limit).pipe(write("SessionStore.purgeExpired")),
      );

    return SessionStore.SessionStore.of({
      insert,
      get,
      rotate,
      flagReuse,
      remove,
      removeForUser,
      listLive,
      reauthenticate,
      purgeExpired,
    });
  }),
);
