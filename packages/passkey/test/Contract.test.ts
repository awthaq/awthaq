// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Passkey` (its `WebAuthn` port is the test double the suites use).
import { SessionLifecycle } from "@awthaq/api";
import * as PasskeyApi from "../src/PasskeyApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Passkey from "../src/Passkey.ts";
import { mockWebAuthn } from "./passkeyTestFixtures.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Passkey.Passkey, {
  options: [{}],
  build: { services: mockWebAuthn() },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("PasskeyApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(Object.fromEntries(SessionLifecycle.inventory(PasskeyApi.PasskeyApi)), {
      "passkey.authenticate.authenticateVerify": "mints",
      "passkey.reauthenticate.reauthenticateVerify": "refreshes",
    });
  });
});
