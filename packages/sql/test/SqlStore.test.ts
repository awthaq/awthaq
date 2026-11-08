// Plan 02, phase 1: `SqlStore`, the wrapper every SQL store adapter runs a primitive through.
// A transient failure is retried at the top level only: inside a caller's transaction the retry
// belongs to the caller (a Postgres deadlock aborts the whole transaction, so retrying one
// savepoint would be wrong). The retrying cases run on the real clock (`it.live`): the backoff is
// the production schedule.
import { SqlTransaction } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import * as TestSql from "../../test/src/TestSql.ts";
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

describe("SqlStore.make(sql).write", () => {
  it.live("retries a transient failure at the top level, then succeeds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const probe = flaky(2);
      const result = yield* probe.effect.pipe(SqlStore.make(sql).write("Probe.write"));
      assert.strictEqual(result, "ok");
      assert.strictEqual(probe.state.calls, 3);
    }).pipe(Effect.provide(SqlLive)),
  );

  it.live("gives up as StoreUnavailable naming the operation once the retries are spent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const probe = flaky(100);
      const failure = yield* probe.effect.pipe(
        SqlStore.make(sql).write("Probe.write"),
        Effect.flip,
      );
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
        .withTransaction(probe.effect.pipe(SqlStore.make(sql).write("Probe.write")))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(probe.state.calls, 1);
    }).pipe(Effect.provide(SqlLive)),
  );
});

describe("SqlStore.make(sql).read", () => {
  it.effect("never retries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const probe = flaky(100);
      const failure = yield* probe.effect.pipe(SqlStore.make(sql).read("Probe.read"), Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(probe.state.calls, 1);
    }).pipe(Effect.provide(SqlLive)),
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

// Plan 25 ticket 06 (ADR-EA-041 decision 9): `SqlStore.atomically(sql, key)` is one transaction
// that first takes an exclusive lock named `key`. Two writers naming the same key never interleave
// their read-modify-write; on SQLite the client already runs one transaction at a time. Runs on
// SQLite `:memory:` and, under `pnpm test:pg`, on Postgres (where the lock is what does the work).
describe("SqlStore.atomically", () => {
  const Live = TestSql.layer("sql_SqlStore_atomically");

  const setup = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`DROP TABLE IF EXISTS atomically_counter`);
    yield* sql.unsafe(`CREATE TABLE atomically_counter (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
    yield* sql`INSERT INTO atomically_counter (k, n) VALUES ('a', 0), ('b', 0)`;
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    const note = (entry: string) => Ref.update(log, (entries) => [...entries, entry]);
    /** Read the counter, wait, write it back plus one: a lost update unless it is atomic. */
    const bump = (row: string, label: string) =>
      Effect.gen(function* () {
        const [found] = yield* sql<{
          readonly n: number;
        }>`SELECT n FROM atomically_counter WHERE k = ${row}`;
        yield* note(`${label}:read`);
        yield* Effect.sleep("50 millis");
        yield* sql`UPDATE atomically_counter SET n = ${Number(found?.n ?? 0) + 1} WHERE k = ${row}`;
        yield* note(`${label}:write`);
      });
    const count = (row: string) =>
      Effect.map(
        sql<{ readonly n: number }>`SELECT n FROM atomically_counter WHERE k = ${row}`,
        ([found]) => Number(found?.n ?? -1),
      );
    return { sql, log, bump, count };
  });

  const adjacent = (log: ReadonlyArray<string>, label: string) =>
    log.indexOf(`${label}:write`) === log.indexOf(`${label}:read`) + 1;

  it.live("serialises two read-modify-writes that name the same key", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.all(
        [
          SqlStore.atomically(t.sql, "probe:a")(t.bump("a", "first")),
          SqlStore.atomically(t.sql, "probe:a")(t.bump("a", "second")),
        ],
        { concurrency: "unbounded" },
      );
      const log = yield* Ref.get(t.log);
      assert.isTrue(adjacent(log, "first") && adjacent(log, "second"), log.join(","));
      assert.strictEqual(yield* t.count("a"), 2);
    }).pipe(Effect.provide(Live)),
  );

  it.live("8 writers of one key lose no update", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.all(
        Array.from({ length: 8 }, (_, n) =>
          SqlStore.atomically(t.sql, "probe:a")(t.bump("a", `w${n}`)),
        ),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(yield* t.count("a"), 8);
    }).pipe(Effect.provide(Live)),
  );

  it.live("writers of distinct keys do not wait for each other on Postgres", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.all(
        [
          SqlStore.atomically(t.sql, "probe:a")(t.bump("a", "a")),
          SqlStore.atomically(t.sql, "probe:b")(t.bump("b", "b")),
        ],
        { concurrency: "unbounded" },
      );
      const log = yield* Ref.get(t.log);
      const interleaved = !adjacent(log, "a") || !adjacent(log, "b");
      // Postgres runs both transactions at once; SQLite's client runs one transaction at a time.
      const expected = yield* t.sql.onDialectOrElse({
        pg: () => Effect.succeed(true),
        orElse: () => Effect.succeed(false),
      });
      assert.strictEqual(interleaved, expected, log.join(","));
    }).pipe(Effect.provide(Live)),
  );

  it.live("inside a caller's transaction the lock is held until the outer transaction ends", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const outer = SqlTransaction.transactional(t.sql)(
        Effect.gen(function* () {
          yield* SqlStore.atomically(t.sql, "probe:a")(t.bump("a", "inner"));
          // The savepoint is released, the lock is not: the competitor still waits.
          yield* Effect.sleep("50 millis");
          yield* Ref.update(t.log, (entries) => [...entries, "outer:end"]);
        }),
      );
      const competitor = Effect.andThen(
        Effect.sleep("10 millis"),
        SqlStore.atomically(t.sql, "probe:a")(t.bump("a", "competitor")),
      );
      yield* Effect.all([outer, competitor], { concurrency: "unbounded" });
      const log = yield* Ref.get(t.log);
      assert.isTrue(log.indexOf("competitor:read") > log.indexOf("outer:end"), log.join(","));
      assert.strictEqual(yield* t.count("a"), 2);
    }).pipe(Effect.provide(Live)),
  );

  it.live("a failure rolls the unit back and releases the lock", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const failed = yield* SqlStore.atomically(
        t.sql,
        "probe:a",
      )(Effect.andThen(t.bump("a", "doomed"), Effect.fail("refused"))).pipe(Effect.flip);
      assert.strictEqual(failed, "refused");
      assert.strictEqual(yield* t.count("a"), 0);
      yield* SqlStore.atomically(t.sql, "probe:a")(t.bump("a", "next"));
      assert.strictEqual(yield* t.count("a"), 1);
    }).pipe(Effect.provide(Live)),
  );
});
