// @awthaq/test — the rateLimiterStore suite of StoreContract (plan 37)
//
// BEH-EA-105/109 (RBS-004/009): `increment` is the one atomic primitive a rate limiter's correctness
// rests on; a store that reads then writes lets concurrent callers exceed a limit.
import assert from "node:assert/strict";
import { RateLimiter } from "@awthaq/ports";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { CONCURRENCY, race } from "../contract.ts";
import { suite } from "./suite.ts";

const window = Duration.seconds(10);

/** The `RateLimiterStore` contract: an atomic fixed-window counter per key, and a read that never advances it. */
export const rateLimiterStore = suite(RateLimiter.RateLimiterStore, {
  operations: {
    increment: {
      atomic: [
        {
          name: "the first increment of a key is count 1, reset at now plus the window",
          run: Effect.gen(function* () {
            const store = yield* RateLimiter.RateLimiterStore;
            const bucket = yield* store.increment("k", window);
            assert.equal(bucket.count, 1);
            assert.equal(bucket.resetAt.epochMilliseconds, Duration.toMillis(window));
          }),
        },
        {
          name: "different keys are independent buckets",
          run: Effect.gen(function* () {
            const store = yield* RateLimiter.RateLimiterStore;
            yield* store.increment("a", window);
            yield* store.increment("a", window);
            assert.equal((yield* store.increment("b", window)).count, 1);
          }),
        },
        {
          name: "once the window has elapsed the next increment is count 1 with a later resetAt",
          run: Effect.gen(function* () {
            const store = yield* RateLimiter.RateLimiterStore;
            const first = yield* store.increment("k", window);
            assert.equal((yield* store.increment("k", window)).count, 2);
            yield* TestClock.adjust(window);
            const after = yield* store.increment("k", window);
            assert.equal(after.count, 1);
            assert.equal(after.resetAt.epochMilliseconds > first.resetAt.epochMilliseconds, true);
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent increments of one key return counts 1..8",
          run: Effect.gen(function* () {
            const store = yield* RateLimiter.RateLimiterStore;
            const buckets = yield* race(store.increment("signin:alice", window));
            const counts = buckets.map((bucket) => bucket.count).sort((a, b) => a - b);
            assert.deepEqual(
              counts,
              Array.from({ length: CONCURRENCY }, (_, i) => i + 1),
            );
          }),
        },
      ],
    },
    peek: {
      read: [
        {
          name: "peek is None for an absent key, reads a live bucket without advancing it, and is None once its window has elapsed",
          run: Effect.gen(function* () {
            const store = yield* RateLimiter.RateLimiterStore;
            assert.equal(Option.isNone(yield* store.peek("k")), true);
            yield* store.increment("k", window);
            assert.equal(Option.getOrThrow(yield* store.peek("k")).count, 1);
            assert.equal((yield* store.increment("k", window)).count, 2);
            yield* TestClock.adjust(window);
            assert.equal(Option.isNone(yield* store.peek("k")), true);
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "the sweeper deletes expired rows",
      run: Effect.gen(function* () {
        const store = yield* RateLimiter.RateLimiterStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.increment("gone", window);
        yield* TestClock.adjust(Duration.seconds(61));
        const rows = yield* sql`SELECT bucket_key FROM rate_limit_buckets`;
        assert.equal(rows.length, 0);
      }),
    },
    {
      name: "a missing table surfaces as RateLimiterStoreUnavailable, not a defect",
      run: Effect.gen(function* () {
        const store = yield* RateLimiter.RateLimiterStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("DROP TABLE rate_limit_buckets");
        const failure = yield* store.increment("k", window).pipe(Effect.flip);
        assert.equal(failure._tag, "RateLimiterStoreUnavailable");
      }),
    },
  ],
});
