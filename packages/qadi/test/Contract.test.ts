// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `UserClaims`.
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as UserClaims from "../src/UserClaims.ts";
import { userClaims } from "./contract/UserClaims.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => UserClaims.UserClaims, {
  options: [{}],
  records: {
    suite: "qadi_records_contract",
    suites: { "awthaq/qadi/records/UserClaims": userClaims },
  },
  build: { services: Layer.empty },
});
