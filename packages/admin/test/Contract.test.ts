// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for every plugin class this package ships (`Admin`, `AdminAccounts`, `AdminTenants`).
import { SessionLifecycle } from "@awthaq/api";
import * as AdminApi from "../src/AdminApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";
import * as AdminTenants from "../src/AdminTenants.ts";
import { impersonationRecords } from "./contract/ImpersonationRecords.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Admin.Admin, {
  options: [{}],
  records: {
    suite: "admin_records_contract",
    suites: { "awthaq/admin/records/ImpersonationRecords": impersonationRecords },
  },
  build: { services: Layer.empty },
});
TestAuth.runPluginContractTests(framework, () => AdminAccounts.AdminAccounts, {
  options: [{}],
  // Its dependency `Password` screens passwords over the breach check's transport.
  build: { services: TestAuth.httpClient.noBreach },
});
TestAuth.runPluginContractTests(framework, () => AdminTenants.AdminTenants, {
  options: [{}],
  build: { services: Layer.empty },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("AdminApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(Object.fromEntries(SessionLifecycle.inventory(AdminApi.AdminApi)), {
      "admin.impersonate": "swaps",
      "admin.stopImpersonating": "swaps",
      "admin.forceStop": "swaps",
    });
  });
});
