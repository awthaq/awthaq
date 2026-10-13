// EP-004 (ADR-EA-018): `ConnectionRecords`, the `organization_oauth_connection`
// store — one contract suite over both layers, `layerSql` migrated through the
// plugin's own real `migrations` (and, under `pnpm run test:pg`, on Postgres).
import { Migrations } from "@awthaq/core";
import { SealedColumn } from "@awthaq/sql";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ConnectionRecords from "../src/ConnectionRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import { EncryptionLive, ambientOrganization, grant, vitestFramework } from "./support.ts";

const SqlLive = TestSql.layer("organization_ConnectionRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

// The records layers need `Encryption` (the sealed `clientSecret` column); the sealed suite below
// provides a rotatable one itself.
const SqlNeedsEncryption = ConnectionRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);
const SqlLayer = SqlNeedsEncryption.pipe(Layer.provide(EncryptionLive));
const MemoryLayer = ConnectionRecords.layerMemory.pipe(Layer.provide(EncryptionLive));

/** What a sealed secret holds, opened through the substrate. */
const openSecret = (sealed: SealedColumn.Sealed<string>) =>
  Effect.map(SealedColumn.orDie(sealed.open), Redacted.value);

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
  clientSecret: Redacted.make("provider-secret"),
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
          assert.isTrue(Option.isSome(found.value.clientSecret));
          if (Option.isSome(found.value.clientSecret)) {
            assert.strictEqual(
              yield* openSecret(found.value.clientSecret.value),
              "provider-secret",
            );
          }
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
        assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "other.example")));
        const routed = yield* records.findByEmailDomain(grant, "acme.example");
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
        assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "acme.example")));
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
          assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "acme.example")));
          assert.strictEqual((yield* records.listByOrganization("org-2")).length, 1);
          assert.isTrue(Option.isSome(yield* records.findByEmailDomain(grant, "other.example")));
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite("ConnectionRecords (layerMemory)", MemoryLayer);
suite("ConnectionRecords (layerSql)", SqlLayer);

// Plan 05: the tenant-isolation conformance suite. `organization_oauth_connection` and its domain
// table are both Keyed by `organizationId`: a method that takes an organization id can only reach that
// organization's rows (and domains); home-realm discovery is the one cross-organization read and takes a
// witness. It replaces the regex guard of `TenantScoping.test.ts`.
let isolationCounter = 0;
interface Row {
  readonly id: string;
  readonly organizationId: string;
  readonly domain: string;
}
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";
const using = <A, E, R>(
  use: (records: ConnectionRecords.ConnectionRecordsShape) => Effect.Effect<A, E, R>,
) => Effect.flatMap(ConnectionRecords.ConnectionRecords, use);
const present = (row: Row) =>
  using((records) => Effect.map(records.findById(row.organizationId, row.id), Option.isSome));

const isolationMethods: {
  readonly [K in keyof ConnectionRecords.ConnectionRecordsShape]: TestAuth.MethodClass<
    Row,
    ConnectionRecords.ConnectionRecords
  >;
} = {
  create: { insert: true },
  findById: {
    keyed: {
      run: (row, as) =>
        using((records) => Effect.map(records.findById(orgOf(row, as), row.id), Option.isSome)),
    },
  },
  findByEmailDomain: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(
            records.findByEmailDomain(grant, row.domain),
            (found) => Option.isSome(found) && found.value.id === row.id,
          ),
        ),
    },
  },
  listByOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.listByOrganization(orgOf(row, as)), (rows) =>
            rows.some((found) => found.id === row.id),
          ),
        ),
    },
  },
  update: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records
            .update(orgOf(row, as), row.id, { name: "Renamed", emailDomains: [row.domain] })
            .pipe(
              Effect.as(true),
              Effect.catchTag("ConnectionRecordNotFound", () => Effect.succeed(false)),
            ),
        ),
    },
  },
  remove: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records.remove(orgOf(row, as), row.id).pipe(
            Effect.as(true),
            Effect.catchTag("ConnectionRecordNotFound", () => Effect.succeed(false)),
          ),
        ),
    },
  },
  removeAllForOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* present(row);
            yield* records.removeAllForOrganization(orgOf(row, as));
            return before && !(yield* present(row));
          }),
        ),
    },
  },
};

const insertRow = Effect.gen(function* () {
  const records = yield* ConnectionRecords.ConnectionRecords;
  isolationCounter += 1;
  const organizationId = yield* ambientOrganization;
  const domain = `isolation-${isolationCounter}.example`;
  const created = yield* records.create(
    input(`isolation-${isolationCounter}`, organizationId, { emailDomains: [domain] }),
  );
  return { id: created.id, organizationId, domain };
});

TestAuth.runTenantIsolationTests(vitestFramework, {
  plugin: Organization.Organization,
  covers: ["organization_oauth_connection", "organization_oauth_connection_domain"],
  adapters: [
    { name: "layerMemory", layer: MemoryLayer },
    { name: "layerSql", layer: SqlLayer },
  ],
  cases: [
    { table: "organization_oauth_connection", insert: insertRow, methods: isolationMethods },
    { table: "organization_oauth_connection_domain", insert: insertRow, methods: isolationMethods },
  ],
});

// ---- the sealed `clientSecret` column: the substrate's wiring suite over both adapters ----------------------

const writeSecret = (id: string, value: string) =>
  Effect.flatMap(ConnectionRecords.ConnectionRecords, (records) =>
    Effect.asVoid(
      records.create(
        input(id, "org-sealed", { emailDomains: [], clientSecret: Redacted.make(value) }),
      ),
    ),
  );
const readSecret = (id: string) =>
  Effect.flatMap(ConnectionRecords.ConnectionRecords, (records) =>
    Effect.map(records.findById("org-sealed", id), (found) =>
      Option.getOrThrow(Option.flatMap(found, (record) => record.clientSecret)),
    ),
  );

TestAuth.runSealedColumnTests<
  string,
  ConnectionRecords.ConnectionRecords | ConnectionRecords.MemoryEnvelopes
>(vitestFramework, {
  column: ConnectionRecords.clientSecretColumn,
  sample: "provider-secret",
  adapters: [
    {
      name: "layerMemory",
      layer: ConnectionRecords.layerMemory,
      raw: (id) => Effect.flatMap(ConnectionRecords.MemoryEnvelopes, (rows) => rows.stored(id)),
      plant: (id, stored) =>
        Effect.flatMap(ConnectionRecords.MemoryEnvelopes, (rows) => rows.plant(id, stored)),
    },
  ],
  write: writeSecret,
  read: readSecret,
});

TestAuth.runSealedColumnTests<string, ConnectionRecords.ConnectionRecords | SqlClient.SqlClient>(
  vitestFramework,
  {
    column: ConnectionRecords.clientSecretColumn,
    sample: "provider-secret",
    adapters: [
      {
        name: "layerSql",
        layer: SqlNeedsEncryption,
        raw: (id) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{
              readonly value: string;
            }>`SELECT "clientSecret" AS value FROM organization_oauth_connection WHERE id = ${id}`;
            return rows[0]?.value ?? "";
          }),
        plant: (id, stored) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE organization_oauth_connection SET "clientSecret" = ${stored} WHERE id = ${id}`;
          }),
      },
    ],
    write: writeSecret,
    read: readSecret,
  },
);
