// PV-241/BEH-EA-111: `plugin list --rules` prints the static `rateLimits` declaration, so it must not
// drift from the rules the layer registers.
import { RateLimits } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Passkey from "../src/Passkey.ts";
import { mockWebAuthn } from "./passkeyTestFixtures.ts";
import { buildLayer } from "./passkeyTestLayers.ts";

describe("Passkey rate-limit declaration (PV-241)", () => {
  it.effect("declares exactly what the layer registers", () =>
    Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      assert.deepStrictEqual(
        RateLimits.declarationDrift(Passkey.Passkey, yield* registry.registered),
        {
          undeclared: [],
          unregistered: [],
          mismatched: [],
        },
      );
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});
