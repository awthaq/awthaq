// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Saml` and `Sso`. Both need an XML-signature adapter, a metadata fetcher and `SamlConfig` (the suites' fakes), so their composition-builds check stays opt-out.
import { SessionLifecycle } from "@awthaq/api";
import * as SamlApi from "../src/SamlApi.ts";
import { RecordsContract, TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Saml from "../src/Saml.ts";
import * as Sso from "../src/Sso.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Saml.Saml, {
  options: [{}],
  records: { suite: "saml_records_contract", suites: RecordsContract.pending("22") },
});
TestAuth.runPluginContractTests(framework, () => Sso.Sso, { options: [{}] });

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("SamlApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(Object.fromEntries(SessionLifecycle.inventory(SamlApi.SamlApi)), {
      "saml.acs": "mints",
      "saml.account.logout": "ends",
    });
  });
});
