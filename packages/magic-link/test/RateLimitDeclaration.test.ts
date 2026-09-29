// PV-241/BEH-EA-111: `plugin list --rules` prints the static `rateLimits` declaration, so it must not
// drift from the rules each layer registers.
import { RateLimits } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EmailOtp from "../src/EmailOtp.ts";
import * as MagicLink from "../src/MagicLink.ts";
import { buildLayer } from "./support/harness.ts";

describe("magic-link rate-limit declarations (PV-241)", () => {
  it.effect("MagicLink and EmailOtp each declare exactly what they register", () =>
    Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      const registered = yield* registry.registered;
      for (const plugin of [MagicLink.MagicLink, EmailOtp.EmailOtp]) {
        assert.isAbove(plugin.rateLimits.length, 0);
        assert.deepStrictEqual(RateLimits.declarationDrift(plugin, registered), {
          undeclared: [],
          unregistered: [],
          mismatched: [],
        });
      }
    }).pipe(Effect.provide(buildLayer())),
  );
});
