// spec.md's "Membership": the same contract-suite-over-both-layers pattern
// `OrganizationRecords.test.ts` uses.
import { Users } from "@awthaq/core";
import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { SqlClient } from "effect/unstable/sql";
import { MembershipRecords } from "../src/index.ts";

const MemoryLayer = MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE organization_membership (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        organizationId TEXT NOT NULL,
        role TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = MembershipRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const orgId = "org-1";
const userA = Users.UserId("user-a");
const userB = Users.UserId("user-b");

const suite = (
  name: string,
  layer: Layer.Layer<MembershipRecords.MembershipRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findByUserAndOrg round-trips role", () =>
      Effect.gen(function* () {
        const records = yield* MembershipRecords.MembershipRecords;
        yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
        const found = yield* records.findByUserAndOrg(userA, orgId);
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) assert.deepStrictEqual(found.value.role, ["owner"]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listByOrganization returns every member, oldest-first by default", () =>
      Effect.gen(function* () {
        const records = yield* MembershipRecords.MembershipRecords;
        yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
        yield* TestClock.adjust(Duration.millis(1));
        yield* records.create({ userId: userB, organizationId: orgId, role: ["member"] });

        const all = yield* records.listByOrganization(orgId);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(all[0]?.userId, userA);
        assert.strictEqual(all[1]?.userId, userB);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listByUser returns every organization a user belongs to", () =>
      Effect.gen(function* () {
        const records = yield* MembershipRecords.MembershipRecords;
        yield* records.create({ userId: userA, organizationId: "org-1", role: ["owner"] });
        yield* records.create({ userId: userA, organizationId: "org-2", role: ["member"] });
        const found = yield* records.listByUser(userA);
        assert.strictEqual(found.length, 2);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("countOwners counts only memberships holding owner", () =>
      Effect.gen(function* () {
        const records = yield* MembershipRecords.MembershipRecords;
        yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
        yield* records.create({ userId: userB, organizationId: orgId, role: ["admin", "member"] });
        const count = yield* records.countOwners(orgId);
        assert.strictEqual(count, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("updateRole replaces the role array; fails for an unknown membership", () =>
      Effect.gen(function* () {
        const records = yield* MembershipRecords.MembershipRecords;
        yield* records.create({ userId: userA, organizationId: orgId, role: ["member"] });
        const updated = yield* records.updateRole(userA, orgId, ["admin"]);
        assert.deepStrictEqual(updated.role, ["admin"]);
        const failure = yield* records.updateRole(userB, orgId, ["admin"]).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MembershipRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("remove deletes the membership; a second remove fails", () =>
      Effect.gen(function* () {
        const records = yield* MembershipRecords.MembershipRecords;
        yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
        yield* records.remove(userA, orgId);
        const found = yield* records.findByUserAndOrg(userA, orgId);
        assert.isTrue(Option.isNone(found));
        const failure = yield* records.remove(userA, orgId).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MembershipRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("removeAllForOrganization clears every membership for that org, and no other", () =>
      Effect.gen(function* () {
        const records = yield* MembershipRecords.MembershipRecords;
        yield* records.create({ userId: userA, organizationId: "org-a", role: ["owner"] });
        yield* records.create({ userId: userA, organizationId: "org-b", role: ["owner"] });
        yield* records.removeAllForOrganization("org-a");
        assert.strictEqual((yield* records.listByOrganization("org-a")).length, 0);
        assert.strictEqual((yield* records.listByOrganization("org-b")).length, 1);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("MembershipRecords (layerMemory)", MemoryLayer);
suite("MembershipRecords (layerSql)", SqlLayer);
