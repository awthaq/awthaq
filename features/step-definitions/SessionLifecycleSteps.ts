// BEH-EA-343 (04-contract-stratum.feature), ADR-EA-045: the session lifecycle is declared on the contract.
// The compile-time half is the two `// type-gate:` blocks in `CompileTimeGates.ts` (compiled by the typecheck
// gate); these steps assert the blocks still carry their enforcing construct, and read the composed contract's
// inventory at run time.
import { SessionLifecycle } from "@awthaq/api";
import { Auth } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { defineSteps } from "@effect-cucumber/vitest";
import * as Effect from "effect/Effect";
import assert from "node:assert/strict";
import { assertTypeGate } from "./FoundationsWorld.ts";

const GATES = "CompileTimeGates.ts";

export const sessionLifecycleSteps = defineSteps(({ Given, When, Then }) => {
  Given("an endpoint that declares no session lifecycle", function* () {
    yield* Effect.void;
  });

  Given("an endpoint declaring {string}", function* (marker: string) {
    yield* Effect.void;
    assert.equal(marker, "SessionLifecycle.Mints");
  });

  When("its handler calls {string}", function* (call: string) {
    yield* Effect.void;
    assert.equal(call, "SessionDelivery.decline(SessionLifecycle.MintGrant)");
  });

  Then("the group layer still requires {string}", function* (grant: string) {
    yield* Effect.void;
    assert.equal(grant, "SessionLifecycle.MintGrant");
    assertTypeGate("session-delivery-needs-a-declared-endpoint", GATES, [
      'HttpRouter.Request<"Requires", SessionLifecycle.MintGrant>',
      ": true = true",
    ]);
  });

  Then("the group layer requires nothing more", function* () {
    yield* Effect.void;
    assertTypeGate("a-declared-endpoint-gets-its-grant", GATES, [
      'HttpRouter.Request<"Requires", unknown>',
      ": false = true",
    ]);
  });

  Then(
    "the composed contract declares {string} as {string} and {string} as {string}",
    function* (first: string, firstKind: string, second: string, secondKind: string) {
      yield* Effect.void;
      const inventory = SessionLifecycle.inventory(Auth.make([Password.Password]).api);
      assert.equal(inventory.get(first), firstKind);
      assert.equal(inventory.get(second), secondKind);
      assert.equal(inventory.get("session.current"), undefined);
    },
  );
});
