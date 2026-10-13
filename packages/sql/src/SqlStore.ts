// @awthaq/sql — SqlStore
//
// Plan 02 (ADR-EA-041): what every SQL store adapter (`SessionStoreSql`, `UserStoreSql`,
// `AccountStoreSql`, `VerificationStoreSql`, `AuditLogStoreSql`) does around one store primitive,
// written once. It is a thin layer over `StoreFailure` (plan 05), not a second classification of
// `SqlError`:
//
// - `write(operation)`: an outage is `StoreUnavailable` (cause logged once), a row that no longer
//   decodes or a `RETURNING` that returned no row is a defect, and a transient failure is retried
//   as one whole unit, but only at the top level. Inside a caller's transaction the retry belongs
//   to the caller: a Postgres deadlock aborts the whole transaction, so retrying one savepoint
//   would be wrong (ADR-EA-028, "Transient retry").
// - `read(operation)` (alias `once`): the same classification, never retried (a read has no unit to
//   repeat; neither has a write whose repetition would change its answer).
// - `drainBatches`: a retention delete as a loop of bounded statements (CSG-003/ALF-010).
//
// A primitive that changes what a replica-eligible listing returns passes `{ capture: true }`, so
// the writing fiber's next eventual read sees its own write (ADR-EA-024, `ReadRouting.captureToken`).

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ReadRouting from "./ReadRouting.ts";
import { orStoreUnavailable, retryTransient } from "./StoreFailure.ts";

/** Rows deleted per statement. */
const PURGE_BATCH = 1000;

/**
 * CSG-003/ALF-010: retention deletes run as a loop of bounded statements, never one unbounded
 * `DELETE` holding locks over a large backlog. Runs `step` (which deletes at most `limit` rows and
 * resolves to how many it deleted) until a batch comes back short, and resolves to the total.
 */
export const drainBatches = <E, R = never>(
  step: (limit: number) => Effect.Effect<number, E, R>,
  limit: number = PURGE_BATCH,
): Effect.Effect<number, E, R> =>
  Effect.gen(function* () {
    let total = 0;
    while (true) {
      const deleted = yield* step(limit);
      total += deleted;
      if (deleted < limit) return total;
    }
  });

/**
 * Binds the wrappers to the client an adapter was built over, so a store primitive's own
 * requirement stays empty (the port declares none).
 */
export const make = (sql: SqlClient.SqlClient) => {
  /** Whether the calling fiber is inside a `SqlClient` transaction (a savepoint would nest). */
  const insideTransaction = Effect.map(Effect.serviceOption(sql.transactionService), Option.isSome);

  /** A store write: classified like `orStoreUnavailable`, retried on a transient failure at the top level only. */
  const write =
    (operation: string, options?: { readonly capture?: boolean }) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      Effect.flatMap(insideTransaction, (nested) => {
        const attempt = nested ? self : retryTransient()(self);
        return orStoreUnavailable(operation)(
          options?.capture === true ? ReadRouting.captureTokenOn(sql)(attempt) : attempt,
        );
      });

  /**
   * A store read: classified like `orStoreUnavailable`, never retried. Also the wrapper for a write
   * that is not safe to repeat (a presentation that succeeded but was not acknowledged would come
   * back as a miss), which is why it is exported as `once` too.
   */
  const read =
    (operation: string, options?: { readonly capture?: boolean }) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      orStoreUnavailable(operation)(
        options?.capture === true ? ReadRouting.captureTokenOn(sql)(self) : self,
      );

  return { write, read, once: read };
};
