// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Roles` and `RolesAdmin`. `RolesAdmin` needs qadi's `RequirePermission` (a host-built Path B guard), so its composition-builds check stays opt-out.
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Roles from "../src/Roles.ts";
import * as RolesAdmin from "../src/RolesAdmin.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Roles.Roles, {
  options: [{}],
  build: { services: Layer.empty },
});
TestAuth.runPluginContractTests(framework, () => RolesAdmin.RolesAdmin, { options: [{}] });
