// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Password`.
import { SessionLifecycle } from "@awthaq/api";
import * as PasswordApi from "../src/PasswordApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Password from "../src/Password.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Password.Password, {
  options: [{}],
  build: { services: TestAuth.httpClient.noBreach },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("PasswordApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(
      Object.fromEntries(SessionLifecycle.inventory(PasswordApi.PasswordApi)),
      {
        "password.signUp": "mints",
        "password.signIn": "mints",
        "password.account.changePassword": "rotates",
        "password.account.reauthenticate": "refreshes",
      },
    );
  });
});
