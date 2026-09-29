// PV-241/BEH-EA-111: `plugin list --rules` prints the static `rateLimits` declaration, so it must not
// drift from the rules the layer registers.
import { RateLimits } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ApiKey from "../src/ApiKey.ts";
import { buildLayer } from "./harness.ts";

describe("ApiKey rate-limit declaration (PV-241)", () => {
  it.effect("declares exactly what the layer registers, at the default configuration", () =>
    Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      assert.deepStrictEqual(
        RateLimits.declarationDrift(ApiKey.ApiKey, yield* registry.registered),
        {
          undeclared: [],
          unregistered: [],
          mismatched: [],
        },
      );
    }).pipe(Effect.provide(buildLayer({ store: "memory" }))),
  );
});
