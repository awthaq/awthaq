// ADR-EA-028: a store outage during passkey sign-in is a typed `StoreUnavailable` (503), never a defect.
import { Errors, Sessions } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Passkey from "../src/Passkey.ts";
import { assertionCredential, mockWebAuthn } from "./passkeyTestFixtures.ts";
import { buildLayer, registerNewUser } from "./passkeyTestLayers.ts";

/** The real in-memory `Sessions`, except that `issue` reports an outage once `down.value` is set. */
const sessionsDownWhen = (down: { value: boolean }) =>
  Layer.effect(
    Sessions.Sessions,
    Effect.gen(function* () {
      const real = yield* Sessions.Sessions;
      return Sessions.Sessions.of({
        ...real,
        issue: (input) =>
          down.value
            ? Effect.fail(new Errors.StoreUnavailable({ operation: "Sessions.issue" }))
            : real.issue(input),
      });
    }),
  );

describe("ADR-EA-028: passkey sign-in during a store outage", () => {
  it.effect("ADR-EA-028: Sessions.issue outage is StoreUnavailable", () => {
    const down = { value: false };
    return Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      yield* registerNewUser("ada@example.com");
      down.value = true;
      const { ceremonyId, options } = yield* passkey.authenticateOptions({});
      const failure = yield* passkey
        .authenticateVerify({ ceremonyId, credential: assertionCredential({ options }) })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(
      Effect.provide(
        buildLayer(mockWebAuthn(), undefined, { coreOverride: sessionsDownWhen(down) }),
      ),
    );
  });
});
