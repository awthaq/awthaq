// See src/RateLimiter.ts's own header comment for what this port is
// grounded in — spec/behaviors/14-rate-limiting.md, BEH-EA-105/106/109/112.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { RateLimiter } from "../src/index.ts";

const MemoryLive = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

describe("RateLimiter.layer + layerStoreMemory (BEH-EA-105/106)", () => {
  it.effect("admits up to the limit, then fails with RateLimited carrying retryAfterMillis", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      const input = { key: "signin:alice", limit: 2, window: Duration.seconds(10) };
      yield* limiter.consume(input);
      yield* limiter.consume(input);
      const failure = yield* limiter.consume(input).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
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
