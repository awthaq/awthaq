// BEH-EA-241: `SamlRecords`, one contract suite over both layers. `layerSql` is migrated through the plugin's own
// real `migrations` (and, under `pnpm run test:pg`, runs on Postgres), so an email domain routing to exactly one
// connection is a real database constraint.
import { Migrations } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import { SealedColumn, TenantScoped } from "@awthaq/sql";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import { idp, idpNext, NOT_AFTER, NOT_BEFORE } from "./samlFixtures.ts";
import { EncryptionLive } from "./support.ts";
import { vitestFramework } from "./vitestFramework.ts";

/** The witness these tests present where a protocol message or a maintenance sweep would. */
const grant = TenantScoped.crossTenant("saml records test: a cross-organization caller");

const SqlLive = TestSql.layer("saml_SamlRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Saml.Saml.migrations)).pipe(
  Layer.provide(SqlLive),
);

// The records layers need `Encryption` (the sealed `privateKey` column); the sealed suite below provides a
// rotatable one itself.
const SqlNeedsEncryption = SamlRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);
const SqlLayer = SqlNeedsEncryption.pipe(Layer.provide(EncryptionLive));
const MemoryLayer = SamlRecords.layerMemory.pipe(Layer.provide(EncryptionLive));

const certificate = (who: typeof idp): SamlRecords.IdpCertificate => ({
  pem: who.cert,
  fingerprint: who.fingerprint,
  notBefore: NOT_BEFORE,
  notAfter: NOT_AFTER,
});

const input = (
  id: string,
  organizationId: string,
  domains: ReadonlyArray<string> = [],
): SamlRecords.NewConnection => ({
  id,
  organizationId,
  name: `connection ${id}`,
  idpEntityId: `https://idp-${id}.example.com/metadata`,
  ssoUrl: `https://idp-${id}.example.com/sso`,
  idpCertificates: [certificate(idp)],
  emailDomains: domains,
  trustsEmail: false,
});

const suite = (name: string, layer: Layer.Layer<SamlRecords.SamlRecords, unknown, never>): void => {
  describe(name, () => {
    it.effect("a connection round-trips with its certificates, domains and flag", () =>
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        const created = yield* records.create({
          ...input("c1", "org-1", ["acme.example", "acme.test"]),
          trustsEmail: true,
        });
        assert.deepStrictEqual(created.emailDomains, ["acme.example", "acme.test"]);
        const found = Option.getOrThrow(yield* records.findById(grant, "c1"));
        assert.strictEqual(found.organizationId, "org-1");
        assert.strictEqual(found.idpEntityId, "https://idp-c1.example.com/metadata");
        assert.isTrue(found.trustsEmail);
        assert.deepStrictEqual(
          found.idpCertificates.map((entry) => [
            entry.fingerprint,
            DateTime.toEpochMillis(entry.notBefore),
            DateTime.toEpochMillis(entry.notAfter),
          ]),
          [
            [
              idp.fingerprint,
              DateTime.toEpochMillis(NOT_BEFORE),
              DateTime.toEpochMillis(NOT_AFTER),
            ],
          ],
        );
        assert.strictEqual(found.idpCertificates[0]?.pem, idp.cert);
        assert.deepStrictEqual([...found.emailDomains].sort(), ["acme.example", "acme.test"]);
        assert.isTrue(Option.isNone(yield* records.findById(grant, "nope")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "lists per organization oldest first, and routes a domain to exactly one connection",
      () =>
        Effect.gen(function* () {
          const records = yield* SamlRecords.SamlRecords;
          yield* records.create(input("c1", "org-1", ["acme.example"]));
          yield* records.create(input("c2", "org-1"));
          yield* records.create(input("c3", "org-2", ["other.example"]));
          assert.deepStrictEqual(
            (yield* records.listByOrganization("org-1")).map((row) => row.id),
            ["c1", "c2"],
          );
          assert.strictEqual(
            Option.getOrThrow(yield* records.findByDomain(grant, "acme.example")).id,
            "c1",
          );
          assert.strictEqual(
            Option.getOrThrow(yield* records.findByDomain(grant, "other.example")).id,
            "c3",
          );
          assert.isTrue(Option.isNone(yield* records.findByDomain(grant, "nobody.example")));
          // A domain cannot be claimed twice, and a refused create leaves no half-made connection.
          const taken = yield* records
            .create(input("c4", "org-2", ["fresh.example", "acme.example"]))
            .pipe(Effect.flip);
          assert.strictEqual(taken._tag, "SamlDomainTaken");
          assert.strictEqual(taken._tag === "SamlDomainTaken" ? taken.domain : "", "acme.example");
          assert.isTrue(Option.isNone(yield* records.findById(grant, "c4")));
          assert.isTrue(Option.isNone(yield* records.findByDomain(grant, "fresh.example")));
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "update changes only what is given; certificates are replaced whole; domains are replaced and re-checked",
      () =>
        Effect.gen(function* () {
          const records = yield* SamlRecords.SamlRecords;
          yield* records.create(input("c1", "org-1", ["a.example"]));
          yield* records.create(input("c2", "org-1", ["b.example"]));
          const renamed = yield* records.update("org-1", "c1", { name: "renamed" });
          assert.strictEqual(renamed.name, "renamed");
          assert.strictEqual(renamed.ssoUrl, "https://idp-c1.example.com/sso");
          assert.deepStrictEqual(renamed.emailDomains, ["a.example"]);
          const rotated = yield* records.update("org-1", "c1", {
            idpCertificates: [certificate(idpNext)],
            trustsEmail: true,
          });
          assert.deepStrictEqual(
            rotated.idpCertificates.map((entry) => entry.fingerprint),
            [idpNext.fingerprint],
          );
          assert.isTrue(rotated.trustsEmail);
          // Domains are replaced; a domain another connection holds is refused and the old set is restored.
          const moved = yield* records.update("org-1", "c1", { emailDomains: ["c.example"] });
          assert.deepStrictEqual(moved.emailDomains, ["c.example"]);
          assert.isTrue(Option.isNone(yield* records.findByDomain(grant, "a.example")));
          const clash = yield* records
            .update("org-1", "c1", { emailDomains: ["d.example", "b.example"] })
            .pipe(Effect.flip);
          assert.strictEqual(clash._tag, "SamlDomainTaken");
          assert.deepStrictEqual(
            Option.getOrThrow(yield* records.findById(grant, "c1")).emailDomains,
            ["c.example"],
          );
          const missing = yield* records.update("org-1", "nope", { name: "x" }).pipe(Effect.flip);
          assert.strictEqual(missing._tag, "SamlRecordNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("remove deletes the connection and frees its domains", () =>
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input("c1", "org-1", ["a.example"]));
        yield* records.remove("org-1", "c1");
        assert.isTrue(Option.isNone(yield* records.findById(grant, "c1")));
        assert.isTrue(Option.isNone(yield* records.findByDomain(grant, "a.example")));
        yield* records.create(input("c2", "org-2", ["a.example"]));
        assert.strictEqual(
          (yield* records.remove("org-1", "c1").pipe(Effect.flip))._tag,
          "SamlRecordNotFound",
        );
      }).pipe(Effect.provide(layer)),
    );

    // BEH-EA-314/315/316: the signing flag, the logout endpoint, the metadata URL and the role mapping round-trip, are patched
    // field by field (null clears), and default to what a pre-existing connection always was.
    it.effect(
      "the signing, logout, metadata and role-mapping fields round-trip and patch independently",
      () =>
        Effect.gen(function* () {
          const records = yield* SamlRecords.SamlRecords;
          const plain = yield* records.create(input("c1", "org-1"));
          assert.isFalse(plain.authnRequestsSigned);
          assert.isTrue(Option.isNone(plain.sloUrl));
          assert.strictEqual(plain.sloBinding, "redirect");
          assert.isTrue(Option.isNone(plain.metadataUrl));
          assert.deepStrictEqual(plain.roleMapping, SamlRecords.EMPTY_ROLE_MAPPING);
          const mapping: SamlRecords.RoleMapping = {
            rules: [
              { attribute: "groups", value: "admins", roles: ["admin"] },
              { attribute: "department", roles: ["member"] },
            ],
            ceiling: ["admin"],
            defaultRoles: ["member"],
          };
          const full = yield* records.create({
            ...input("c2", "org-1"),
            authnRequestsSigned: true,
            sloUrl: "https://idp.example.com/slo",
            sloBinding: "post",
            metadataUrl: "https://idp.example.com/metadata.xml",
            roleMapping: mapping,
          });
          const read = Option.getOrThrow(yield* records.findById(grant, "c2"));
          assert.deepStrictEqual(read, full);
          assert.isTrue(read.authnRequestsSigned);
          assert.deepStrictEqual(read.sloUrl, Option.some("https://idp.example.com/slo"));
          assert.strictEqual(read.sloBinding, "post");
          assert.deepStrictEqual(
            read.metadataUrl,
            Option.some("https://idp.example.com/metadata.xml"),
          );
          assert.deepStrictEqual(read.roleMapping, mapping);
          // A patch changes what it names; `null` clears the two optional URLs.
          const patched = yield* records.update("org-1", "c2", {
            authnRequestsSigned: false,
            sloUrl: null,
            metadataUrl: null,
          });
          assert.isFalse(patched.authnRequestsSigned);
          assert.isTrue(Option.isNone(patched.sloUrl));
          assert.isTrue(Option.isNone(patched.metadataUrl));
          assert.strictEqual(patched.sloBinding, "post");
          assert.deepStrictEqual(patched.roleMapping, mapping);
          const remapped = yield* records.update("org-1", "c2", {
            roleMapping: SamlRecords.EMPTY_ROLE_MAPPING,
          });
          assert.deepStrictEqual(remapped.roleMapping, SamlRecords.EMPTY_ROLE_MAPPING);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "SP signing keys are listed newest first per connection and removed with their connection",
      () =>
        Effect.gen(function* () {
          const records = yield* SamlRecords.SamlRecords;
          yield* records.create(input("c1", "org-1"));
          const key = (id: string, connectionId: string) => ({
            id,
            connectionId,
            certificate: `cert-${id}`,
            privateKey: Redacted.make(`sealed-${id}`),
            fingerprint: `fp-${id}`,
            notBefore: NOT_BEFORE,
            notAfter: NOT_AFTER,
          });
          yield* records.saveSpKey(key("k1", "c1"));
          yield* TestClock.adjust(Duration.seconds(1));
          yield* records.saveSpKey(key("k2", "c1"));
          yield* records.saveSpKey(key("k3", "other"));
          const listed = yield* records.listSpKeys("c1");
          assert.deepStrictEqual(
            listed.map((row) => row.id),
            ["k2", "k1"],
          );
          assert.strictEqual(
            Redacted.value(
              yield* SealedColumn.orDie(
                Option.getOrThrow(Option.fromNullishOr(listed[0])).privateKey.open,
              ),
            ),
            "sealed-k2",
          );
          assert.strictEqual(
            DateTime.toEpochMillis(listed[0]?.notAfter ?? NOT_BEFORE),
            DateTime.toEpochMillis(NOT_AFTER),
          );
          yield* records.remove("org-1", "c1");
          assert.deepStrictEqual(yield* records.listSpKeys("c1"), []);
          assert.strictEqual((yield* records.listSpKeys("other")).length, 1);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "the sessions a connection created are found by NameID and SessionIndex, replaced by id, pruned by age and removed with the connection",
      () =>
        Effect.gen(function* () {
          const records = yield* SamlRecords.SamlRecords;
          yield* records.create(input("c1", "org-1"));
          yield* records.saveSession({
            sessionId: "s1",
            connectionId: "c1",
            nameId: "ada",
            nameIdFormat: "emailAddress",
            sessionIndex: "i1",
          });
          yield* TestClock.adjust(Duration.days(2));
          yield* records.saveSession({
            sessionId: "s2",
            connectionId: "c1",
            nameId: "ada",
            sessionIndex: "i2",
          });
          yield* records.saveSession({ sessionId: "s3", connectionId: "c1", nameId: "grace" });
          yield* records.saveSession({
            sessionId: "s4",
            connectionId: "other",
            nameId: "ada",
            sessionIndex: "i1",
          });
          const ids = (rows: ReadonlyArray<SamlRecords.SamlSessionRecord>) =>
            rows.map((row) => row.sessionId).toSorted();
          assert.deepStrictEqual(
            ids(yield* records.findSessions({ connectionId: "c1", nameId: "ada" })),
            ["s1", "s2"],
          );
          assert.deepStrictEqual(
            ids(
              yield* records.findSessions({
                connectionId: "c1",
                nameId: "ada",
                sessionIndex: "i2",
              }),
            ),
            ["s2"],
          );
          assert.deepStrictEqual(
            yield* records.findSessions({ connectionId: "c1", nameId: "nobody" }),
            [],
          );
          const s1 = Option.getOrThrow(yield* records.findSession("s1"));
          assert.deepStrictEqual(s1.nameIdFormat, Option.some("emailAddress"));
          assert.deepStrictEqual(s1.sessionIndex, Option.some("i1"));
          const s3 = Option.getOrThrow(yield* records.findSession("s3"));
          assert.isTrue(Option.isNone(s3.sessionIndex));
          // Saving the same session id again replaces its row rather than adding one.
          yield* records.saveSession({
            sessionId: "s1",
            connectionId: "c1",
            nameId: "ada",
            sessionIndex: "i1-again",
          });
          assert.strictEqual(
            (yield* records.findSessions({ connectionId: "c1", nameId: "ada" })).length,
            2,
          );
          // Pruning by age drops the rows created before the cutoff and keeps the newer ones.
          yield* TestClock.adjust(Duration.days(3));
          yield* records.saveSession({ sessionId: "fresh", connectionId: "c1", nameId: "ada" });
          assert.strictEqual(
            yield* records.pruneSessions(
              grant,
              DateTime.subtract(yield* DateTime.now, { days: 2 }),
            ),
            4,
          );
          assert.isTrue(Option.isNone(yield* records.findSession("s2")));
          assert.isTrue(Option.isSome(yield* records.findSession("fresh")));
          yield* records.saveSession({ sessionId: "s5", connectionId: "c1", nameId: "ada" });
          yield* records.removeSession("s5");
          assert.isTrue(Option.isNone(yield* records.findSession("s5")));
          yield* records.saveSession({ sessionId: "s6", connectionId: "c1", nameId: "ada" });
          yield* records.remove("org-1", "c1");
          assert.isTrue(Option.isNone(yield* records.findSession("s6")));
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite("SamlRecords (layerMemory)", MemoryLayer);
suite("SamlRecords (layerSql)", SqlLayer);

// Plan 05: the tenant-isolation conformance suite for the four tables `SamlRecords` owns. `saml_connection` is
// Keyed by `organizationId` and the other three are Derived through it. One records interface serves all four, so each
// case classifies every method: the ones that belong to another table are `derived` and probed in that table's case.
let isolationCounter = 0;
interface Row {
  readonly id: string;
  readonly organizationId: string;
  readonly domain: string;
  readonly keyId: string;
  readonly sessionId: string;
}
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";
const using = <A, E, R>(use: (records: SamlRecords.SamlRecordsShape) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(SamlRecords.SamlRecords, use);
const present = (row: Row) =>
  using((records) => Effect.map(records.findById(grant, row.id), Option.isSome));

const insertRow = Effect.gen(function* () {
  const records = yield* SamlRecords.SamlRecords;
  isolationCounter += 1;
  const organizationId = yield* Effect.map(
    Tenant.TenantContext,
    Option.getOrElse(() => "platform-organization"),
  );
  const id = `isolation-${isolationCounter}`;
  const domain = `isolation-${isolationCounter}.example`;
  yield* records.create(input(id, organizationId, [domain]));
  const keyId = `isolation-key-${isolationCounter}`;
  yield* records.saveSpKey({
    id: keyId,
    connectionId: id,
    certificate: `cert-${keyId}`,
    privateKey: Redacted.make(`private-${keyId}`),
    fingerprint: `fp-${keyId}`,
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
  });
  const sessionId = `isolation-session-${isolationCounter}`;
  yield* records.saveSession({ sessionId, connectionId: id, nameId: "ada", sessionIndex: "i1" });
  return { id, organizationId, domain, keyId, sessionId };
});

type Methods = {
  readonly [K in keyof SamlRecords.SamlRecordsShape]: TestAuth.MethodClass<
    Row,
    SamlRecords.SamlRecords
  >;
};
const derivedElsewhere = (table: string) => ({
  derived: `operates on ${table}; classified in that table's case`,
});
const allElsewhere = (table: string): Methods => ({
  create: { insert: true },
  findById: derivedElsewhere(table),
  listByOrganization: derivedElsewhere(table),
  findByDomain: derivedElsewhere(table),
  update: derivedElsewhere(table),
  remove: derivedElsewhere(table),
  saveSpKey: derivedElsewhere(table),
  listSpKeys: derivedElsewhere(table),
  saveSession: derivedElsewhere(table),
  findSessions: derivedElsewhere(table),
  findSession: derivedElsewhere(table),
  removeSession: derivedElsewhere(table),
  pruneSessions: derivedElsewhere(table),
});

const connectionMethods: Methods = {
  ...allElsewhere("saml_sp_key and saml_session"),
  findById: {
    crossTenant: { run: (row) => present(row) },
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
  findByDomain: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(
            records.findByDomain(grant, row.domain),
            (found) => Option.isSome(found) && found.value.id === row.id,
          ),
        ),
    },
  },
  update: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records.update(orgOf(row, as), row.id, { name: "renamed" }).pipe(
            Effect.as(true),
            Effect.catchTag("SamlRecordNotFound", () => Effect.succeed(false)),
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
            Effect.catchTag("SamlRecordNotFound", () => Effect.succeed(false)),
          ),
        ),
    },
  },
};

const keyMethods: Methods = {
  ...allElsewhere("saml_connection and saml_session"),
  saveSpKey: { insert: true },
  listSpKeys: {
    derived:
      "keyed by a connection id the caller resolved through an organization-keyed connection read",
  },
};

const sessionMethods: Methods = {
  ...allElsewhere("saml_connection and saml_sp_key"),
  saveSession: { insert: true },
  findSessions: {
    derived:
      "keyed by a connection id the caller resolved through an organization-keyed connection read",
  },
  findSession: {
    derived: "keyed by a local session id, a tenant-scoped core row the caller already resolved",
  },
  removeSession: {
    derived: "keyed by a local session id, a tenant-scoped core row the caller already resolved",
  },
  pruneSessions: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* records.findSession(row.sessionId);
            yield* records.pruneSessions(
              grant,
              DateTime.makeUnsafe(Date.now() + 86_400_000 * 3650),
            );
            return (
              Option.isSome(before) && Option.isNone(yield* records.findSession(row.sessionId))
            );
          }),
        ),
    },
  },
};

TestAuth.runTenantIsolationTests(vitestFramework, {
  plugin: Saml.Saml,
  covers: ["saml_connection", "saml_connection_domain", "saml_sp_key", "saml_session"],
  adapters: [
    { name: "layerMemory", layer: MemoryLayer },
    { name: "layerSql", layer: SqlLayer },
  ],
  cases: [
    { table: "saml_connection", insert: insertRow, methods: connectionMethods },
    { table: "saml_connection_domain", insert: insertRow, methods: connectionMethods },
    { table: "saml_sp_key", insert: insertRow, methods: keyMethods },
    { table: "saml_session", insert: insertRow, methods: sessionMethods },
  ],
});

// ---- the sealed `privateKey` column: the substrate's wiring suite over both adapters -----------------------

const writeKey = (id: string, value: string) =>
  Effect.flatMap(SamlRecords.SamlRecords, (records) =>
    Effect.asVoid(
      records.saveSpKey({
        id,
        connectionId: "c-sealed",
        certificate: `cert-${id}`,
        privateKey: Redacted.make(value),
        fingerprint: `fp-${id}`,
        notBefore: NOT_BEFORE,
        notAfter: NOT_AFTER,
      }),
    ),
  );
const readKey = (id: string) =>
  Effect.flatMap(SamlRecords.SamlRecords, (records) =>
    Effect.map(
      records.listSpKeys("c-sealed"),
      (keys) =>
        Option.getOrThrow(Option.fromNullishOr(keys.find((key) => key.id === id))).privateKey,
    ),
  );

TestAuth.runSealedColumnTests<string, SamlRecords.SamlRecords | SamlRecords.MemoryEnvelopes>(
  vitestFramework,
  {
    column: SamlRecords.privateKeyColumn,
    sample: "-----BEGIN PRIVATE KEY-----\nsample\n-----END PRIVATE KEY-----",
    adapters: [
      {
        name: "layerMemory",
        layer: SamlRecords.layerMemory,
        raw: (id) => Effect.flatMap(SamlRecords.MemoryEnvelopes, (rows) => rows.stored(id)),
        plant: (id, stored) =>
          Effect.flatMap(SamlRecords.MemoryEnvelopes, (rows) => rows.plant(id, stored)),
      },
    ],
    write: writeKey,
    read: readKey,
  },
);

TestAuth.runSealedColumnTests<string, SamlRecords.SamlRecords | SqlClient.SqlClient>(
  vitestFramework,
  {
    column: SamlRecords.privateKeyColumn,
    sample: "-----BEGIN PRIVATE KEY-----\nsample\n-----END PRIVATE KEY-----",
    adapters: [
      {
        name: "layerSql",
        layer: SqlNeedsEncryption,
        raw: (id) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{
              readonly value: string;
            }>`SELECT "privateKey" AS value FROM saml_sp_key WHERE id = ${id}`;
            return rows[0]?.value ?? "";
          }),
        plant: (id, stored) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE saml_sp_key SET "privateKey" = ${stored} WHERE id = ${id}`;
          }),
      },
    ],
    write: writeKey,
    read: readKey,
  },
);
