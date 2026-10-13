// Plan 02, phase 1: `SqlStore`, the wrapper every SQL store adapter runs a primitive through.
// A transient failure is retried at the top level only: inside a caller's transaction the retry
// belongs to the caller (a Postgres deadlock aborts the whole transaction, so retrying one
// savepoint would be wrong). The retrying cases run on the real clock (`it.live`): the backoff is
// the production schedule.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
import * as SqlStore from "../src/SqlStore.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const transient = () => new SqlError({ reason: new ConnectionError({ cause: new Error("down") }) });

/** Fails `failures` times with a retryable error, then succeeds; `calls` says how often it ran. */
const flaky = (failures: number) => {
  const state = { calls: 0 };
  const effect = Effect.suspend(() => {
    state.calls += 1;
    return state.calls <= failures ? Effect.fail(transient()) : Effect.succeed("ok");
  });
  return { state, effect };
};

describe("SqlStore.write", () => {
  it.live("retries a transient failure at the top level, then succeeds", () =>
    Effect.gen(function* () {
      const probe = flaky(2);
      const result = yield* probe.effect.pipe(SqlStore.write("Probe.write"));
      assert.strictEqual(result, "ok");
      assert.strictEqual(probe.state.calls, 3);
    }).pipe(Effect.provide(SqlLive)),
  );

  it.live("gives up as StoreUnavailable naming the operation once the retries are spent", () =>
    Effect.gen(function* () {
      const probe = flaky(100);
      const failure = yield* probe.effect.pipe(SqlStore.write("Probe.write"), Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(failure.operation, "Probe.write");
      assert.strictEqual(probe.state.calls, 4);
    }).pipe(Effect.provide(SqlLive)),
  );

  it.live("does not retry inside a caller's transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const probe = flaky(100);
      const failure = yield* sql
        .withTransaction(probe.effect.pipe(SqlStore.write("Probe.write")))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(probe.state.calls, 1);
    }).pipe(Effect.provide(SqlLive)),
  );
});

describe("SqlStore.read", () => {
  it.effect("never retries", () =>
    Effect.gen(function* () {
      const probe = flaky(100);
      const failure = yield* probe.effect.pipe(SqlStore.read("Probe.read"), Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(probe.state.calls, 1);
    }),
  );
});

describe("SqlStore.drainBatches", () => {
  it.effect("runs bounded steps until one comes back short and totals them", () =>
    Effect.gen(function* () {
      const remaining = { rows: 2500 };
      const total = yield* SqlStore.drainBatches((limit) =>
        Effect.sync(() => {
          const deleted = Math.min(limit, remaining.rows);
          remaining.rows -= deleted;
          return deleted;
        }),
      );
      assert.strictEqual(total, 2500);
      assert.strictEqual(remaining.rows, 0);
    }),
  );
});
