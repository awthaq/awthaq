// spec/behaviors/14-rate-limiting.md, BEH-EA-105/109 (RBS-004): the shared SQL
// `RateLimiterStore`, against a real in-memory SQLite database.
import { RateLimiter } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as RateLimiterStoreSql from "../src/RateLimiterStoreSql.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(RateLimiterStoreSql.migrate).pipe(Layer.provide(SqlLive));

const StoreLive = RateLimiterStoreSql.layerStoreSql.pipe(
  Layer.provideMerge(Migrated),
  Layer.provideMerge(SqlLive),
);

const window = Duration.seconds(10);

describe("RateLimiterStoreSql (BEH-EA-105/109)", () => {
  it.effect("20 concurrent increments of one key return counts 1..20", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const buckets = yield* Effect.all(
        Array.from({ length: 20 }, () => store.increment("signin:alice", window)),
        { concurrency: "unbounded" },
      );
      const counts = buckets.map((bucket) => bucket.count).sort((a, b) => a - b);
      assert.deepStrictEqual(
        counts,
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
    }).pipe(Effect.provide(StoreLive)),
  );

  it.effect("different keys are independent buckets", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      yield* store.increment("a", window);
      yield* store.increment("a", window);
      assert.strictEqual((yield* store.increment("b", window)).count, 1);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.effect("a window rollover resets the count to 1", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const first = yield* store.increment("k", window);
      assert.strictEqual((yield* store.increment("k", window)).count, 2);
      yield* TestClock.adjust(Duration.seconds(10));
      const after = yield* store.increment("k", window);
      assert.strictEqual(after.count, 1);
      assert.isTrue(after.resetAt.epochMilliseconds > first.resetAt.epochMilliseconds);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.effect("drives RateLimiter.layer end to end: admits up to the limit, then rejects", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      const input = { key: "signin:carol", limit: 2, window };
      yield* limiter.consume(input);
      yield* limiter.consume(input);
      const failure = yield* limiter.consume(input).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimitExceeded");
      assert.isTrue(failure.retryAfterMillis > 0 && failure.retryAfterMillis <= 10_000);
    }).pipe(Effect.provide(RateLimiter.layer.pipe(Layer.provide(StoreLive)))),
  );

  it.effect("peek reads a live bucket without advancing it, and sees nothing once expired", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      assert.isTrue(Option.isNone(yield* store.peek("k")));
      yield* store.increment("k", window);
      const seen = yield* store.peek("k");
      assert.strictEqual(Option.getOrThrow(seen).count, 1);
      assert.strictEqual((yield* store.increment("k", window)).count, 2);
      yield* TestClock.adjust(window);
      assert.isTrue(Option.isNone(yield* store.peek("k")));
    }).pipe(Effect.provide(StoreLive)),
  );

  it.effect("escalation doubles the wait in the second limited window over the SQL store", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      const input = {
        key: "signin:mallory",
        limit: 1,
        window,
        escalation: { factor: 2, maxPenalty: Duration.minutes(5) },
      };
      yield* limiter.consume(input);
      yield* limiter.consume(input).pipe(Effect.flip);
      yield* TestClock.adjust(window);
      yield* limiter.consume(input);
      const second = yield* limiter.consume(input).pipe(Effect.flip);
      assert.strictEqual(second.retryAfterMillis, 20_000);
    }).pipe(Effect.provide(RateLimiter.layer.pipe(Layer.provide(StoreLive)))),
  );

  it.effect("the sweeper deletes expired rows", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.increment("gone", window);
      yield* TestClock.adjust(Duration.seconds(61));
      const rows = yield* sql`SELECT bucket_key FROM rate_limit_buckets`;
      assert.strictEqual(rows.length, 0);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.effect("a missing table surfaces as RateLimiterStoreUnavailable, not a defect", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const failure = yield* store.increment("k", window).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimiterStoreUnavailable");
    }).pipe(Effect.provide(RateLimiterStoreSql.layerStoreSql.pipe(Layer.provide(SqlLive)))),
  );
});
