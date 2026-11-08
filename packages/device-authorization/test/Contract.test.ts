// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `DeviceAuthorization`.
import { SessionLifecycle } from "@awthaq/api";
import * as DeviceAuthorizationApi from "../src/DeviceAuthorizationApi.ts";
import { RecordsContract, TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as DeviceAuthorization from "../src/DeviceAuthorization.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => DeviceAuthorization.DeviceAuthorization, {
  options: [{}],
  records: {
    suite: "device_authorization_records_contract",
    suites: RecordsContract.pending("19"),
  },
  build: { services: Layer.empty },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("DeviceAuthorizationApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(
      Object.fromEntries(SessionLifecycle.inventory(DeviceAuthorizationApi.DeviceAuthorizationApi)),
      { "device_authorization.token": "mints" },
    );
  });
});
