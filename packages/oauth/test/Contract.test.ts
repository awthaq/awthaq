// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `OAuth` (it owns no table: `tables: {}`).
import { SessionLifecycle } from "@awthaq/api";
import * as OAuthApi from "../src/OAuthApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthConfig from "../src/OAuthConfig.ts";

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => OAuth.OAuth, {
  options: [{}],
  build: {
    services: Layer.merge(
      OAuthConfig.config({ baseUrl: "https://app.example.com" }),
      TestAuth.httpClient.noBreach,
    ),
  },
});

// ADR-EA-045 (BEH-EA-343): the session lifecycle this plugin declares, pinned where its contract lives.
describe("session lifecycle", () => {
  it("OAuthApi declares each endpoint's session lifecycle", () => {
    assert.deepStrictEqual(Object.fromEntries(SessionLifecycle.inventory(OAuthApi.OAuthApi)), {
      "oauth.callback": "mints",
      "oauth.exchange.token": "mints",
    });
  });
});
