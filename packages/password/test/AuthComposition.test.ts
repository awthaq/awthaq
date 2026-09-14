// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any`, not just the toy
// `Ping`/`Pong` fixtures `packages/core/test/AuthPlugin.test.ts` uses to
// exercise the composition machinery itself. `Password.layer` needed to be
// a `static` on the `Password` class (not a sibling export) for exactly
// this to type-check — `Auth.make` reads `layer` directly off each plugin
// class (`AuthPlugin.Any["layer"]`).
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Password from "../src/Password.ts";

describe("Auth.make([Password])", () => {
  it("composes a real plugin, not just AuthPlugin.test.ts's toy fixtures", () => {
    const auth = Auth.make([Password.Password]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      { id: "password", apiVersion: 1, tables: [], dependsOn: [] },
    ]);
  });
});
