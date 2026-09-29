// ECF-002 / JJS-002 / KRS-010 — single-flight, TTL, rate-limited refresh on a
// miss, and negative caching. Time is `TestClock`-driven.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as RefreshingCache from "../src/RefreshingCache.ts";

const options = { ttl: Duration.minutes(10), minRefetchInterval: Duration.seconds(30) };

// A loader that counts how many times it really ran and can be told to fail.
const counting = Effect.gen(function* () {
  const calls = yield* Ref.make(0);
  const failing = yield* Ref.make(false);
  const load = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(calls, (c) => c + 1);
    yield* Effect.sleep(Duration.millis(5));
    if (yield* Ref.get(failing)) return yield* Effect.fail("boom");
    return n;
  });
  return { calls, failing, load };
});

describe("RefreshingCache", () => {
  it.effect("N concurrent cold reads perform exactly one load", () =>
    Effect.gen(function* () {
      const { calls, load } = yield* counting;
      const cache = yield* RefreshingCache.make(load, options);
      const fiber = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 20 }, () => cache.get),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust(Duration.millis(10));
      const results = yield* Fiber.join(fiber);
      assert.strictEqual(results.length, 20);
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("serves the cached value until ttl, then reloads once", () =>
    Effect.gen(function* () {
      const { calls, load } = yield* counting;
      const cache = yield* RefreshingCache.make(load, options);
      const first = yield* Effect.forkChild(cache.get);
      yield* TestClock.adjust(Duration.millis(10));
      assert.strictEqual(yield* Fiber.join(first), 1);
      yield* TestClock.adjust(Duration.minutes(9));
      yield* cache.get;
      assert.strictEqual(yield* Ref.get(calls), 1);
      yield* TestClock.adjust(Duration.minutes(2));
      const reloaded = yield* Effect.forkChild(cache.get);
      yield* TestClock.adjust(Duration.millis(10));
      assert.strictEqual(yield* Fiber.join(reloaded), 2);
    }),
  );

  it.effect("a burst of refreshOnMiss within minRefetchInterval performs at most one reload", () =>
    Effect.gen(function* () {
      const { calls, load } = yield* counting;
      const cache = yield* RefreshingCache.make(load, options);
      const warm = yield* Effect.forkChild(cache.get);
      yield* TestClock.adjust(Duration.millis(10));
      yield* Fiber.join(warm);
      const burst = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 25 }, () => cache.refreshOnMiss),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust(Duration.millis(10));
      yield* Fiber.join(burst);
      // the cold load plus exactly one forced reload
      assert.strictEqual(yield* Ref.get(calls), 2);
      yield* TestClock.adjust(Duration.seconds(31));
      const later = yield* Effect.forkChild(cache.refreshOnMiss);
      yield* TestClock.adjust(Duration.millis(10));
      yield* Fiber.join(later);
      assert.strictEqual(yield* Ref.get(calls), 3);
    }),
  );

  it.effect("a failed load is replayed for minRefetchInterval instead of being retried", () =>
    Effect.gen(function* () {
      const { calls, failing, load } = yield* counting;
      yield* Ref.set(failing, true);
      const cache = yield* RefreshingCache.make(load, options);
      const attempt = (fiber: Effect.Effect<unknown, string>) =>
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(Effect.flip(fiber));
          yield* TestClock.adjust(Duration.millis(10));
          return yield* Fiber.join(running);
        });
      yield* attempt(cache.get);
      yield* attempt(cache.get);
      yield* attempt(cache.get);
      assert.strictEqual(yield* Ref.get(calls), 1);
      yield* TestClock.adjust(Duration.seconds(31));
      yield* attempt(cache.get);
      assert.strictEqual(yield* Ref.get(calls), 2);
    }),
  );
});
