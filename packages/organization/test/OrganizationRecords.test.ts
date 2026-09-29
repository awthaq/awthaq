// spec.md's "Organization entity & CRUD": the same contract-suite-over-both-layers
// pattern `@awthaq/admin`'s own `ImpersonationRecords.test.ts` establishes.
// `layerSql` here is migrated via `Organization.Organization`'s own real
// `migrations` (`Migrations.run`, `@awthaq/core`) rather than a hand-rolled
// inline `CREATE TABLE` — BAM-002 (.issues/high) verification, the same
// `packages/jwt/test/RevocationStore.test.ts` establishes.
import { Migrations } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Organization from "../src/Organization.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const MemoryLayer = OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = TestSql.layer("organization_OrganizationRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = OrganizationRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (
  name: string,
  layer: Layer.Layer<OrganizationRecords.OrganizationRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findById round-trips every field", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        const created = yield* records.create({
          name: "Acme",
          slug: "acme",
          logo: "https://example.com/logo.png",
          metadata: '{"plan":"pro"}',
        });
        const found = yield* records.findById(created.id);
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.strictEqual(found.value.name, "Acme");
          assert.strictEqual(found.value.slug, "acme");
          assert.deepStrictEqual(found.value.logo, Option.some("https://example.com/logo.png"));
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("create rejects a slug collision", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        yield* records.create({ name: "Acme", slug: "acme" });
        const failure = yield* records.create({ name: "Acme 2", slug: "acme" }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OrganizationRecordSlugTaken");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("findBySlug finds the same record findById does", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        const created = yield* records.create({ name: "Acme", slug: "acme" });
        const found = yield* records.findBySlug("acme");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) assert.strictEqual(found.value.id, created.id);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("update changes the given fields and rejects a slug collision", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        const created = yield* records.create({ name: "Acme", slug: "acme" });
        yield* records.create({ name: "Globex", slug: "globex" });

        const updated = yield* records.update(created.id, { name: "Acme Inc" });
        assert.strictEqual(updated.name, "Acme Inc");
        assert.strictEqual(updated.slug, "acme");

        const collision = yield* records.update(created.id, { slug: "globex" }).pipe(Effect.flip);
        assert.strictEqual(collision._tag, "OrganizationRecordSlugTaken");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("update fails for an unknown id", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        const failure = yield* records.update("does-not-exist", { name: "x" }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OrganizationRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("delete removes the record; a second delete fails", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        const created = yield* records.create({ name: "Acme", slug: "acme" });
        yield* records.delete(created.id);
        const found = yield* records.findById(created.id);
        assert.isTrue(Option.isNone(found));
        const failure = yield* records.delete(created.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OrganizationRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listByIds returns only the matching records, ignoring unknown ids", () =>
      Effect.gen(function* () {
        const records = yield* OrganizationRecords.OrganizationRecords;
        const a = yield* records.create({ name: "Acme", slug: "acme" });
        const b = yield* records.create({ name: "Globex", slug: "globex" });
        const found = yield* records.listByIds([a.id, "does-not-exist", b.id]);
        assert.strictEqual(found.length, 2);
        assert.sameMembers(
          found.map((r) => r.id),
          [a.id, b.id],
        );
        const empty = yield* records.listByIds([]);
        assert.strictEqual(empty.length, 0);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("OrganizationRecords (layerMemory)", MemoryLayer);
suite("OrganizationRecords (layerSql)", SqlLayer);
