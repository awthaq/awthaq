// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any` — mirrors
// `@awthaq/admin`'s own `AuthComposition.test.ts`.
import { Auth, AuthPlugin } from "@awthaq/core";
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
          "organization_domain_owner",
          "organization_domain_claim",
        ],
        tenancy: {
          organization_org: AuthPlugin.Table.keyed("id"),
          organization_membership: AuthPlugin.Table.keyed("organizationId"),
          organization_invitation: AuthPlugin.Table.keyed("organizationId"),
          organization_team: AuthPlugin.Table.keyed("organizationId"),
          organization_team_membership: AuthPlugin.Table.derived("organization_team", "teamId"),
          organization_team_closure: AuthPlugin.Table.derived("organization_team", "descendantId"),
          organization_role: AuthPlugin.Table.keyed("organizationId"),
          organization_active_context: AuthPlugin.Table.derived("sessions", "sessionId"),
          organization_oauth_connection: AuthPlugin.Table.keyed("organizationId"),
          organization_oauth_connection_domain: AuthPlugin.Table.keyed("organizationId"),
          organization_domain_owner: AuthPlugin.Table.keyed("organizationId"),
          organization_domain_claim: AuthPlugin.Table.keyed("organizationId"),
        },
        dependsOn: [],
        groups: ["organization"],
      },
    ]);
  });

  it("exposes its eight system modules, in the manifest and without building a layer (ADR-EA-040)", () => {
    const auth = Auth.make([Organization.Organization]);
    assert.deepStrictEqual(
      auth.manifest.exposes.map((exposed) => [exposed.plugin, exposed.key]),
      [
        "Directory",
        "Teams",
        "Members",
        "Invitations",
        "Roles",
        "ActiveContext",
        "Authority",
        "Deletion",
      ].map((name) => ["organization", `awthaq/plugin/organization/${name}`]),
    );
  });
});
