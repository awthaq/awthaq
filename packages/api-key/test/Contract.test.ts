// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `ApiKey` (composed over `Jwt`, which needs its issuer configured).
import { RecordsContract, TestAuth } from "@awthaq/test";
import { JwtConfig as Jwt } from "@awthaq/jwt";
import { describe, it } from "@effect/vitest";
import * as ApiKey from "../src/ApiKey.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => ApiKey.ApiKey, {
  options: [{}],
  records: { suite: "api_key_records_contract", suites: RecordsContract.pending("17") },
  build: { services: Jwt.config({ issuer: "https://issuer.test" }) },
});
