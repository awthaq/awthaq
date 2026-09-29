// EP-004 (ADR-EA-018): `ConnectionRecords`, the `organization_oauth_connection`
// store — one contract suite over both layers, `layerSql` migrated through the
// plugin's own real `migrations` (and, under `pnpm run test:pg`, on Postgres).
import { Migrations } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ConnectionRecords from "../src/ConnectionRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const SqlLive = TestSql.layer("organization_ConnectionRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = ConnectionRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const input = (
  id: string,
  organizationId: string,
  overrides: Partial<ConnectionRecords.ConnectionInput> = {},
): ConnectionRecords.ConnectionInput => ({
  id,
  organizationId,
  kind: "oidc",
  name: "Acme SSO",
  issuer: "https://idp.acme.example",
  discoveryUrl: "https://idp.acme.example/.well-known/openid-configuration",
  clientId: "client-1",
  clientSecret: "sealed-envelope",
  scopes: ["openid", "email"],
  emailDomains: ["acme.example"],
  ...overrides,
});

const suite = (
  name: string,
  layer: Layer.Layer<ConnectionRecords.ConnectionRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findById round-trips every field, scoped to its organization", () =>
      Effect.gen(function* () {
        const records = yield* ConnectionRecords.ConnectionRecords;
        const created = yield* records.create(input("c1", "org-1"));
        const found = yield* records.findById("org-1", "c1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.strictEqual(found.value.name, "Acme SSO");
          assert.strictEqual(found.value.kind, "oidc");
          assert.deepStrictEqual(found.value.issuer, Option.some("https://idp.acme.example"));
          assert.deepStrictEqual(found.value.clientSecret, Option.some("sealed-envelope"));
          assert.deepStrictEqual(found.value.scopes, ["openid", "email"]);
          assert.deepStrictEqual(found.value.emailDomains, ["acme.example"]);
          assert.isTrue(Option.isNone(found.value.userinfoEndpoint));
          assert.strictEqual(
            DateTime.toEpochMillis(found.value.createdAt),
            DateTime.toEpochMillis(created.createdAt),
          );
        }
        // Another organization cannot read it by id.
        assert.isTrue(Option.isNone(yield* records.findById("org-2", "c1")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("an email domain routes to exactly one connection across organizations", () =>
      Effect.gen(function* () {
        const records = yield* ConnectionRecords.ConnectionRecords;
        yield* records.create(input("c1", "org-1"));
        const clash = yield* records
          .create(
            input("c2", "org-2", { emailDomains: ["ACME.example".toLowerCase(), "other.example"] }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(clash._tag, "ConnectionDomainTaken");
        // The failed create left nothing behind — not the row, not the second domain.
        assert.isTrue(Option.isNone(yield* records.findById("org-2", "c2")));
        assert.isTrue(Option.isNone(yield* records.findByEmailDomain("other.example")));
        const routed = yield* records.findByEmailDomain("acme.example");
        assert.isTrue(Option.isSome(routed) && routed.value.id === "c1");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("update patches fields, null clears, and domains are replaced atomically", () =>
      Effect.gen(function* () {
        const records = yield* ConnectionRecords.ConnectionRecords;
        yield* records.create(input("c1", "org-1"));
        yield* records.create(input("c2", "org-1", { emailDomains: ["second.example"] }));
        const patched = yield* records.update("org-1", "c1", {
          name: "Renamed",
          clientSecret: null,
          userinfoEndpoint: "https://idp.acme.example/userinfo",
          emailDomains: ["acme.example", "acme.test"],
        });
        assert.strictEqual(patched.name, "Renamed");
        assert.isTrue(Option.isNone(patched.clientSecret));
        assert.deepStrictEqual(
          patched.userinfoEndpoint,
          Option.some("https://idp.acme.example/userinfo"),
        );
        assert.sameMembers([...patched.emailDomains], ["acme.example", "acme.test"]);
        assert.isTrue(
          DateTime.toEpochMillis(patched.updatedAt) >= DateTime.toEpochMillis(patched.createdAt),
        );
        // A domain another connection holds is refused, and the connection keeps its old set.
        const clash = yield* records
          .update("org-1", "c1", { emailDomains: ["second.example"] })
          .pipe(Effect.flip);
        assert.strictEqual(clash._tag, "ConnectionDomainTaken");
        const after = yield* records.findById("org-1", "c1");
        assert.isTrue(Option.isSome(after));
        if (Option.isSome(after)) {
          assert.sameMembers([...after.value.emailDomains], ["acme.example", "acme.test"]);
        }
        const missing = yield* records.update("org-2", "c1", { name: "x" }).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "ConnectionRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list is per organization and remove releases the connection's domains", () =>
      Effect.gen(function* () {
        const records = yield* ConnectionRecords.ConnectionRecords;
        yield* records.create(input("c1", "org-1"));
        yield* records.create(input("c2", "org-1", { emailDomains: [] }));
        yield* records.create(input("c3", "org-2", { emailDomains: ["other.example"] }));
        assert.sameMembers(
          (yield* records.listByOrganization("org-1")).map((row) => row.id),
          ["c1", "c2"],
        );
        yield* records.remove("org-1", "c1");
        assert.isTrue(Option.isNone(yield* records.findByEmailDomain("acme.example")));
        // The freed domain can be claimed by someone else.
        yield* records.create(input("c4", "org-2"));
        const missing = yield* records.remove("org-2", "c1").pipe(Effect.flip);
        assert.strictEqual(missing._tag, "ConnectionRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "removeAllForOrganization sweeps only that organization's connections and domains",
      () =>
        Effect.gen(function* () {
          const records = yield* ConnectionRecords.ConnectionRecords;
          yield* records.create(input("c1", "org-1"));
          yield* records.create(input("c2", "org-2", { emailDomains: ["other.example"] }));
          yield* records.removeAllForOrganization("org-1");
          assert.strictEqual((yield* records.listByOrganization("org-1")).length, 0);
          assert.isTrue(Option.isNone(yield* records.findByEmailDomain("acme.example")));
          assert.strictEqual((yield* records.listByOrganization("org-2")).length, 1);
          assert.isTrue(Option.isSome(yield* records.findByEmailDomain("other.example")));
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite("ConnectionRecords (layerMemory)", ConnectionRecords.layerMemory);
suite("ConnectionRecords (layerSql)", SqlLayer);
