// BEH-EA-352: a World's one lazy app cell builds once, is owned by the scope that made the cell, and is configured before use.
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as TestAuth from "../src/TestAuth.ts";
import { Pins } from "./support/Pins.ts";

const cell = (builds: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>, settings = {}) =>
  TestAuth.lazyApp<ReadonlyArray<string>, TestAuth.App<never>>(
    [],
    (options) =>
      Ref.update(builds, (all) => [...all, options]).pipe(
        Effect.andThen(TestAuth.serve(TestAuth.layer(Auth.make([Pins])))),
      ),
    { name: "ExampleWorld", ...settings },
  );

describe("TestAuth.lazyApp (BEH-EA-352)", () => {
  it.effect("builds once, returns the same app, and releases with the cell's scope", () =>
    Effect.gen(function* () {
      const apps = TestAuth.openApps();
      const builds = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const app = yield* cell(builds);
          const first = yield* app.get;
          assert.strictEqual(yield* app.get, first);
          assert.strictEqual((yield* Ref.get(builds)).length, 1);
          assert.strictEqual(TestAuth.openApps(), apps + 1);
        }),
      );
      assert.strictEqual(TestAuth.openApps(), apps);
    }),
  );

  it.effect("two concurrent first gets build once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const builds = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const app = yield* cell(builds);
        const [a, b] = yield* Effect.all([app.get, app.get], { concurrency: "unbounded" });
        assert.strictEqual(a, b);
        assert.strictEqual((yield* Ref.get(builds)).length, 1);
      }),
    ),
  );

  it.effect(
    "configure applies in order before the first get; after it, it is a defect naming replace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const builds = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          const app = yield* cell(builds);
          yield* app.configure((current) => [...current, "a"]);
          yield* app.configure((current) => [...current, "b"]);
          yield* app.get;
          assert.deepStrictEqual(yield* Ref.get(builds), [["a", "b"]]);
          const late = yield* Effect.exit(app.configure((current) => [...current, "c"]));
          assert.isTrue(Exit.isFailure(late) && Cause.hasDies(late.cause));
          const text = Exit.isFailure(late) ? String(Cause.squash(late.cause)) : "";
          assert.include(text, "ExampleWorld");
          assert.include(text, "replace");
        }),
      ),
  );

  it.effect("replace releases the built app and the next get builds from the new options", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const apps = TestAuth.openApps();
        const builds = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const app = yield* cell(builds);
        yield* app.get;
        assert.strictEqual(TestAuth.openApps(), apps + 1);
        yield* app.replace(["o2"]);
        assert.strictEqual(TestAuth.openApps(), apps);
        yield* app.get;
        assert.deepStrictEqual(yield* Ref.get(builds), [[], ["o2"]]);
      }),
    ),
  );

  it.effect(
    "alignStepClock sets the TestClock to the wall clock before the first build; absent, it stays at 0",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const builds = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          const plain = yield* cell(builds);
          yield* plain.get;
          assert.strictEqual(yield* Clock.currentTimeMillis, 0);
          const aligned = yield* cell(builds, { alignStepClock: true });
          yield* aligned.get;
          assert.isBelow(Math.abs((yield* Clock.currentTimeMillis) - Date.now()), 60_000);
        }),
      ),
  );
});
