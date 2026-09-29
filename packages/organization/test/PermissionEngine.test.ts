// spec.md's "Roles & permissions": pure, unit-level coverage of
// `PermissionEngine.ts` — no HTTP layer, no service tag, no Effect provided.
import { assert, describe, it } from "@effect/vitest";
import * as PermissionEngine from "../src/PermissionEngine.ts";

describe("PermissionEngine", () => {
  it("member holds no mutating statements by default (read-only)", () => {
    const statementsByRole = PermissionEngine.statementsByRoleFrom({});
    const effective = PermissionEngine.effectivePermissions(["member"], statementsByRole);
    assert.isFalse(PermissionEngine.hasPermission(effective, "organization", "update"));
    assert.isFalse(PermissionEngine.hasPermission(effective, "member", "delete"));
  });

  it("owner and admin can manage the organization, members, invitations, and teams", () => {
    const statementsByRole = PermissionEngine.statementsByRoleFrom({});
    for (const role of ["owner", "admin"] as const) {
      const effective = PermissionEngine.effectivePermissions([role], statementsByRole);
      assert.isTrue(PermissionEngine.hasPermission(effective, "organization", "update"));
      assert.isTrue(PermissionEngine.hasPermission(effective, "member", "create"));
      assert.isTrue(PermissionEngine.hasPermission(effective, "invitation", "create"));
      assert.isTrue(PermissionEngine.hasPermission(effective, "team", "create"));
    }
  });

  // OHS-005: owner is strictly above admin, so the last-owner invariant is
  // load-bearing and `canGrant` stops an admin minting an owner.
  it("admin lacks organization:delete; owner holds it", () => {
    const statementsByRole = PermissionEngine.statementsByRoleFrom({});
    const owner = PermissionEngine.effectivePermissions(["owner"], statementsByRole);
    const admin = PermissionEngine.effectivePermissions(["admin"], statementsByRole);
    assert.isTrue(PermissionEngine.hasPermission(owner, "organization", "delete"));
    assert.isFalse(PermissionEngine.hasPermission(admin, "organization", "delete"));
    assert.isTrue(PermissionEngine.canGrant(admin, owner));
    assert.isFalse(PermissionEngine.canGrant(owner, admin));
  });

  // RZS-005/N8: a custom or dynamic role can never redefine a built-in tier.
  it("custom and dynamic statements cannot overwrite the built-in owner/admin/member", () => {
    const statementsByRole = PermissionEngine.statementsByRoleFrom(
      { owner: { billing: ["update"] } },
      { admin: { organization: ["delete"] }, member: { team: ["delete"] } },
    );
    assert.deepStrictEqual(statementsByRole.get("owner"), PermissionEngine.defaultStatements.owner);
    assert.deepStrictEqual(statementsByRole.get("admin"), PermissionEngine.defaultStatements.admin);
    assert.deepStrictEqual(
      statementsByRole.get("member"),
      PermissionEngine.defaultStatements.member,
    );
  });

  it("effectivePermissions unions every held role's statements", () => {
    const statementsByRole = PermissionEngine.statementsByRoleFrom({
      billing: { billing: ["update"] },
    });
    const effective = PermissionEngine.effectivePermissions(
      ["member", "billing"],
      statementsByRole,
    );
    assert.isTrue(PermissionEngine.hasPermission(effective, "billing", "update"));
    assert.isFalse(PermissionEngine.hasPermission(effective, "organization", "update"));
  });

  it("an unrecognized role name contributes nothing, rather than throwing", () => {
    const statementsByRole = PermissionEngine.statementsByRoleFrom({});
    const effective = PermissionEngine.effectivePermissions(
      ["deleted-dynamic-role"],
      statementsByRole,
    );
    assert.deepStrictEqual(effective, {});
  });

  it("custom static roles from OrganizationConfig.permissionStatements are recognized", () => {
    const statementsByRole = PermissionEngine.statementsByRoleFrom({
      billingManager: { billing: ["update", "delete"] },
    });
    const effective = PermissionEngine.effectivePermissions(["billingManager"], statementsByRole);
    assert.isTrue(PermissionEngine.hasPermission(effective, "billing", "delete"));
  });

  describe("canGrant (the self-escalation guard)", () => {
    it("allows granting a subset of the granter's own permissions", () => {
      const granter = { organization: ["update", "delete"], member: ["create"] };
      const requested = { organization: ["update"] };
      assert.isTrue(PermissionEngine.canGrant(requested, granter));
    });

    it("rejects granting a permission the granter doesn't already hold", () => {
      const granter = { organization: ["update"] };
      const requested = { organization: ["update", "delete"] };
      assert.isFalse(PermissionEngine.canGrant(requested, granter));
    });

    it("rejects granting an entirely new resource the granter has no statements for", () => {
      const granter = { organization: ["update"] };
      const requested = { billing: ["update"] };
      assert.isFalse(PermissionEngine.canGrant(requested, granter));
    });
  });
});
