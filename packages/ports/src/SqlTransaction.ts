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
   */
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

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
      withTransaction: (effect) => sql.withTransaction(effect),
    });
  }),
);
