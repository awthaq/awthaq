// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes any real plugin satisfying `AuthPlugin.Any` — mirrors
// `@awthaq/passkey`'s own `AuthComposition.test.ts`.
import { Auth, AuthPlugin } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import { Organization } from "@awthaq/organization";
import { Password } from "@awthaq/password";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";
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
        tenancy: {
          admin_impersonation: AuthPlugin.Table.partitioned("tenantId"),
          admin_impersonation_chain: AuthPlugin.Table.global(
            "append-only hash chain over every tenant's episodes; verifyChain reads it whole",
          ),
        },
        dependsOn: [],
        groups: ["admin"],
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

// BAM-005/BAM-009: destructive and credential administration is its own opt-in plugin, admin tier,
// so `Admin` alone composes without the erasure cascade, the password credential and mailer it needs.
describe("Auth.make([Admin, Password, AdminAccounts])", () => {
  const auth = Auth.make([Admin.Admin, Password.Password, AdminAccounts.AdminAccounts]);

  // ADR-EA-048: an administrator-set password goes through Password's credential module and policy,
  // so a tuple without Password is refused before it is built (BEH-EA-329).
  it("refuses AdminAccounts without Password, and orders Password before it", () => {
    // @ts-expect-error -- plugin "admin.accounts" depends on plugin "password", which is not in the list
    Auth.make([Admin.Admin, AdminAccounts.AdminAccounts]);
    const ids = auth.manifest.plugins.map((plugin) => plugin.id);
    assert.isBelow(ids.indexOf("password"), ids.indexOf("admin.accounts"));
    const accounts = auth.manifest.plugins.find((plugin) => plugin.id === "admin.accounts");
    assert.deepStrictEqual(accounts?.dependsOn, ["password"]);
  });

  it("puts the accounts group on the admin tier, out of the public API", () => {
    assert.include(Object.keys(auth.adminApi.groups), "admin.accounts");
    assert.notInclude(Object.keys(auth.publicApi.groups), "admin.accounts");
    assert.notInclude(Object.keys(Auth.make([Admin.Admin]).adminApi.groups), "admin.accounts");
  });
});
