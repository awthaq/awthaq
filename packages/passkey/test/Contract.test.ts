// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Passkey` (its `WebAuthn` port is the test double the suites use).
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as Passkey from "../src/Passkey.ts";
import { mockWebAuthn } from "./passkeyTestFixtures.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Passkey.Passkey, {
  options: [{}],
  build: { services: mockWebAuthn() },
});
