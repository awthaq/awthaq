// Plan 25 ticket 07 (ADR-EA-041 decision 9): the `RecordsContract` runner. Driven through a recording
// `TestFramework` (like `runPluginContractTests.test.ts`) so each registered case's outcome can be read:
// a correct bundle passes on memory and SQL (SQLite here, a Postgres schema under `pnpm test:pg`), a
// memory adapter that reads and writes in two steps is caught by its `race` case (the failure names the
// store, the mode, the operation and the verdict), a store no suite names fails the coverage check, and an
// exemption shows up as a passing test with its reason.
import type { AuthPlugin } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as RecordsContract from "../src/RecordsContract.ts";
import * as TestAuth from "../src/TestAuth.ts";
import {
  BrokenCounters,
  counterRecords,
  Counters,
  SurplusCounters,
  tagRecords,
} from "./support/Counters.ts";

class Recorder {
  readonly passed: Array<string> = [];
  readonly failed: Array<string> = [];
  readonly pending: Array<Promise<void>> = [];
  settled() {
    return Promise.all(this.pending).then(() => undefined);
  }
}

const recordingFramework = (sink: Recorder): TestAuth.TestFramework => ({
  describe: (_name, body) => body(),
  it: (name, body) => {
    sink.pending.push(
      Promise.resolve()
        .then(body)
        .then(
          () => {
            sink.passed.push(name);
          },
          (error: unknown) => {
            sink.failed.push(
              `${name} :: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        ),
    );
  },
  fail: (message) => {
    throw new Error(message);
  },
});

const suites = {
  "counters/records/CounterRecords": counterRecords,
  "counters/records/TagRecords": tagRecords,
};

describe("RecordsContract.run", () => {
  it("a correct bundle passes every case on memory and on SQL", async () => {
    const sink = new Recorder();
    RecordsContract.run(recordingFramework(sink), Counters, [], {
      suite: "records_contract_ok",
      suites,
    });
    await sink.settled();
    assert.deepStrictEqual(sink.failed, []);
    // 3 counter cases + 1 tag case, on two modes, plus the coverage check and one exemption.
    assert.strictEqual(sink.passed.length, 4 * 2 + 2);
    assert.include(
      sink.passed,
      "increment [race]: 8 increments racing at max - 1 store exactly one",
    );
    assert.include(
      sink.passed,
      "counters/records/TagRecords.list is exempt: covered by add's case",
    );
  });

  it("a memory adapter that reads, then writes, is caught by its race case, named", async () => {
    const sink = new Recorder();
    RecordsContract.run(recordingFramework(sink), BrokenCounters, [], {
      suite: "records_contract_broken",
      suites,
    });
    await sink.settled();
    assert.strictEqual(sink.failed.length, 1, sink.failed.join("\n"));
    const [failure] = sink.failed;
    assert.include(failure, "counters/records/CounterRecords (memory)");
    assert.include(failure, "increment [race]:");
  });

  it("a store the bundle provides without a suite fails the coverage check, naming it", async () => {
    const sink = new Recorder();
    // Typed, this does not compile (`Suites<typeof SurplusCounters>` names the third store); seen as a
    // hand-built `AuthPlugin.Any`, the runtime check is what catches it.
    const surplus: AuthPlugin.Any = SurplusCounters;
    RecordsContract.run(recordingFramework(sink), surplus, [], {
      suite: "records_contract_surplus",
      suites,
    });
    await sink.settled();
    assert.strictEqual(sink.failed.length, 1, sink.failed.join("\n"));
    assert.include(
      sink.failed[0],
      "stores without a RecordsContract suite: counters/records/NoteRecords",
    );
  });
});

describe("runPluginContractTests with records", () => {
  it("runs the plugin's suites beside the other checks", async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Counters, {
      options: [{}],
      records: { suite: "records_contract_runner", suites },
    });
    await sink.settled();
    assert.deepStrictEqual(sink.failed, []);
    assert.include(sink.passed, "increment [atomic]: adds one until max, then refuses");
  });
});
