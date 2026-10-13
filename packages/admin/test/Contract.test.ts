// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for every plugin class this package ships (`Admin`, `AdminAccounts`, `AdminTenants`).
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";
import * as AdminTenants from "../src/AdminTenants.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Admin.Admin, {
  options: [{}],
  build: { services: Layer.empty },
});
TestAuth.runPluginContractTests(framework, () => AdminAccounts.AdminAccounts, {
  options: [{}],
  build: { services: Layer.empty },
});
TestAuth.runPluginContractTests(framework, () => AdminTenants.AdminTenants, {
  options: [{}],
  build: { services: Layer.empty },
});
