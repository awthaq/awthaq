// spec/behaviors/17-passkey.md, BEH-EA-135/136 — HSK-002 (+TC-006, CB-008).
//
// Conveyance ("direct"/"enterprise") only *requests* attestation; the optional
// `attestationPolicy` is what turns it into a decision, and a plugin that
// requests attestation with no policy says so once at build time. The policy
// itself is tested at `PasskeyCeremony`'s interface (`PasskeyCeremony.test.ts`).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Passkey from "../src/Passkey.ts";
import { mockWebAuthn } from "./passkeyTestFixtures.ts";
import { buildLayer } from "./passkeyTestLayers.ts";

const YUBIKEY = "ee882879-721c-4913-9775-3dfcce97072a";

describe("HSK-002: conveyance is not verification", () => {
  /** Builds the plugin once under a capturing logger and answers every warning it logged. */
  const warningsFor = (layer: ReturnType<typeof buildLayer>) => {
    const warnings: Array<string> = [];
    const logger = Logger.make((options) => {
      if (options.logLevel === "Warn") warnings.push(String(options.message));
    });
    return Effect.gen(function* () {
      yield* Passkey.Passkey;
      return warnings;
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Logger.layer([logger])))));
  };

  it.effect("no policy + direct conveyance logs one warning naming the missing policy", () =>
    Effect.gen(function* () {
      const warnings = yield* warningsFor(buildLayer(mockWebAuthn(), { attestation: "direct" }));
      const attestationWarnings = warnings.filter((message) =>
        message.includes("attestationPolicy"),
      );
      assert.strictEqual(attestationWarnings.length, 1);
    }),
  );

  it.effect("a policy (or the default none conveyance) logs no such warning", () =>
    Effect.gen(function* () {
      const withPolicy = yield* warningsFor(
        buildLayer(mockWebAuthn(), {
          attestation: "enterprise",
          attestationPolicy: { trustedAaguids: [YUBIKEY] },
        }),
      );
      const byDefault = yield* warningsFor(buildLayer(mockWebAuthn()));
      assert.deepStrictEqual(
        [...withPolicy, ...byDefault].filter((message) => message.includes("attestationPolicy")),
        [],
      );
    }),
  );
});
