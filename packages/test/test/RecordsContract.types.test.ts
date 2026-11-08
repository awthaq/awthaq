// Plan 25 ticket 04 (ADR-EA-041 decision 9): the compile-time half of `RecordsContract`.
// `tsc -p tsconfig.test.json` is the assertion; the token runtime test makes the file a suite.
//
// 1. `Operations<Shape>` keeps functions and `Effect`-valued members and drops data.
// 2. `suite(Store, { operations })` infers the store from a `Context.Service` class, and an operation
//    without a verdict is an error.
// 3. `Suites<P>` has exactly the plugin's `/records/` keys: a missing key, and a suite built for another
//    store under a key, are errors (`Suite<in out Id>`).
// 4. `runPluginContractTests` requires `records` for a plugin whose bundle provides a store, forbids it for
//    one whose bundle provides none, and leaves it optional for a hand-built `AuthPlugin.Any`.
import type { AuthPlugin } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RecordsContract from "../src/RecordsContract.ts";
import * as TestAuth from "../src/TestAuth.ts";
import { CounterRecords, counterRecords, Counters, tagRecords } from "./support/Counters.ts";

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// 1. Data members are not operations.
interface Mixed {
  readonly guarantees: { readonly singleUse: boolean };
  readonly list: Effect.Effect<ReadonlyArray<string>>;
  readonly add: (label: string) => Effect.Effect<void>;
  readonly name: string;
}
export const operationsKeepFunctionsAndEffects: Equals<
  keyof RecordsContract.Operations<Mixed>,
  "list" | "add"
> = true;

const fresh = { name: "zero", run: Effect.void };

// 2. Every operation needs a verdict (each builder is never called: it only has to fail to type-check).
export const unclassified = () =>
  RecordsContract.suite(CounterRecords, {
    // @ts-expect-error - `get` has no verdict
    operations: { increment: { atomic: [fresh], race: [fresh] } },
  });
// An atomic verdict needs a race case.
export const atomicWithoutRace = () =>
  RecordsContract.suite(CounterRecords, {
    operations: {
      // @ts-expect-error - `atomic` without `race`
      increment: { atomic: [fresh] },
      get: { read: [fresh] },
    },
  });
// A verdict needs at least one case.
export const emptyVerdict = () =>
  RecordsContract.suite(CounterRecords, {
    operations: {
      increment: { exempt: "not driven here" },
      // @ts-expect-error - an empty `read`
      get: { read: [] },
    },
  });

// 3. The suites of `Counters` are exactly its two stores.
export const suitesKeys: Equals<
  keyof RecordsContract.Suites<typeof Counters>,
  "counters/records/CounterRecords" | "counters/records/TagRecords"
> = true;
// @ts-expect-error - the TagRecords key is missing
export const missingKey: RecordsContract.Suites<typeof Counters> = {
  "counters/records/CounterRecords": counterRecords,
};
export const swapped: RecordsContract.Suites<typeof Counters> = {
  // @ts-expect-error - a TagRecords suite under the CounterRecords key
  // @effect-diagnostics-next-line missingEffectContext:off
  "counters/records/CounterRecords": tagRecords,
  "counters/records/TagRecords": tagRecords,
};

const framework: TestAuth.TestFramework = {
  describe: () => {},
  it: () => {},
  fail: (message) => {
    throw new Error(message);
  },
};

/** Never called: each line only has to type-check (or not). */
export const runnerRequirements = () => {
  // 4. A plugin with stores must pass them…
  // @ts-expect-error - `records` is required: Counters' bundle provides two stores
  TestAuth.runPluginContractTests(framework, () => Counters, { options: [{}] });
  TestAuth.runPluginContractTests(framework, () => Counters, {
    options: [{}],
    records: {
      suite: "types",
      suites: {
        "counters/records/CounterRecords": counterRecords,
        "counters/records/TagRecords": tagRecords,
      },
    },
  });
  // …a plugin with none must not…
  TestAuth.runPluginContractTests(framework, () => Password.Password, {
    options: [{}],
    // @ts-expect-error - Password's bundle provides no store
    records: { suite: "types", suites: {} },
  });
  // …and a hand-built plugin may.
  const handBuilt: AuthPlugin.Any = {
    id: "hand",
    apiVersion: 1,
    contract: { identifier: "auth", groups: {} },
    tables: [],
    migrations: [],
    dependsOn: [],
    layer: Layer.empty,
  };
  TestAuth.runPluginContractTests(framework, () => handBuilt, { options: [{}] });
};

it("the guarantees above are checked by the compiler", () => {});
