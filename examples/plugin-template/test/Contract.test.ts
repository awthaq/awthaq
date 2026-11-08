// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps.
// for the template's `Notes` (the check a third-party plugin runs on itself).
import { RecordsContract, TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Template from "../src/Template.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Template.Notes, {
  options: [{}],
  records: { suite: "notes_records_contract", suites: RecordsContract.pending("09") },
});
