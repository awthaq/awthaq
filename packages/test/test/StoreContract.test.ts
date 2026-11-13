// Plan 02, phase 1: the `StoreContract` runner itself. The port cases arrive with their adapters
// (phases 2 to 6); this proves the runner builds a fresh layer for every case and reports a
// failing case instead of swallowing it.
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { RateLimiter, VerificationStore } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as StoreContract from "../src/StoreContract.ts";
import type { TestFramework } from "../src/TestFramework.ts";

class NotAtomic extends Data.TaggedError("NotAtomic")<{
  readonly message: string;
}> {}

const recordingFramework = () => {
  const pending: Array<Promise<void>> = [];
  const passed: Array<string> = [];
  const failed: Array<string> = [];
  const titled: Array<string> = [];
  let title = "";
  const framework: TestFramework = {
    describe: (name, body) => {
      title = name;
      body();
    },
    it: (name, body) => {
      titled.push(`${title} > ${name}`);
      pending.push(
        Promise.resolve()
          .then(body)
          .then(
            () => void passed.push(name),
            (error: unknown) =>
              void failed.push(`${name} :: ${error instanceof Error ? error.message : error}`),
          ),
      );
    },
    fail: (message) => {
      throw new Error(message);
    },
  };
  return { framework, passed, failed, titled, settled: () => Promise.all(pending) };
};

interface TallyShape {
  readonly bump: Effect.Effect<number>;
  readonly get: Effect.Effect<number>;
}

class Tally extends Context.Service<Tally, TallyShape>()("test/Tally") {}

const TallyLive = Layer.effect(
  Tally,
  Effect.map(Ref.make(0), (counter) =>
    Tally.of({
      bump: Ref.updateAndGet(counter, (n) => n + 1),
      get: Ref.get(counter),
    }),
  ),
);

describe("StoreContract.runSuite", () => {
  it.effect(
    "builds a fresh layer for every case and runs every entry, named by operation and verdict",
    () =>
      Effect.gen(function* () {
        const seen: Array<number> = [];
        const bump = Effect.gen(function* () {
          const tally = yield* Tally;
          seen.push(yield* tally.bump);
        });
        const recorder = recordingFramework();
        StoreContract.runSuite(recorder.framework, {
          adapter: "fixture",
          suite: StoreContract.suite(Tally, {
            operations: {
              bump: { write: [{ name: "first", run: bump }] },
              get: { read: [{ name: "second", run: bump }] },
            },
          }),
          layer: TallyLive,
        });
        yield* Effect.promise(recorder.settled);
        assert.deepStrictEqual(recorder.passed, ["bump [write]: first", "get [read]: second"]);
        assert.deepStrictEqual(recorder.failed, []);
        assert.deepStrictEqual(seen, [1, 1]);
      }),
  );

  it.effect("reports a failing case rather than swallowing it", () =>
    Effect.gen(function* () {
      const recorder = recordingFramework();
      StoreContract.runSuite(recorder.framework, {
        adapter: "fixture",
        suite: StoreContract.suite(Tally, {
          operations: {
            bump: {
              write: [
                {
                  name: "broken",
                  run: Effect.fail(new NotAtomic({ message: "not atomic" })),
                },
              ],
            },
            get: { exempt: "a test seam" },
          },
        }),
        layer: TallyLive,
      });
      yield* Effect.promise(recorder.settled);
      assert.strictEqual(recorder.failed.length, 1);
      assert.include(recorder.failed[0], "not atomic");
      assert.include(recorder.failed[0], "bump [write]: broken");
      assert.deepStrictEqual(recorder.passed, ["get is exempt: a test seam"]);
    }),
  );

  it.effect("runs each case under a TestClock", () =>
    Effect.gen(function* () {
      const recorder = recordingFramework();
      const adjust = Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(yield* Clock.currentTimeMillis, 60_000);
      });
      StoreContract.runSuite(recorder.framework, {
        adapter: "fixture",
        suite: StoreContract.suite(Tally, {
          operations: {
            bump: { write: [{ name: "clock", run: adjust }] },
            get: { exempt: "unused" },
          },
        }),
        layer: TallyLive,
      });
      yield* Effect.promise(recorder.settled);
      assert.deepStrictEqual(recorder.failed, []);
    }),
  );
});

describe("StoreContract.run", () => {
  it.effect(
    "memory mode registers every suite's entries and the coverage check, and all pass",
    () =>
      Effect.gen(function* () {
        const recorder = recordingFramework();
        StoreContract.run(recorder.framework, { mode: "memory" });
        yield* Effect.promise(recorder.settled);
        const entries = Object.values(StoreContract.suites).reduce(
          (sum, suite) => sum + suite.entries.length,
          0,
        );
        assert.isTrue(recorder.passed.some((name) => name.includes("has a suite")));
        assert.deepStrictEqual(recorder.failed, []);
        assert.isTrue(recorder.passed.length >= entries);
      }),
  );

  it.effect("sql mode over :memory: SQLite also runs the suites' sql cases", () =>
    Effect.gen(function* () {
      const recorder = recordingFramework();
      StoreContract.run(recorder.framework, {
        mode: "sql",
        label: "SQLite",
        client: SqliteClient.layer({ filename: ":memory:" }),
      });
      yield* Effect.promise(recorder.settled);
      const total = Object.values(StoreContract.suites).reduce(
        (sum, suite) => sum + suite.entries.length + suite.sql.length,
        0,
      );
      assert.deepStrictEqual(recorder.failed, []);
      assert.isTrue(recorder.passed.length >= total);
    }),
  );

  it.effect("sealed mode registers only the users and sessions suites", () =>
    Effect.gen(function* () {
      const recorder = recordingFramework();
      StoreContract.run(recorder.framework, {
        mode: "sealed",
        label: "SQLite",
        client: SqliteClient.layer({ filename: ":memory:" }),
      });
      yield* Effect.promise(recorder.settled);
      assert.deepStrictEqual(recorder.failed, []);
      assert.isTrue(recorder.passed.length > 0);
      assert.isTrue(
        recorder.titled.every(
          (name) => name.includes("UserStore") || name.includes("SessionStore"),
        ),
      );
    }),
  );

  it.effect(
    "a VerificationStore whose settle ignores a give-back fails StoreContract.verification, naming the give-back case",
    () =>
      Effect.gen(function* () {
        const noOpGiveBack = Layer.effect(
          VerificationStore.VerificationStore,
          Effect.map(VerificationStore.VerificationStore, (store) =>
            VerificationStore.VerificationStore.of({
              ...store,
              settle: () => Effect.void,
            }),
          ),
        ).pipe(Layer.provide(VerificationStore.layerMemory));
        const recorder = recordingFramework();
        StoreContract.runSuite(recorder.framework, {
          adapter: "no-op give-back",
          layer: noOpGiveBack,
          suite: StoreContract.verification,
        });
        yield* Effect.promise(recorder.settled);
        assert.isTrue(recorder.failed.length > 0);
        assert.isTrue(recorder.failed.some((name) => name.includes("given back")));
      }),
  );

  it.effect("a RateLimiterStore whose increment reads then writes fails the race case", () =>
    Effect.gen(function* () {
      const readThenWrite = Layer.effect(
        RateLimiter.RateLimiterStore,
        Effect.map(RateLimiter.RateLimiterStore, (store) =>
          RateLimiter.RateLimiterStore.of({
            ...store,
            increment: (key, window) =>
              Effect.gen(function* () {
                const seen = yield* store.peek(key);
                yield* Effect.yieldNow;
                const bucket = yield* store.increment(key, window);
                return Option.isSome(seen)
                  ? { ...bucket, count: seen.value.count + 1 }
                  : { ...bucket, count: 1 };
              }),
          }),
        ),
      ).pipe(Layer.provide(RateLimiter.layerStoreMemory));
      const recorder = recordingFramework();
      StoreContract.runSuite(recorder.framework, {
        adapter: "read then write",
        layer: readThenWrite,
        suite: StoreContract.rateLimiterStore,
      });
      yield* Effect.promise(recorder.settled);
      assert.isTrue(recorder.failed.some((name) => name.includes("increment [race]")));
    }),
  );

  it.effect("race runs CONCURRENCY copies", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      yield* StoreContract.race(Ref.update(counter, (n) => n + 1));
      assert.strictEqual(yield* Ref.get(counter), StoreContract.CONCURRENCY);
    }),
  );
});
