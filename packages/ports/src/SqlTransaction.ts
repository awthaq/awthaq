// @awthaq/ports — SqlTransaction
//
// Shipping-gap map (.scratch/shipping-gaps), ticket 16. A port — not a
// bare `SqlClient.withTransaction` call scattered at each call site —
// specifically so a backend that has no real transaction to offer (an
// in-memory `Ref`-backed composition, where every write already lands
// atomically in one `Ref.modify` step) can satisfy the same interface
// with a no-op passthrough, matching the `PasswordHasher`/`Mailer`/
// `RateLimiter` port convention this codebase already establishes for
// exactly this "real backend needs it, memory backend has nothing to
// wrap" shape.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface SqlTransactionShape {
  /**
   * Runs `effect` inside one real transaction when the backend has one; a
   * no-op wrapper otherwise. `SqlError` joins the error channel
   * unconditionally — even `layerNoop` declares it, so a caller written
   * against this port doesn't silently lose that error type the moment a
   * composition swaps in the real, `SqlError`-capable implementation.
   *
   * A real transaction also installs a `UnitOfWork` (ADR-EA-037): work handed to
   * `SqlTransaction.onCommit`/`afterUnit` inside `effect` is released after the commit.
   */
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

/**
 * ADR-EA-037: the ambient unit of work. Anything that must not happen unless a transaction
 * commits (telling a live subscriber about a state change, running a host's observe tap) or
 * must happen whether or not it commits (the forensic record of a failed attempt) is handed
 * to one of two lanes instead of being run inline.
 */
export interface UnitOfWorkShape {
  /**
   * Runs `effect` once the enclosing unit has committed, and never if it rolls back. A nested
   * unit (a savepoint) hands its commit lane to its parent on success and drops it on rollback,
   * so the work only runs when the *outermost* unit commits. Immediately when there is no unit.
   */
  readonly onCommit: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /**
   * Runs `effect` once the *outermost* unit has ended, committed or not, outside any
   * transaction. Immediately when there is no unit. For facts about an attempt that must
   * survive a rollback: a write made here lands on its own connection and commits by itself.
   */
  readonly afterUnit: (effect: Effect.Effect<void>) => Effect.Effect<void>;
}

const noUnit: UnitOfWorkShape = {
  onCommit: (effect) => effect,
  afterUnit: (effect) => effect,
};

/**
 * The ambient unit of work. The default is no unit, so both lanes run now: the honest answer
 * for a composition with no real transaction (`layerNoop`, the memory stores), whose writes
 * are not rolled back either, so holding the work back would hide a write that did happen.
 */
export const UnitOfWork = Context.Reference<UnitOfWorkShape>(
  "awthaq/ports/SqlTransaction/UnitOfWork",
  {
    defaultValue: () => noUnit,
  },
);

/** Defers `effect` until the enclosing unit commits; drops it on rollback; runs it now outside any unit. */
export const onCommit = (effect: Effect.Effect<void>) =>
  Effect.flatMap(Effect.service(UnitOfWork), (unit) => unit.onCommit(effect));

/** Defers `effect` until the outermost unit has ended, committed or not; runs it now outside any unit. */
export const afterUnit = (effect: Effect.Effect<void>) =>
  Effect.flatMap(Effect.service(UnitOfWork), (unit) => unit.afterUnit(effect));

/**
 * The one way to open a real transaction in awthaq: `sql.withTransaction` plus a unit-of-work
 * buffer. A nested call (a savepoint) hands its commit lane to the parent on success and
 * drops it on rollback; its `afterUnit` lane always goes to the parent. Only the outermost
 * call runs the lanes: `onCommit` work after a successful COMMIT, then `afterUnit` work after
 * the transaction has ended either way.
 */
export const transactional =
  (sql: Pick<SqlClient.SqlClient, "withTransaction">) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* UnitOfWork;
        const committed: Array<Effect.Effect<void>> = [];
        const always: Array<Effect.Effect<void>> = [];
        const unit: UnitOfWorkShape = {
          onCommit: (deferred) =>
            Effect.sync(() => {
              committed.push(deferred);
            }),
          afterUnit: (deferred) =>
            Effect.sync(() => {
              always.push(deferred);
            }),
        };
        const exit = yield* Effect.exit(
          sql.withTransaction(restore(Effect.provideService(effect, UnitOfWork, unit))),
        );
        // A success exit means COMMIT (outermost) or a kept savepoint (nested); a failed COMMIT
        // surfaces as a failure, so `committed` is dropped for every rolled-back unit.
        // The lanes run interruptibly: a deferred observe tap is host code and must not make the
        // fiber unkillable. A fiber interrupted between the end of the transaction and a lane loses
        // that lane's work: a bus copy (the bus is at-most-once anyway) or an attempt event's audit
        // row (the same exposure an inline write had to an interrupt).
        if (Exit.isSuccess(exit)) {
          for (const deferred of committed) yield* restore(parent.onCommit(deferred));
        }
        for (const deferred of always) yield* restore(parent.afterUnit(deferred));
        return yield* exit;
      }),
    );

export class SqlTransaction extends Context.Service<SqlTransaction, SqlTransactionShape>()(
  "awthaq/ports/SqlTransaction",
) {}

/**
 * For an in-memory composition — every write already lands atomically in its
 * own `Ref.modify`, so there is nothing this port needs to wrap.
 *
 * DRS-006/INV-EA-017: its atomicity holds *per `Ref`* only — a multi-table
 * transaction (OAuth's just-in-time create-and-link, say) can still orphan a
 * user in a memory composition if the second write dies. Acceptable for
 * development and tests, never for production; and a real `layerSql`
 * transaction is likewise only atomic across tables in one logical database,
 * which is why the core identity tables must share a transaction domain.
 */
export const layerNoop: Layer.Layer<SqlTransaction> = Layer.succeed(
  SqlTransaction,
  SqlTransaction.of({ withTransaction: (effect) => effect }),
);

/** A real transaction, via the ambient `SqlClient`. */
export const layerSql: Layer.Layer<SqlTransaction, never, SqlClient.SqlClient> = Layer.effect(
  SqlTransaction,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return SqlTransaction.of({
      withTransaction: transactional(sql),
    });
  }),
);
