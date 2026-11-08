// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Organization`.
import { SessionLifecycle } from "@awthaq/api";
import * as OrganizationApi from "../src/OrganizationApi.ts";
import { RecordsContract, TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Organization from "../src/Organization.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Organization.Organization, {
  options: [{}],
  records: { suite: "organization_records_contract", suites: RecordsContract.pending("10") },
  build: { services: Layer.empty },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("OrganizationApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(
      Object.fromEntries(SessionLifecycle.inventory(OrganizationApi.OrganizationApi)),
      {
        "organization.setActive": "refreshes",
        "organization.setActiveTeam": "refreshes",
        "organization.leave": "refreshes",
        "organization.acceptInvitation": "refreshes",
      },
    );
  });
});
