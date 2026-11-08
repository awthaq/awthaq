// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6, `pnpm check:contract-tests`): manifest legality, group ids, table prefixes, migration determinism, the records bundle's parity, and the plugin's own hook taps
// for `Passkey` (its `WebAuthn` port is the test double the suites use).
import { SessionLifecycle } from "@awthaq/api";
import * as PasskeyApi from "../src/PasskeyApi.ts";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ChallengeStore from "../src/ChallengeStore.ts";
import * as Passkey from "../src/Passkey.ts";
import { challengeStore } from "./contract/ChallengeStore.ts";
import { passkeyCredentials } from "./contract/PasskeyCredentials.ts";
import { passkeyUserHandles } from "./contract/PasskeyUserHandles.ts";
import { mockWebAuthn } from "./passkeyTestFixtures.ts";

/** The stateless `ChallengeStore` adapter (WPS-009: no single use, no replace-on-issue), signed with a test secret. */
const CookieChallenges = ChallengeStore.layerCookie.pipe(
  Layer.provide(
    Layer.succeed(ChallengeStore.ChallengeCookieConfig, {
      secret: Redacted.make("test-only-challenge-cookie-secret"),
    }),
  ),
);

const framework = TestAuth.throwingFramework(describe, it);

TestAuth.runPluginContractTests(framework, () => Passkey.Passkey, {
  options: [{}],
  records: {
    suite: "passkey_records_contract",
    suites: {
      "awthaq/passkey/records/PasskeyCredentials": passkeyCredentials,
      "awthaq/passkey/records/PasskeyUserHandles": passkeyUserHandles,
      "awthaq/passkey/records/ChallengeStore": challengeStore,
    },
    adapters: [
      {
        name: "layerCookie",
        stores: ["awthaq/passkey/records/ChallengeStore"],
        layer: CookieChallenges,
      },
    ],
  },
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

// WPS-009: what each `ChallengeStore` adapter claims (the suite enforces each claim; `layerSql`'s is pinned in its `sql` cases).
describe("ChallengeStore guarantees", () => {
  it.effect("layerMemory claims single use and replace-on-issue; layerCookie claims neither", () =>
    Effect.gen(function* () {
      const memory = yield* ChallengeStore.ChallengeStore.pipe(
        Effect.provide(ChallengeStore.layerMemory),
      );
      const cookie = yield* ChallengeStore.ChallengeStore.pipe(Effect.provide(CookieChallenges));
      assert.deepStrictEqual(memory.guarantees, { singleUse: true, replacesPriorOnIssue: true });
      assert.deepStrictEqual(cookie.guarantees, { singleUse: false, replacesPriorOnIssue: false });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
