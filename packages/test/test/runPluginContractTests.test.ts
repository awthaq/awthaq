// spec/behaviors/25-testing-harness.md, BEH-EA-198, BEH-EA-199 (contract-hash half).
//
// Exercised with a recording `TestFramework` (not `@effect/vitest`'s real
// `describe`/`it`) so each check's pass/fail can be asserted on directly —
// a real, well-formed plugin (`@effect-auth/password`'s own `Password`)
// proves every check passes cleanly; small deliberately-broken fixture
// plugins each prove one specific check actually catches its violation.
import { Password } from "@effect-auth/password";
import { AuthPlugin } from "@effect-auth/core";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { TestAuth } from "../src/index.ts";

class Recorder {
  readonly passed: Array<string> = [];
  readonly failed: Array<string> = [];
}

const recordingFramework = (sink: Recorder): TestAuth.TestFramework => ({
  describe: (_name, body) => body(),
  it: (name, body) => {
    try {
      body();
      sink.passed.push(name);
    } catch (error) {
      sink.failed.push(`${name} :: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  fail: (message) => {
    throw new Error(message);
  },
});

const fakePlugin = (overrides: Partial<AuthPlugin.Any>): AuthPlugin.Any => ({
  id: "fake",
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
  ...overrides,
});

describe("runPluginContractTests (BEH-EA-198/199)", () => {
  it("a real, well-formed plugin (Password) passes every check", () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
      options: [{}, {}],
    });
    assert.deepStrictEqual(sink.failed, []);
    assert.isAbove(sink.passed.length, 0);
  });

  it("catches a table missing this plugin's own id prefix", () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "invite", tables: ["invite_codes", "other_table"] }),
      { options: [{}] },
    );
    assert.isTrue(sink.failed.some((message) => message.includes("other_table")));
  });

  it("catches a missing host dependency as E_PLUGIN_MISSING_DEP", () => {
    const sink = new Recorder();
    const host = fakePlugin({ id: "password" });
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "invite", dependsOn: [host] }),
      { options: [{}], host: [] },
    );
    assert.isTrue(sink.failed.some((message) => message.includes("E_PLUGIN_MISSING_DEP")));
  });

  it("passes the missing-dependency check once the host plugin is actually present", () => {
    const sink = new Recorder();
    const host = fakePlugin({ id: "password" });
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "invite", dependsOn: [host] }),
      { options: [{}], host: [host] },
    );
    assert.isFalse(sink.failed.some((message) => message.includes("E_PLUGIN_MISSING_DEP")));
  });

  it("catches an id colliding with a host plugin", () => {
    const sink = new Recorder();
    const host = fakePlugin({ id: "password" });
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      () => fakePlugin({ id: "password" }),
      {
        options: [{}],
        host: [host],
      },
    );
    assert.isTrue(sink.failed.some((message) => message.includes("E_PLUGIN_DUPLICATE_ID")));
  });

  it("catches a contract that changes with a different option value", () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(
      recordingFramework(sink),
      (_options: { readonly variant: string }) =>
        fakePlugin({ contract: { identifier: "auth", groups: {} } }),
      { options: [{ variant: "a" }, { variant: "b" }] },
    );
    assert.isTrue(sink.failed.some((message) => message.includes("contract changed")));
  });
});
