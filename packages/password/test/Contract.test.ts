// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Password`.
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Password from "../src/Password.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Password.Password, {
  options: [{}],
  build: { services: TestAuth.httpClient.noBreach },
});
