// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any` — mirrors
// `@awthaq/passkey`'s own `AuthComposition.test.ts`.
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import { Organization } from "@awthaq/organization";
import * as Admin from "../src/Admin.ts";
import * as AdminTenants from "../src/AdminTenants.ts";

describe("Auth.make([Admin])", () => {
  it("composes a real plugin", () => {
    const auth = Auth.make([Admin.Admin]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      {
        id: "admin",
        apiVersion: 1,
        tables: ["admin_impersonation", "admin_impersonation_chain"],
        dependsOn: [],
      },
    ]);
  });
});

// EP-003 (ADR-EA-018): the tenant-administration sub-surface is its own plugin that
// `dependsOn: [Organization]`, so `Admin` alone still composes without it.
describe("Auth.make([Organization, Admin, AdminTenants])", () => {
  const auth = Auth.make([Organization.Organization, Admin.Admin, AdminTenants.AdminTenants]);

  it("orders the organization plugin before the one that depends on it", () => {
    const ids = auth.manifest.plugins.map((plugin) => plugin.id);
    assert.isBelow(ids.indexOf("organization"), ids.indexOf("admin.tenants"));
    const tenants = auth.manifest.plugins.find((plugin) => plugin.id === "admin.tenants");
    assert.deepStrictEqual(tenants?.dependsOn, ["organization"]);
  });

  it("puts the tenant group on the admin tier, out of the public API", () => {
    assert.include(Object.keys(auth.adminApi.groups), "admin.tenants");
    assert.notInclude(Object.keys(auth.publicApi.groups), "admin.tenants");
    // The plain Admin composition is unchanged: no organization plugin, no tenant group.
    const plain = Auth.make([Admin.Admin]);
    assert.notInclude(Object.keys(plain.adminApi.groups), "admin.tenants");
  });
});
