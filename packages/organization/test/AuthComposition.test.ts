// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any` — mirrors
// `@awthaq/admin`'s own `AuthComposition.test.ts`.
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Organization from "../src/Organization.ts";

describe("Auth.make([Organization])", () => {
  it("composes a real plugin", () => {
    const auth = Auth.make([Organization.Organization]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      {
        id: "organization",
        apiVersion: 1,
        tables: [
          "organization_org",
          "organization_membership",
          "organization_invitation",
          "organization_team",
          "organization_team_membership",
          "organization_team_closure",
          "organization_role",
          "organization_active_context",
          "organization_oauth_connection",
          "organization_oauth_connection_domain",
        ],
        dependsOn: [],
      },
    ]);
  });
});
