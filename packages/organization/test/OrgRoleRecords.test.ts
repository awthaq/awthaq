// spec.md's "Dynamic access control": the same contract-suite-over-both-layers
// pattern `MembershipRecords.test.ts` uses. `layerSql` here is migrated via
// `Organization.Organization`'s own real `migrations` (`Migrations.run`,
// `@awthaq/core`) rather than a hand-rolled inline `CREATE TABLE` —
// BAM-002 (.issues/high) verification, the same
// `packages/jwt/test/RevocationStore.test.ts` establishes.
import { Migrations } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Organization from "../src/Organization.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const MemoryLayer = OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = TestSql.layer("organization_OrgRoleRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = OrgRoleRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const orgId = "org-1";

const suite = (
  name: string,
  layer: Layer.Layer<OrgRoleRecords.OrgRoleRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findById round-trips permission", () =>
      Effect.gen(function* () {
        const records = yield* OrgRoleRecords.OrgRoleRecords;
        const record = yield* records.create({
          organizationId: orgId,
          role: "billing-admin",
          permission: { billing: ["read", "update"] },
        });
        const found = yield* records.findById(orgId, record.id);
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.permission, { billing: ["read", "update"] });
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("create rejects a duplicate role name within the same organization", () =>
      Effect.gen(function* () {
        const records = yield* OrgRoleRecords.OrgRoleRecords;
        yield* records.create({ organizationId: orgId, role: "dup", permission: {} });
        const failure = yield* records
          .create({ organizationId: orgId, role: "dup", permission: {} })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OrgRoleRecordNameTaken");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("the same role name is allowed across different organizations", () =>
      Effect.gen(function* () {
        const records = yield* OrgRoleRecords.OrgRoleRecords;
        yield* records.create({ organizationId: "org-a", role: "dup", permission: {} });
        yield* records.create({ organizationId: "org-b", role: "dup", permission: {} });
        assert.strictEqual((yield* records.listByOrganization("org-a")).length, 1);
        assert.strictEqual((yield* records.listByOrganization("org-b")).length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("update replaces the permission map; fails for an unknown id", () =>
      Effect.gen(function* () {
        const records = yield* OrgRoleRecords.OrgRoleRecords;
        const record = yield* records.create({ organizationId: orgId, role: "r", permission: {} });
        const updated = yield* records.update(orgId, record.id, { billing: ["read"] });
        assert.deepStrictEqual(updated.permission, { billing: ["read"] });
        const failure = yield* records.update(orgId, "no-such-id", {}).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OrgRoleRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("remove deletes the role; a second remove fails", () =>
      Effect.gen(function* () {
        const records = yield* OrgRoleRecords.OrgRoleRecords;
        const record = yield* records.create({ organizationId: orgId, role: "r", permission: {} });
        yield* records.remove(orgId, record.id);
        const found = yield* records.findById(orgId, record.id);
        assert.isTrue(Option.isNone(found));
        const failure = yield* records.remove(orgId, record.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OrgRoleRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("countByOrganization counts only that organization's roles", () =>
      Effect.gen(function* () {
        const records = yield* OrgRoleRecords.OrgRoleRecords;
        yield* records.create({ organizationId: "org-a", role: "r1", permission: {} });
        yield* records.create({ organizationId: "org-a", role: "r2", permission: {} });
        yield* records.create({ organizationId: "org-b", role: "r1", permission: {} });
        assert.strictEqual(yield* records.countByOrganization("org-a"), 2);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("OrgRoleRecords (layerMemory)", MemoryLayer);
suite("OrgRoleRecords (layerSql)", SqlLayer);
