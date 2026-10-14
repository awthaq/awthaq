// Plan 02, phase 1: the `StoreContract` runner itself. The port cases arrive with their adapters
// (phases 2 to 6); this proves the runner builds a fresh layer for every case and reports a
// failing case instead of swallowing it.
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as StoreContract from "../src/StoreContract.ts";
import type { TestFramework } from "../src/TestFramework.ts";

class NotAtomic extends Data.TaggedError("NotAtomic")<{ readonly message: string }> {}

class Counter extends Context.Service<Counter, Ref.Ref<number>>()("test/Counter") {}

const CounterLive = Layer.effect(Counter, Ref.make(0));

const recordingFramework = () => {
  const pending: Array<Promise<void>> = [];
  const passed: Array<string> = [];
  const failed: Array<string> = [];
  const framework: TestFramework = {
    describe: (_name, body) => body(),
    it: (name, body) => {
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
  return { framework, passed, failed, settled: () => Promise.all(pending) };
};

describe("StoreContract.run", () => {
  it.effect("builds a fresh layer for every case and runs every case", () =>
    Effect.gen(function* () {
      const seen: Array<number> = [];
      const bump = Effect.gen(function* () {
        const counter = yield* Counter;
        yield* Ref.update(counter, (n) => n + 1);
        seen.push(yield* Ref.get(counter));
      });
      const recorder = recordingFramework();
      StoreContract.run(recorder.framework, {
        adapter: "fixture",
        layer: CounterLive,
        cases: [
          { name: "first", run: bump },
          { name: "second", run: bump },
        ],
      });
      yield* Effect.promise(recorder.settled);
      assert.deepStrictEqual(recorder.passed, ["first", "second"]);
      assert.deepStrictEqual(recorder.failed, []);
      // A shared layer would have counted 1 then 2.
      assert.deepStrictEqual(seen, [1, 1]);
    }),
  );

  it.effect("reports a failing case rather than swallowing it", () =>
    Effect.gen(function* () {
      const recorder = recordingFramework();
      StoreContract.run(recorder.framework, {
        adapter: "fixture",
        layer: CounterLive,
        cases: [{ name: "broken", run: Effect.fail(new NotAtomic({ message: "not atomic" })) }],
      });
      yield* Effect.promise(recorder.settled);
      assert.strictEqual(recorder.failed.length, 1);
      assert.include(recorder.failed[0], "not atomic");
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
