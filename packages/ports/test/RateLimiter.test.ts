// See src/RateLimiter.ts's own header comment for what this port is
// grounded in — spec/behaviors/14-rate-limiting.md, BEH-EA-105/106/109/112.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as RateLimiter from "../src/RateLimiter.ts";

const MemoryLive = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

describe("RateLimiter.layer + layerStoreMemory (BEH-EA-105/106)", () => {
  it.effect("admits up to the limit, then fails with RateLimited carrying retryAfterMillis", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      const input = { key: "signin:alice", limit: 2, window: Duration.seconds(10) };
      yield* limiter.consume(input);
      yield* limiter.consume(input);
      const failure = yield* limiter.consume(input).pipe(Effect.flip);
      // RBS-010: the port's own error must not share the wire error's `RateLimited` tag,
      // and must not carry the raw bucket key (emails, IPs).
      assert.strictEqual(failure._tag, "RateLimitExceeded");
      assert.isFalse("key" in failure);
      assert.isTrue(failure.retryAfterMillis > 0);
      assert.isTrue(failure.retryAfterMillis <= 10_000);
    }).pipe(Effect.provide(MemoryLive)),
  );

  it.effect("two different keys are independent buckets", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      yield* limiter.consume({ key: "signin:alice", limit: 1, window: Duration.seconds(10) });
      // alice is now at the limit; bob's own bucket is untouched.
      yield* limiter.consume({ key: "signin:bob", limit: 1, window: Duration.seconds(10) });
      yield* limiter
        .consume({ key: "signin:alice", limit: 1, window: Duration.seconds(10) })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(MemoryLive)),
  );

  it.effect("BEH-EA-105: a fixed window resets once it elapses", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      const input = { key: "signin:carol", limit: 1, window: Duration.seconds(10) };
      yield* limiter.consume(input);
      yield* limiter.consume(input).pipe(Effect.flip);
      yield* TestClock.adjust(Duration.seconds(10));
      yield* limiter.consume(input);
    }).pipe(Effect.provide(MemoryLive)),
  );
});

describe("RateLimiter.layerStoreMemoryWith (RBS-003 bounded memory store)", () => {
  const window = Duration.seconds(10);

  it.effect("the sweeper reclaims expired buckets without the same key being re-used", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const stats = yield* RateLimiter.RateLimiterMemoryStats;
      yield* Effect.forEach(["a", "b", "c"], (key) => store.increment(key, window));
      assert.strictEqual(yield* stats.size, 3);
      // The window (10s) has elapsed, plus one sweep interval (1 minute default).
      yield* TestClock.adjust(Duration.seconds(61));
      assert.strictEqual(yield* stats.size, 0);
    }).pipe(Effect.provide(RateLimiter.layerStoreMemory)),
  );

  it.effect("the sweeper keeps buckets whose window has not elapsed", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const stats = yield* RateLimiter.RateLimiterMemoryStats;
      yield* store.increment("short", Duration.seconds(5));
      yield* store.increment("long", Duration.minutes(10));
      yield* TestClock.adjust(Duration.seconds(61));
      assert.strictEqual(yield* stats.size, 1);
    }).pipe(Effect.provide(RateLimiter.layerStoreMemory)),
  );

  it.effect("spraying distinct keys past maxBuckets evicts the earliest-expiring bucket", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const stats = yield* RateLimiter.RateLimiterMemoryStats;
      yield* store.increment("soonest", Duration.seconds(10));
      yield* store.increment("middle", Duration.seconds(20));
      yield* store.increment("latest", Duration.seconds(30));
      assert.strictEqual(yield* stats.size, 3);
      yield* store.increment("intruder", Duration.seconds(30));
      assert.strictEqual(yield* stats.size, 3);
      // "soonest" was evicted, so it starts a fresh bucket; "latest" survived and keeps counting.
      assert.strictEqual((yield* store.increment("soonest", Duration.seconds(10))).count, 1);
      assert.strictEqual((yield* store.increment("latest", Duration.seconds(30))).count, 2);
    }).pipe(
      Effect.provide(
        RateLimiter.layerStoreMemoryWith({
          maxBuckets: 3,
          sweepInterval: Duration.minutes(1),
        }),
      ),
    ),
  );

  it.effect("size never exceeds maxBuckets however many distinct keys arrive", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const stats = yield* RateLimiter.RateLimiterMemoryStats;
      for (let i = 0; i < 200; i++) {
        yield* store.increment(`attacker:${i}`, window);
        assert.isTrue((yield* stats.size) <= 10);
      }
    }).pipe(
      Effect.provide(
        RateLimiter.layerStoreMemoryWith({
          maxBuckets: 10,
          sweepInterval: Duration.minutes(1),
        }),
      ),
    ),
  );

  it.effect("an existing key is never evicted to make room for itself", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const stats = yield* RateLimiter.RateLimiterMemoryStats;
      yield* store.increment("a", window);
      yield* store.increment("b", window);
      assert.strictEqual((yield* store.increment("a", window)).count, 2);
      assert.strictEqual(yield* stats.size, 2);
    }).pipe(
      Effect.provide(
        RateLimiter.layerStoreMemoryWith({
          maxBuckets: 2,
          sweepInterval: Duration.minutes(1),
        }),
      ),
    ),
  );
});

describe("RateLimiter.layer store outage (RBS-004, BEH-EA-105)", () => {
  const DownStore = Layer.succeed(
    RateLimiter.RateLimiterStore,
    RateLimiter.RateLimiterStore.of({
      increment: () => Effect.fail(new RateLimiter.RateLimiterStoreUnavailable({ cause: "down" })),
    }),
  );
  const input = { key: "signin:alice", limit: 1, window: Duration.seconds(10) };

  it.effect("fails open and logs a warning by default when the store is unavailable", () =>
    Effect.gen(function* () {
      const messages: Array<string> = [];
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") messages.push(String(options.message));
      });
      const limiter = yield* RateLimiter.RateLimiter;
      yield* limiter.consume(input).pipe(Effect.provide(Logger.layer([capture])));
      assert.strictEqual(messages.length, 1);
      // BEH-EA-108: the log line must not leak the bucket key (emails, IPs).
      assert.isFalse(messages.some((message) => message.includes("alice")));
    }).pipe(Effect.provide(RateLimiter.layer.pipe(Layer.provide(DownStore)))),
  );

  it.effect("the reject policy fails RateLimitExceeded with the configured retry hint", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      const failure = yield* limiter.consume(input).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimitExceeded");
      assert.strictEqual(failure.retryAfterMillis, 2_000);
    }).pipe(
      Effect.provide(
        RateLimiter.layer.pipe(
          Layer.provide(DownStore),
          Layer.provide(
            RateLimiter.config({
              onStoreUnavailable: "reject",
              unavailableRetryAfter: Duration.seconds(2),
            }),
          ),
        ),
      ),
    ),
  );
});

describe("RateLimiter.layerPermissive (BEH-EA-112)", () => {
  it.effect("never rejects, no matter how many times it is consumed", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      for (let i = 0; i < 50; i++) {
        yield* limiter.consume({ key: "loop", limit: 3, window: Duration.seconds(10) });
      }
    }).pipe(Effect.provide(RateLimiter.layerPermissive)),
  );
});
