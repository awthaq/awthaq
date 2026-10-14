// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Webhooks`.
import { TestAuth } from "@awthaq/test";
import { HostResolver } from "@awthaq/ports";
import { describe, it } from "@effect/vitest";
import * as Webhooks from "../src/Webhooks.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Webhooks.Webhooks, {
  options: [{}],
  build: { services: HostResolver.layerStatic({}) },
});
