// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any` — mirrors
// `@awthaq/password`'s own `AuthComposition.test.ts`.
import { Auth, AuthPlugin } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Passkey from "../src/Passkey.ts";

describe("Auth.make([Passkey])", () => {
  it("composes a real plugin", () => {
    const auth = Auth.make([Passkey.Passkey]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      {
        id: "passkey",
        apiVersion: 1,
        tables: ["passkey_credential", "passkey_challenge", "passkey_user_handle"],
        tenancy: {
          passkey_credential: AuthPlugin.Table.global(
            "user-attached credential; the directory is global",
          ),
          passkey_challenge: AuthPlugin.Table.global(
            "a ceremony starts before any tenant is known",
          ),
          passkey_user_handle: AuthPlugin.Table.global("user-attached; the directory is global"),
        },
        dependsOn: [],
        groups: [
          "passkey",
          "passkey.authenticate",
          "passkey.credentials",
          "passkey.reauthenticate",
          "passkey.wellKnown",
        ],
      },
    ]);
  });
});
