// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any` — mirrors
// `@awthaq/passkey`'s own `AuthComposition.test.ts`.
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Admin from "../src/Admin.ts";

describe("Auth.make([Admin])", () => {
  it("composes a real plugin", () => {
    const auth = Auth.make([Admin.Admin]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      {
        id: "admin",
        apiVersion: 1,
        tables: ["admin_impersonation"],
        dependsOn: [],
      },
    ]);
  });
});
