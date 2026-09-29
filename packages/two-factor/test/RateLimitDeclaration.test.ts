// PV-241/BEH-EA-111: `plugin list --rules` prints the static `rateLimits` declaration, so it must not
// drift from the rules the layer registers (`failureBudget` follows the configured limit and window).
import { RateLimits } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TwoFactor from "../src/TwoFactor.ts";
import { buildLayer } from "./support/harness.ts";

describe("TwoFactor rate-limit declaration (PV-241)", () => {
  it.effect("declares exactly what the layer registers, at the default configuration", () =>
    Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      assert.deepStrictEqual(
        RateLimits.declarationDrift(TwoFactor.TwoFactor, yield* registry.registered),
        {
          undeclared: [],
          unregistered: [],
          mismatched: [],
        },
      );
    }).pipe(Effect.provide(buildLayer())),
  );
});
