// Test support (plan 16): a SQLite `SqlClient` whose statements can be made to fail, so an adapter's
// failure mapping and retries are tested at the seam a database outage really crosses (the SQL
// client), not through a double of an internal repository. `@awthaq/sql`'s tests cannot import
// `@awthaq/test` (it depends on `@awthaq/sql`), so the helper lives here beside `RotatingKeys.ts`.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Connection from "effect/unstable/sql/SqlConnection";
import { SqlError, type SqlErrorReason } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

export interface Faults {
  /** The next `count` statements whose SQL matches `matching` fail with `reason` (default: any statement). */
  readonly failNext: (input: {
    readonly count: number;
    readonly reason: SqlErrorReason;
    readonly matching?: RegExp;
  }) => Effect.Effect<void>;
  /** How many statements matching `pattern` were attempted since the last `reset`. */
  readonly attempts: (pattern: RegExp) => Effect.Effect<number>;
  /** Forgets every pending fault and every recorded attempt. */
  readonly reset: Effect.Effect<void>;
}

export class FaultControl extends Context.Service<FaultControl, Faults>()(
  "test/sql/FaultControl",
) {}

interface Plan {
  remaining: number;
  readonly reason: SqlErrorReason;
  readonly matching: RegExp | undefined;
}

interface State {
  readonly plans: ReadonlyArray<Plan>;
  readonly seen: ReadonlyArray<string>;
}

const empty: State = { plans: [], seen: [] };

/**
 * Wraps a real SQLite client: `SqlClient.make` over `real.reserve`, every `Connection.execute*`
 * checked against the plan first. Transaction control statements pass through the same check, so a
 * plan with no `matching` also fails `BEGIN`.
 */
export const layer = <E, R>(real: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const inner = yield* SqlClient.SqlClient;
      const state = yield* Ref.make(empty);

      const gate = (sql: string): Effect.Effect<void, SqlError> =>
        Ref.modify(state, (current): readonly [SqlErrorReason | undefined, State] => {
          const seen = [...current.seen, sql];
          const hit = current.plans.find(
            (plan) =>
              plan.remaining > 0 && (plan.matching === undefined || plan.matching.test(sql)),
          );
          if (hit === undefined) {
            return [undefined, { plans: current.plans, seen }];
          }
          hit.remaining -= 1;
          return [hit.reason, { plans: current.plans.filter((p) => p.remaining > 0), seen }];
        }).pipe(
          Effect.flatMap((reason) =>
            reason === undefined ? Effect.void : Effect.fail(new SqlError({ reason })),
          ),
        );

      const decorate = (connection: Connection.Connection): Connection.Connection => ({
        execute: (sql, params, transform) =>
          Effect.andThen(gate(sql), connection.execute(sql, params, transform)),
        executeRaw: (sql, params) => Effect.andThen(gate(sql), connection.executeRaw(sql, params)),
        executeStream: connection.executeStream,
        executeValues: (sql, params) =>
          Effect.andThen(gate(sql), connection.executeValues(sql, params)),
        executeValuesUnprepared: (sql, params) =>
          Effect.andThen(gate(sql), connection.executeValuesUnprepared(sql, params)),
        executeUnprepared: (sql, params, transform) =>
          Effect.andThen(gate(sql), connection.executeUnprepared(sql, params, transform)),
      });

      const client = yield* SqlClient.make({
        acquirer: Effect.map(inner.reserve, decorate),
        compiler: Statement.makeCompilerSqlite(),
        beginTransaction: "BEGIN IMMEDIATE",
        spanAttributes: [],
      });

      const faults = FaultControl.of({
        failNext: ({ count, reason, matching }) =>
          Ref.update(state, (current) => ({
            plans: [...current.plans, { remaining: count, reason, matching }],
            seen: current.seen,
          })),
        attempts: (pattern) =>
          Effect.map(
            Ref.get(state),
            (current) => current.seen.filter((sql) => pattern.test(sql)).length,
          ),
        reset: Ref.set(state, empty),
      });

      return Context.make(SqlClient.SqlClient, client).pipe(Context.add(FaultControl, faults));
    }),
  ).pipe(Layer.provide(real), Layer.provide(Reactivity.layer));
