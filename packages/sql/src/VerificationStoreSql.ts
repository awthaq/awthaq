// @awthaq/sql — VerificationStoreSql
//
// Plan 02 / plan 16 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `VerificationStore`. Tokens and
// reservations are one adapter, as they are one port, and it owns every statement over
// `verification_tokens` and `verification_reservations` (moved verbatim from the former
// `Repositories.ts`) and the tenant stamp (`Tenant.resolve`, BEH-EA-231). ADR-EA-016: the partial
// unique index on `(identifier) WHERE "consumedAt" IS NULL` is what makes `upsertLive` atomic, and a
// conditional upsert is what makes `reserve` exclusive. Statement spans keep their names
// (`VerificationTokens.*`, `VerificationReservations.*`, EOTS-008); an identifier embeds a user id
// or email, so it is never a span attribute.
//
// - `present`: reads the live row of the identifier, then runs one atomic `UPDATE ... RETURNING`
//   that decides win or lose. A miss against a budgeted row spends an attempt on THE ROW IT WAS
//   JUDGED AGAINST (pinned by id: a reissue replaces the row and its id, so it finds nothing to
//   charge), in the unit of work's `afterUnit` lane, so it survives the rollback of a caller that
//   fails with the miss (ADR-EA-037). Best effort: a miss must keep answering uniformly
//   (BEH-EA-116), so a failed spend is logged, never turned into a different response.
// - `settle`: nothing to do. The caller's transaction rolled the claim back if it failed.
// - `transaction`: one real transaction (a savepoint inside an enclosing one).
// - Retried on a transient failure: only the idempotent primitives (`upsertLive`, `deleteByUser`,
//   `purgeExpired`). `present` and `reserve` are not: repeating either after a success whose answer
//   was lost would change it.

import { SqlTransaction, Tenant, VerificationStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { traced } from "./internal/traced.ts";
import {
  makeModels,
  resolveDialect,
  UserId,
  VerificationTokenId,
  type VerificationToken,
} from "./Models.ts";
import * as SqlStore from "./SqlStore.ts";
import { storeUnavailable } from "./StoreFailure.ts";

/** A token stored with no payload carries the encoded literal `null` (see `Models.ts`). */
const NO_PAYLOAD = "null";

const toTokenRow = (row: VerificationToken): VerificationStore.TokenRow => ({
  id: row.id,
  identifier: row.identifier,
  userId: Option.fromNullOr(row.userId),
  valueHash: row.valueHash,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  payloadJson: row.payload === NO_PAYLOAD ? Option.none() : Option.some(row.payload),
  maxAttempts: Option.fromNullOr(row.maxAttempts),
  attempts: row.attempts,
  consumedAt: Option.fromNullOr(row.consumedAt),
  tenantId: Option.fromNullOr(row.tenantId),
});

/** The SQL adapter. Requires the client its statements and its transaction run on. */
export const layer = Layer.effect(
  VerificationStore.VerificationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = makeModels(yield* resolveDialect(sql));
    const { write, once } = SqlStore.make(sql);

    // PPS-003: the live row only — the partial unique index
    // `verification_tokens_live_identifier` (`WHERE "consumedAt" IS NULL`)
    // holds at most one such row per identifier, so no sort and no scan of
    // the consumed history the table keeps. Nothing needs "the latest
    // including consumed": ADR-EA-016's `upsertLive`/`tryConsume` own the
    // write paths.
    const findByIdentifierQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: models.VerificationToken,
      execute: (identifier) =>
        sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} AND "consumedAt" IS NULL`,
    });

    // ADR-EA-016: one atomic `INSERT ... ON CONFLICT(identifier) WHERE consumedAt IS NULL DO UPDATE
    // ... RETURNING`, targeting a partial unique index on `(identifier) WHERE consumedAt IS NULL` —
    // the DB engine itself decides "fresh insert" vs. "replace the current live row" in one
    // statement, so two concurrent `issue`s for the same `identifier` can never both leave a live
    // row behind the way a separate delete-then-insert could. Every already-consumed historical row
    // is untouched either way. `attempts` restarts at 0 on every (re)issue (SOS-004).
    const upsertLiveQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: VerificationTokenId,
        identifier: Schema.String,
        userId: Schema.NullOr(UserId),
        tenantId: Schema.NullOr(Schema.String),
        valueHash: Schema.String,
        expiresAt: models.wire.dateTime,
        createdAt: models.wire.dateTime,
        payload: Schema.String,
        maxAttempts: Schema.NullOr(Schema.Number),
        attempts: Schema.Number,
      }),
      Result: models.VerificationToken,
      execute: (request) => sql`
        INSERT INTO verification_tokens (id, identifier, "userId", "tenantId", "valueHash", "expiresAt", "consumedAt", "createdAt", payload, "maxAttempts", attempts)
        VALUES (${request.id}, ${request.identifier}, ${request.userId}, ${request.tenantId}, ${request.valueHash}, ${request.expiresAt}, NULL, ${request.createdAt}, ${request.payload}, ${request.maxAttempts}, ${request.attempts})
        ON CONFLICT(identifier) WHERE "consumedAt" IS NULL
        DO UPDATE SET
          id = excluded.id,
          "userId" = excluded."userId",
          "tenantId" = excluded."tenantId",
          "valueHash" = excluded."valueHash",
          "expiresAt" = excluded."expiresAt",
          "createdAt" = excluded."createdAt",
          payload = excluded.payload,
          "maxAttempts" = excluded."maxAttempts",
          attempts = excluded.attempts,
          "consumedAt" = NULL
        RETURNING *
      `,
    });

    // BCR-003: sweeps every token (live or already-consumed) naming this user — the cascade
    // `Account.ts`'s `deleteUser` needs. Resolves to how many went.
    const deleteAllByUserQuery = SqlSchema.findAll({
      Request: UserId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (userId) =>
        sql`DELETE FROM verification_tokens WHERE "userId" = ${userId} RETURNING id`,
    });

    // CSG-003: retention. Deletes up to `limit` tokens that were consumed, or expired, before
    // `cutoff` — a live token, and a recent consumed one (the forensic window), stay.
    const deleteExpiredQuery = SqlSchema.findAll({
      Request: Schema.Struct({ cutoff: models.wire.dateTime, limit: Schema.Number }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) => sql`
        DELETE FROM verification_tokens
        WHERE id IN (
          SELECT id FROM verification_tokens
          WHERE ("consumedAt" IS NOT NULL AND "consumedAt" < ${r.cutoff}) OR "expiresAt" < ${r.cutoff}
          LIMIT ${r.limit}
        )
        RETURNING id
      `,
    });

    // ADR-EA-016/BEH-EA-058/062: the one atomic statement `present` is built on —
    // `identifier`/`valueHash`/`expiresAt > now`/`consumedAt IS NULL` are all checked and written in
    // a single `UPDATE ... RETURNING`, so unknown, expired, wrong-secret, and already-consumed all
    // collapse into the same "no row back" result without a separate read racing the write.
    // ACS-002: the digest equality happens inside this predicate rather than through `Hmac`'s
    // comparison — an accepted exception, since both sides are SHA-256 of a 256-bit random secret
    // (BEH-EA-060).
    const tryConsumeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        identifier: Schema.String,
        valueHash: Schema.String,
        now: models.wire.dateTime,
      }),
      Result: models.VerificationToken,
      execute: (request) => sql`
        UPDATE verification_tokens
        SET "consumedAt" = ${request.now}
        WHERE identifier = ${request.identifier}
          AND "valueHash" = ${request.valueHash}
          AND "expiresAt" > ${request.now}
          AND "consumedAt" IS NULL
        RETURNING *
      `,
    });

    // SOS-004: a wrong presentation against the live row `id`: both right-hand sides read the
    // pre-update `attempts`, so `attempts + 1 >= maxAttempts` burns the row in the same statement
    // that counts the miss — concurrent guesses cannot overshoot the budget. Pinned to the row's id,
    // not its identifier: a presentation is charged to the row it was judged against, so a `reissue`
    // (which replaces the live row, and its id) between the miss and the spend never charges the new
    // token. A row with no budget, a consumed or expired one and an unknown id are untouched.
    const recordFailedAttemptQuery = SqlSchema.void({
      Request: Schema.Struct({ id: VerificationTokenId, now: models.wire.dateTime }),
      execute: (request) => sql`
        UPDATE verification_tokens
        SET attempts = attempts + 1,
            "consumedAt" = CASE WHEN attempts + 1 >= "maxAttempts" THEN ${request.now} ELSE "consumedAt" END
        WHERE id = ${request.id}
          AND "consumedAt" IS NULL
          AND "expiresAt" > ${request.now}
          AND "maxAttempts" IS NOT NULL
      `,
    });

    // BEH-EA-063/ADR-EA-016: `reserve`'s one race-safe primitive — one atomic statement; the `WHERE`
    // clause on the `DO UPDATE` is what makes "unexpired reservations block a new claim" a property
    // of this single write, not a separate check racing against it. `RETURNING *` produces a row only
    // when the insert happened or the conditional update actually fired — SQLite's own UPSERT
    // semantics skip `RETURNING` entirely when the `DO UPDATE`'s `WHERE` is false, so "no row back"
    // and "claim failed" are the same fact, not two things this code has to keep in sync by hand.
    // `now` is the caller's own clock reading, never the database's own clock, so `TestClock`
    // controls it like every other time-sensitive behavior in this stratum.
    const claimQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        identifier: Schema.String,
        tenantId: Schema.NullOr(Schema.String),
        expiresAt: models.wire.dateTime,
        now: models.wire.dateTime,
      }),
      Result: models.VerificationReservation,
      execute: (request) => sql`
        INSERT INTO verification_reservations (identifier, "tenantId", "expiresAt")
        VALUES (${request.identifier}, ${request.tenantId}, ${request.expiresAt})
        ON CONFLICT(identifier) DO UPDATE SET "expiresAt" = excluded."expiresAt", "tenantId" = excluded."tenantId"
        WHERE verification_reservations."expiresAt" <= ${request.now}
        RETURNING *
      `,
    });

    const deleteExpiredReservationsQuery = SqlSchema.findAll({
      Request: Schema.Struct({ cutoff: models.wire.dateTime, limit: Schema.Number }),
      Result: Schema.Struct({ identifier: Schema.String }),
      execute: (r) => sql`
        DELETE FROM verification_reservations
        WHERE identifier IN (
          SELECT identifier FROM verification_reservations
          WHERE "expiresAt" < ${r.cutoff}
          LIMIT ${r.limit}
        )
        RETURNING identifier
      `,
    });

    return VerificationStore.VerificationStore.of({
      upsertLive: (row) =>
        Tenant.resolve(Option.none()).pipe(
          Effect.flatMap((tenantId) =>
            upsertLiveQuery({
              id: row.id,
              identifier: row.identifier,
              userId: Option.getOrNull(row.userId),
              tenantId: Option.getOrNull(tenantId),
              valueHash: row.valueHash,
              expiresAt: row.expiresAt,
              createdAt: row.createdAt,
              payload: Option.getOrElse(row.payloadJson, () => NO_PAYLOAD),
              maxAttempts: Option.getOrNull(row.maxAttempts),
              attempts: 0,
            }),
          ),
          traced("VerificationTokens.upsertLive", { id: row.id }),
          Effect.map(toTokenRow),
          write("VerificationStore.upsertLive"),
        ),

      present: ({ identifier, valueHash, now }) =>
        Effect.gen(function* () {
          // SOS-004: judge the live row first, so a miss is charged to it and to nothing newer.
          const judged = yield* findByIdentifierQuery(identifier).pipe(
            traced("VerificationTokens.findByIdentifier"),
          );
          // BEH-EA-058/062: one atomic `UPDATE ... RETURNING` decides win or lose: no separate read
          // racing this call's own write, the same guarantee the `Ref` adapter's `Ref.modify` gives.
          const claimed = yield* tryConsumeQuery({ identifier, valueHash, now }).pipe(
            traced("VerificationTokens.tryConsume"),
          );
          if (Option.isSome(claimed)) {
            const outcome: VerificationStore.PresentOutcome = {
              _tag: "Hit",
              row: toTokenRow(claimed.value),
            };
            return outcome;
          }
          if (Option.isSome(judged)) {
            yield* SqlTransaction.afterUnit(
              recordFailedAttemptQuery({ id: judged.value.id, now }).pipe(
                traced("VerificationTokens.recordFailedAttempt"),
                Effect.catchCause((cause) =>
                  Effect.logError(
                    "awthaq: the failed attempt against a verification token could not be recorded",
                    cause,
                  ),
                ),
              ),
            );
          }
          const outcome: VerificationStore.PresentOutcome = { _tag: "Miss" };
          return outcome;
        }).pipe(once("VerificationStore.present")),

      settle: () => Effect.void,

      // `catchIf(isSqlError)` rather than `catchTag`, because the body's own error type is generic:
      // only a real `SqlError` (BEGIN/COMMIT) becomes the typed outage.
      transaction: (effect) =>
        SqlTransaction.transactional(sql)(effect).pipe(
          Effect.catchIf(isSqlError, storeUnavailable("VerificationStore.transaction")),
        ),

      reserve: (input) =>
        Tenant.resolve(Option.none()).pipe(
          Effect.flatMap((tenantId) =>
            claimQuery({ ...input, tenantId: Option.getOrNull(tenantId) }),
          ),
          Effect.map(Option.isSome),
          traced("VerificationReservations.claim"),
          once("VerificationStore.reserve"),
        ),

      deleteByUser: (userId) =>
        deleteAllByUserQuery(userId).pipe(
          Effect.map((rows) => rows.length),
          traced("VerificationTokens.deleteAllByUser", { userId }),
          write("VerificationStore.deleteByUser"),
        ),

      // CSG-003: consumed rows are kept as replay evidence (BEH-EA-058) until the retention sweep's
      // forensic window passes; a bounded loop of short deletes, tokens then reservations.
      purgeExpired: (before) =>
        Effect.all([
          SqlStore.drainBatches((limit) =>
            deleteExpiredQuery({ cutoff: before, limit }).pipe(
              Effect.map((rows) => rows.length),
              traced("VerificationTokens.deleteExpiredBefore"),
              write("VerificationStore.purgeExpired"),
            ),
          ),
          SqlStore.drainBatches((limit) =>
            deleteExpiredReservationsQuery({ cutoff: before, limit }).pipe(
              Effect.map((rows) => rows.length),
              traced("VerificationReservations.deleteExpiredBefore"),
              write("VerificationStore.purgeExpired"),
            ),
          ),
        ]).pipe(
          Effect.map(([expiredTokens, expiredReservations]) => expiredTokens + expiredReservations),
        ),
    });
  }),
);
