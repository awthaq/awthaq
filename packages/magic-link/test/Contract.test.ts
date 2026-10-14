// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `MagicLink` and `EmailOtp` (neither owns a table).
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as EmailOtp from "../src/EmailOtp.ts";
import * as MagicLink from "../src/MagicLink.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => MagicLink.MagicLink, {
  options: [{}],
  build: { services: Layer.empty },
});
TestAuth.runPluginContractTests(framework, () => EmailOtp.EmailOtp, {
  options: [{}],
  build: { services: Layer.empty },
});
