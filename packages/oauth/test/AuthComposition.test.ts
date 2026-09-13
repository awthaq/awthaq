// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes a real `oauth` plugin the same way `@awthaq/password`'s own
// `AuthComposition.test.ts` proves for `password` — `OAuth.layer` needed to
// be a `static` on the `OAuth` class for exactly this to type-check.
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import { OAuth } from "../src/index.ts";

describe("Auth.make([OAuth])", () => {
  it("composes a real plugin", () => {
    const auth = Auth.make([OAuth.OAuth]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      { id: "oauth", apiVersion: 1, tables: [], dependsOn: [] },
    ]);
  });
});
