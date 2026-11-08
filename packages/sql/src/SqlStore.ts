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
// - `atomically(sql, key)`: one primitive's read-modify-write as one transaction holding a lock
//   named by the invariant's scope (plan 25, ADR-EA-041 decision 9).
//
// A primitive that changes what a replica-eligible listing returns passes `{ capture: true }`, so
// the writing fiber's next eventual read sees its own write (ADR-EA-024, `ReadRouting.captureToken`).

import { SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
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
 * Plan 25 (ADR-EA-041 decision 9): `effect` runs in one transaction (a savepoint inside a caller's,
 * ADR-EA-037) that first takes an exclusive lock named `key`, held until the outermost transaction
 * ends. Every writer that names the same key is serialised, so an invariant over several rows (an
 * organization's owners, a quota, the team forest) is read and written as one step. Postgres needs
 * this because READ COMMITTED lets two transactions each see the other's rows unchanged, and a
 * `FOR UPDATE` on existing rows locks nothing when the scope has none yet:
 * `pg_advisory_xact_lock(hashtextextended(key, 0))`. A hash collision only adds serialisation. SQLite
 * takes no lock: a client runs one transaction at a time (its transaction acquirer holds a one-permit
 * semaphore), and a second writer process gets `SQLITE_BUSY` (a transient `StoreUnavailable`), never
 * a skewed read.
 *
 * Keys are `<table>:<scope>:<id>`, e.g. `organization_membership:org:<organizationId>`. The lock is
 * only reachable through this wrapper, so it cannot be taken outside the transaction it guards.
 */
export const atomically =
  (sql: SqlClient.SqlClient, key: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    SqlTransaction.transactional(sql)(
      Effect.andThen(
        sql.onDialectOrElse({
          pg: () => Effect.asVoid(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`),
          orElse: () => Effect.void,
        }),
        effect,
      ),
    );

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
