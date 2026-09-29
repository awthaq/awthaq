// BEH-EA-246/242: `ScimRecords`, one contract suite over both layers. `layerSql` is
// migrated through the plugin's own real `migrations` (and, under `pnpm run test:pg`,
// runs on Postgres), so the two unique rules — a user's `userName` and a resource's
// `externalId`, each per connection and kind — are real database constraints.
import { Migrations } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scim from "../src/Scim.ts";
import * as ScimRecords from "../src/ScimRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const SqlLive = TestSql.layer("scim_ScimRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Scim.Scim.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = ScimRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (name: string, layer: Layer.Layer<ScimRecords.ScimRecords, unknown, never>): void => {
  describe(name, () => {
    it.effect(
      "a connection is found by its token hash, listed per organization, and revocable once",
      () =>
        Effect.gen(function* () {
          const records = yield* ScimRecords.ScimRecords;
          const created = yield* records.createConnection({
            id: "c1",
            organizationId: "org-1",
            name: "Okta",
            tokenHash: "hash-1",
          });
          assert.isTrue(Option.isNone(created.revokedAt));
          const found = yield* records.findConnectionByTokenHash("hash-1");
          assert.isTrue(Option.isSome(found) && found.value.id === "c1");
          assert.isTrue(Option.isNone(yield* records.findConnectionByTokenHash("hash-2")));
          yield* records.createConnection({
            id: "c2",
            organizationId: "org-2",
            name: "Entra",
            tokenHash: "hash-2",
          });
          assert.deepStrictEqual(
            (yield* records.listConnections("org-1")).map((row) => row.id),
            ["c1"],
          );
          const revoked = yield* records.revokeConnection("org-1", "c1");
          assert.isTrue(Option.isSome(revoked.revokedAt));
          // Idempotent: revoking again keeps the first time.
          const again = yield* records.revokeConnection("org-1", "c1");
          assert.deepStrictEqual(again.revokedAt, revoked.revokedAt);
          // Another organization cannot revoke it.
          const foreign = yield* records.revokeConnection("org-2", "c1").pipe(Effect.flip);
          assert.strictEqual(foreign._tag, "ScimRecordNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("links round-trip and are found by id, userName and externalId", () =>
      Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        yield* records.link({
          connectionId: "c1",
          kind: "User",
          resourceId: "u1",
          name: "ada@acme.example",
          externalId: "dir-1",
        });
        const byId = yield* records.find("c1", "User", "u1");
        assert.isTrue(Option.isSome(byId));
        if (Option.isSome(byId)) {
          assert.deepStrictEqual(byId.value.name, Option.some("ada@acme.example"));
          assert.deepStrictEqual(byId.value.externalId, Option.some("dir-1"));
        }
        assert.isTrue(Option.isSome(yield* records.findByName("c1", "User", "ada@acme.example")));
        assert.isTrue(Option.isSome(yield* records.findByExternalId("c1", "User", "dir-1")));
        // Scoped by connection and kind.
        assert.isTrue(Option.isNone(yield* records.find("c2", "User", "u1")));
        assert.isTrue(Option.isNone(yield* records.find("c1", "Group", "u1")));
        assert.isTrue(Option.isNone(yield* records.findByExternalId("c2", "User", "dir-1")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("userName and externalId are unique per connection and kind, never across them", () =>
      Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        yield* records.link({
          connectionId: "c1",
          kind: "User",
          resourceId: "u1",
          name: "ada@acme.example",
          externalId: "dir-1",
        });
        const sameName = yield* records
          .link({ connectionId: "c1", kind: "User", resourceId: "u2", name: "ada@acme.example" })
          .pipe(Effect.flip);
        assert.strictEqual(sameName._tag, "ScimLinkConflict");
        assert.strictEqual(sameName.field, "name");
        const sameExternal = yield* records
          .link({
            connectionId: "c1",
            kind: "User",
            resourceId: "u2",
            name: "bo@acme.example",
            externalId: "dir-1",
          })
          .pipe(Effect.flip);
        assert.strictEqual(sameExternal._tag, "ScimLinkConflict");
        assert.strictEqual(sameExternal.field, "externalId");
        // Another connection, and another kind, may reuse both.
        yield* records.link({
          connectionId: "c2",
          kind: "User",
          resourceId: "u3",
          name: "ada@acme.example",
          externalId: "dir-1",
        });
        yield* records.link({
          connectionId: "c1",
          kind: "Group",
          resourceId: "g1",
          externalId: "dir-1",
        });
        // Rows with no name/externalId never collide with each other.
        yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "g2" });
        yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "g3" });
        // The failed writes left nothing behind.
        assert.isTrue(Option.isNone(yield* records.find("c1", "User", "u2")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("setExternalId sets, clears and refuses a taken id; unlink frees the keys", () =>
      Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        yield* records.link({
          connectionId: "c1",
          kind: "User",
          resourceId: "u1",
          name: "a",
          externalId: "e1",
        });
        yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u2", name: "b" });
        const taken = yield* records.setExternalId("c1", "User", "u2", "e1").pipe(Effect.flip);
        assert.strictEqual(taken._tag, "ScimLinkConflict");
        const set = yield* records.setExternalId("c1", "User", "u2", "e2");
        assert.deepStrictEqual(set.externalId, Option.some("e2"));
        const cleared = yield* records.setExternalId("c1", "User", "u2", null);
        assert.isTrue(Option.isNone(cleared.externalId));
        const missing = yield* records.setExternalId("c1", "User", "nope", "e9").pipe(Effect.flip);
        assert.strictEqual(missing._tag, "ScimRecordNotFound");
        yield* records.unlink("c1", "User", "u1");
        assert.isTrue(Option.isNone(yield* records.find("c1", "User", "u1")));
        yield* records.link({
          connectionId: "c1",
          kind: "User",
          resourceId: "u9",
          name: "a",
          externalId: "e1",
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list pages oldest-first and reports the total", () =>
      Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        for (const n of [1, 2, 3, 4]) {
          yield* records.link({
            connectionId: "c1",
            kind: "User",
            resourceId: `u${n}`,
            name: `n${n}`,
          });
        }
        yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "g1" });
        yield* records.link({ connectionId: "c2", kind: "User", resourceId: "x1", name: "x" });
        const page = yield* records.list("c1", "User", { offset: 1, limit: 2 });
        assert.strictEqual(page.total, 4);
        assert.strictEqual(page.items.length, 2);
        const all = yield* records.list("c1", "User", { offset: 0, limit: 10 });
        assert.sameMembers(
          all.items.map((row) => row.resourceId),
          ["u1", "u2", "u3", "u4"],
        );
        assert.strictEqual((yield* records.list("c1", "Group", { offset: 0, limit: 10 })).total, 1);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("ScimRecords (layerMemory)", ScimRecords.layerMemory);
suite("ScimRecords (layerSql)", SqlLayer);
