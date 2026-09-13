// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any` — mirrors
// `@effect-auth/password`'s own `AuthComposition.test.ts`.
import { Auth } from "@effect-auth/core";
import { assert, describe, it } from "@effect/vitest";
import { Passkey } from "../src/index.ts";

describe("Auth.make([Passkey])", () => {
  it("composes a real plugin", () => {
    const auth = Auth.make([Passkey.Passkey]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      {
        id: "passkey",
        apiVersion: 1,
        tables: ["passkey_credential", "passkey_challenge"],
        dependsOn: [],
      },
    ]);
  });
});
