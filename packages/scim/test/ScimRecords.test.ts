// BEH-EA-246/242: `ScimRecords`, one contract suite over both layers. `layerSql` is
// migrated through the plugin's own real `migrations` (and, under `pnpm run test:pg`,
// runs on Postgres), so the two unique rules — a user's `userName` and a resource's
// `externalId`, each per connection and kind — are real database constraints.
import { Migrations } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scim from "../src/Scim.ts";
import * as ScimRecords from "../src/ScimRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

/** The witness these tests present where a bearer token, erasure or export would. */
const grant = TenantScoped.crossTenant("scim records test: a cross-organization caller");

const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => assert.fail(message),
};

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
          const found = yield* records.findConnectionByTokenHash(grant, "hash-1");
          assert.isTrue(Option.isSome(found) && found.value.id === "c1");
          assert.isTrue(Option.isNone(yield* records.findConnectionByTokenHash(grant, "hash-2")));
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
        assert.strictEqual(sameName._tag === "ScimLinkConflict" ? sameName.field : "", "name");
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
        assert.strictEqual(
          sameExternal._tag === "ScimLinkConflict" ? sameExternal.field : "",
          "externalId",
        );
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

    it.effect(
      "unlinkResource drops a user's links across connections and leaves groups and other users",
      () =>
        Effect.gen(function* () {
          const records = yield* ScimRecords.ScimRecords;
          yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u1", name: "a" });
          yield* records.link({ connectionId: "c2", kind: "User", resourceId: "u1", name: "a" });
          yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u2", name: "b" });
          yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "u1" });
          assert.deepStrictEqual(
            (yield* records.linksOfResource(grant, "User", "u1")).map((row) => row.connectionId),
            ["c1", "c2"],
          );
          yield* records.unlinkResource(grant, "User", "u1");
          assert.deepStrictEqual(yield* records.linksOfResource(grant, "User", "u1"), []);
          assert.isTrue(Option.isSome(yield* records.find("c1", "User", "u2")));
          assert.isTrue(Option.isSome(yield* records.find("c1", "Group", "u1")));
          // Idempotent.
          yield* records.unlinkResource(grant, "User", "u1");
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

// Plan 05: the tenant-isolation conformance suite. `scim_connection` is Keyed by `organizationId`;
// `scim_resource` is Derived through its connection. A bearer token is the capability that finds a
// connection before any tenant is known, and erasure and export read a person's links in every
// connection: those take a witness. Everything else on a resource is keyed by a connection id the
// caller already resolved through its token.
let isolationCounter = 0;
interface Row {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly tokenHash: string;
  readonly resourceId: string;
}
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";
const using = <A, E, R>(use: (records: ScimRecords.ScimRecordsShape) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(ScimRecords.ScimRecords, use);

const insertRow = Effect.gen(function* () {
  const records = yield* ScimRecords.ScimRecords;
  isolationCounter += 1;
  const organizationId = yield* Effect.map(
    Tenant.TenantContext,
    Option.getOrElse(() => "platform-organization"),
  );
  const connectionId = `isolation-${isolationCounter}`;
  const tokenHash = `isolation-hash-${isolationCounter}`;
  yield* records.createConnection({
    id: connectionId,
    organizationId,
    name: `Directory ${isolationCounter}`,
    tokenHash,
  });
  const resourceId = `isolation-user-${isolationCounter}`;
  yield* records.link({
    connectionId,
    kind: "User",
    resourceId,
    name: `user-${isolationCounter}`,
  });
  return { connectionId, organizationId, tokenHash, resourceId };
});

type Methods = {
  readonly [K in keyof ScimRecords.ScimRecordsShape]: TestAuth.MethodClass<
    Row,
    ScimRecords.ScimRecords
  >;
};
const derivedElsewhere = (table: string) => ({
  derived: `operates on ${table}; classified in that table's case`,
});
const viaConnection = {
  derived: "keyed by a connection id the caller resolved through its bearer token (a Keyed read)",
};

const connectionMethods: Methods = {
  createConnection: { insert: true },
  findConnectionByTokenHash: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(
            records.findConnectionByTokenHash(grant, row.tokenHash),
            (found) => Option.isSome(found) && found.value.id === row.connectionId,
          ),
        ),
    },
  },
  listConnections: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.listConnections(orgOf(row, as)), (rows) =>
            rows.some((found) => found.id === row.connectionId),
          ),
        ),
    },
  },
  revokeConnection: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records.revokeConnection(orgOf(row, as), row.connectionId).pipe(
            Effect.as(true),
            Effect.catchTag("ScimRecordNotFound", () => Effect.succeed(false)),
          ),
        ),
    },
  },
  removeAllForOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.gen(function* () {
            yield* records.removeAllForOrganization(orgOf(row, as));
            // Keyed by the organization: only that organization's own connection is gone.
            const remaining = yield* records.listConnections(row.organizationId);
            return !remaining.some((found) => found.id === row.connectionId);
          }),
        ),
    },
  },
  link: derivedElsewhere("scim_resource"),
  find: derivedElsewhere("scim_resource"),
  findByName: derivedElsewhere("scim_resource"),
  findByExternalId: derivedElsewhere("scim_resource"),
  list: derivedElsewhere("scim_resource"),
  setExternalId: derivedElsewhere("scim_resource"),
  unlink: derivedElsewhere("scim_resource"),
  linksOfResource: derivedElsewhere("scim_resource"),
  unlinkResource: derivedElsewhere("scim_resource"),
};

const resourceMethods: Methods = {
  createConnection: { insert: true },
  findConnectionByTokenHash: derivedElsewhere("scim_connection"),
  listConnections: derivedElsewhere("scim_connection"),
  revokeConnection: derivedElsewhere("scim_connection"),
  removeAllForOrganization: derivedElsewhere("scim_connection"),
  link: { insert: true },
  find: viaConnection,
  findByName: viaConnection,
  findByExternalId: viaConnection,
  list: viaConnection,
  setExternalId: viaConnection,
  unlink: viaConnection,
  linksOfResource: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(records.linksOfResource(grant, "User", row.resourceId), (links) =>
            links.some((link) => link.connectionId === row.connectionId),
          ),
        ),
    },
  },
  unlinkResource: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* records.find(row.connectionId, "User", row.resourceId);
            yield* records.unlinkResource(grant, "User", row.resourceId);
            return (
              Option.isSome(before) &&
              Option.isNone(yield* records.find(row.connectionId, "User", row.resourceId))
            );
          }),
        ),
    },
  },
};

TestAuth.runTenantIsolationTests(vitestFramework, {
  plugin: Scim.Scim,
  covers: ["scim_connection", "scim_resource"],
  adapters: [
    { name: "layerMemory", layer: ScimRecords.layerMemory },
    { name: "layerSql", layer: SqlLayer },
  ],
  cases: [
    { table: "scim_connection", insert: insertRow, methods: connectionMethods },
    { table: "scim_resource", insert: insertRow, methods: resourceMethods },
  ],
  rls: { layer: SqlLayer },
});
