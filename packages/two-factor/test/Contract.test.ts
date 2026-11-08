// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `TwoFactor`; here, that migrations apply identically on two fresh databases. Its composition needs the two gates a host chooses (BEH-EA-261).
import { SessionLifecycle } from "@awthaq/api";
import * as TwoFactorApi from "../src/TwoFactorApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as SecondFactor from "../src/SecondFactor.ts";
import * as TwoFactor from "../src/TwoFactor.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => TwoFactor.TwoFactor, {
  options: [{}],
  build: {
    services: TwoFactor.sessionGate.pipe(
      Layer.merge(TwoFactor.credentialResetGate),
      Layer.provideMerge(SecondFactor.layer),
    ),
  },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("TwoFactorApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(
      Object.fromEntries(SessionLifecycle.inventory(TwoFactorApi.TwoFactorApi)),
      { "two_factor.verify": "mints", "two_factor.verifyRecovery": "mints" },
    );
  });
});
