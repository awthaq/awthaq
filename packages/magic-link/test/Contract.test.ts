// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `MagicLink` and `EmailOtp` (neither owns a table).
import { SessionLifecycle } from "@awthaq/api";
import * as MagicLinkApi from "../src/MagicLinkApi.ts";
import * as EmailOtpApi from "../src/EmailOtpApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
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

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("MagicLinkApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(
      Object.fromEntries(SessionLifecycle.inventory(MagicLinkApi.MagicLinkApi)),
      { "magicLink.verify": "mints" },
    );
  });
  it("EmailOtpApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(
      Object.fromEntries(SessionLifecycle.inventory(EmailOtpApi.EmailOtpApi)),
      { "emailOtp.verify": "mints" },
    );
  });
});
