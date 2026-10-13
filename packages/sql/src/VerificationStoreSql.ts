// @awthaq/sql — VerificationStoreSql
//
// Plan 02 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `VerificationStore`, over the token and
// reservation repositories (ADR-EA-016: the partial unique index on `(identifier) WHERE "consumedAt"
// IS NULL` is what makes `upsertLive` atomic, and a conditional upsert is what makes `reserve`
// exclusive).
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

import { SqlTransaction, VerificationStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";
import type { VerificationToken } from "./Models.ts";
import { VerificationRepository, VerificationReservationsRepository } from "./Repositories.ts";
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

/** The SQL adapter. Requires both repositories and the client its transaction runs on. */
export const layer = Layer.effect(
  VerificationStore.VerificationStore,
  Effect.gen(function* () {
    const tokens = yield* VerificationRepository;
    const reservations = yield* VerificationReservationsRepository;
    const sql = yield* SqlClient.SqlClient;
    const { write, once } = SqlStore.make(sql);

    const upsertLive: VerificationStore.VerificationStoreShape["upsertLive"] = (row) =>
      tokens
        .upsertLive({
          id: row.id,
          identifier: row.identifier,
          userId: Option.getOrNull(row.userId),
          valueHash: row.valueHash,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          payload: Option.getOrElse(row.payloadJson, () => NO_PAYLOAD),
          maxAttempts: Option.getOrNull(row.maxAttempts),
          attempts: 0,
        })
        .pipe(Effect.map(toTokenRow), write("VerificationStore.upsertLive"));

    const present: VerificationStore.VerificationStoreShape["present"] = ({
      identifier,
      valueHash,
      now,
    }) =>
      Effect.gen(function* () {
        // SOS-004: judge the live row first, so a miss is charged to it and to nothing newer.
        const judged = yield* tokens.findByIdentifier(identifier);
        // BEH-EA-058/062: one atomic `UPDATE ... RETURNING` decides win or lose: no separate read
        // racing this call's own write, the same guarantee the `Ref` adapter's `Ref.modify` gives.
        const claimed = yield* tokens.tryConsume({ identifier, valueHash, now });
        if (Option.isSome(claimed)) {
          const outcome: VerificationStore.PresentOutcome = {
            _tag: "Hit",
            row: toTokenRow(claimed.value),
          };
          return outcome;
        }
        if (Option.isSome(judged)) {
          yield* SqlTransaction.afterUnit(
            tokens
              .recordFailedAttempt({ id: judged.value.id, now })
              .pipe(
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
      }).pipe(once("VerificationStore.present"));

    const reserve: VerificationStore.VerificationStoreShape["reserve"] = (input) =>
      reservations.claim(input).pipe(once("VerificationStore.reserve"));

    const deleteByUser: VerificationStore.VerificationStoreShape["deleteByUser"] = (userId) =>
      tokens.deleteAllByUser(userId).pipe(write("VerificationStore.deleteByUser"));

    // CSG-003: consumed rows are kept as replay evidence (BEH-EA-058) until the retention sweep's
    // forensic window passes; a bounded loop of short deletes, tokens then reservations.
    const purgeExpired: VerificationStore.VerificationStoreShape["purgeExpired"] = (before) =>
      Effect.all([
        SqlStore.drainBatches((limit) =>
          tokens.deleteExpiredBefore(before, limit).pipe(write("VerificationStore.purgeExpired")),
        ),
        SqlStore.drainBatches((limit) =>
          reservations
            .deleteExpiredBefore(before, limit)
            .pipe(write("VerificationStore.purgeExpired")),
        ),
      ]).pipe(
        Effect.map(([expiredTokens, expiredReservations]) => expiredTokens + expiredReservations),
      );

    return VerificationStore.VerificationStore.of({
      upsertLive,
      present,
      settle: () => Effect.void,
      // `catchIf(isSqlError)` rather than `catchTag`, because the body's own error type is generic:
      // only a real `SqlError` (BEGIN/COMMIT) becomes the typed outage.
      transaction: (effect) =>
        SqlTransaction.transactional(sql)(effect).pipe(
          Effect.catchIf(isSqlError, storeUnavailable("VerificationStore.transaction")),
        ),
      reserve,
      deleteByUser,
      purgeExpired,
    });
  }),
);
