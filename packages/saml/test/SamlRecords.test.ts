// BEH-EA-241: `SamlRecords`, one contract suite over both layers. `layerSql` is migrated through the plugin's own
// real `migrations` (and, under `pnpm run test:pg`, runs on Postgres), so an email domain routing to exactly one
// connection is a real database constraint.
import { Migrations } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import { idp, idpNext, NOT_AFTER, NOT_BEFORE } from "./samlFixtures.ts";

const SqlLive = TestSql.layer("saml_SamlRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Saml.Saml.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = SamlRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

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
        const found = Option.getOrThrow(yield* records.findById("c1"));
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
        assert.isTrue(Option.isNone(yield* records.findById("nope")));
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
            Option.getOrThrow(yield* records.findByDomain("acme.example")).id,
            "c1",
          );
          assert.strictEqual(
            Option.getOrThrow(yield* records.findByDomain("other.example")).id,
            "c3",
          );
          assert.isTrue(Option.isNone(yield* records.findByDomain("nobody.example")));
          // A domain cannot be claimed twice, and a refused create leaves no half-made connection.
          const taken = yield* records
            .create(input("c4", "org-2", ["fresh.example", "acme.example"]))
            .pipe(Effect.flip);
          assert.strictEqual(taken._tag, "SamlDomainTaken");
          assert.strictEqual(taken.domain, "acme.example");
          assert.isTrue(Option.isNone(yield* records.findById("c4")));
          assert.isTrue(Option.isNone(yield* records.findByDomain("fresh.example")));
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "update changes only what is given; certificates are replaced whole; domains are replaced and re-checked",
      () =>
        Effect.gen(function* () {
          const records = yield* SamlRecords.SamlRecords;
          yield* records.create(input("c1", "org-1", ["a.example"]));
          yield* records.create(input("c2", "org-1", ["b.example"]));
          const renamed = yield* records.update("c1", { name: "renamed" });
          assert.strictEqual(renamed.name, "renamed");
          assert.strictEqual(renamed.ssoUrl, "https://idp-c1.example.com/sso");
          assert.deepStrictEqual(renamed.emailDomains, ["a.example"]);
          const rotated = yield* records.update("c1", {
            idpCertificates: [certificate(idpNext)],
            trustsEmail: true,
          });
          assert.deepStrictEqual(
            rotated.idpCertificates.map((entry) => entry.fingerprint),
            [idpNext.fingerprint],
          );
          assert.isTrue(rotated.trustsEmail);
          // Domains are replaced; a domain another connection holds is refused and the old set is restored.
          const moved = yield* records.update("c1", { emailDomains: ["c.example"] });
          assert.deepStrictEqual(moved.emailDomains, ["c.example"]);
          assert.isTrue(Option.isNone(yield* records.findByDomain("a.example")));
          const clash = yield* records
            .update("c1", { emailDomains: ["d.example", "b.example"] })
            .pipe(Effect.flip);
          assert.strictEqual(clash._tag, "SamlDomainTaken");
          assert.deepStrictEqual(Option.getOrThrow(yield* records.findById("c1")).emailDomains, [
            "c.example",
          ]);
          const missing = yield* records.update("nope", { name: "x" }).pipe(Effect.flip);
          assert.strictEqual(missing._tag, "SamlRecordNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("remove deletes the connection and frees its domains", () =>
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input("c1", "org-1", ["a.example"]));
        yield* records.remove("c1");
        assert.isTrue(Option.isNone(yield* records.findById("c1")));
        assert.isTrue(Option.isNone(yield* records.findByDomain("a.example")));
        yield* records.create(input("c2", "org-2", ["a.example"]));
        assert.strictEqual(
          (yield* records.remove("c1").pipe(Effect.flip))._tag,
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
          const read = Option.getOrThrow(yield* records.findById("c2"));
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
          const patched = yield* records.update("c2", {
            authnRequestsSigned: false,
            sloUrl: null,
            metadataUrl: null,
          });
          assert.isFalse(patched.authnRequestsSigned);
          assert.isTrue(Option.isNone(patched.sloUrl));
          assert.isTrue(Option.isNone(patched.metadataUrl));
          assert.strictEqual(patched.sloBinding, "post");
          assert.deepStrictEqual(patched.roleMapping, mapping);
          const remapped = yield* records.update("c2", {
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
            privateKey: `sealed-${id}`,
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
          assert.strictEqual(listed[0]?.privateKey, "sealed-k2");
          assert.strictEqual(
            DateTime.toEpochMillis(listed[0]?.notAfter ?? NOT_BEFORE),
            DateTime.toEpochMillis(NOT_AFTER),
          );
          yield* records.remove("c1");
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
            yield* records.pruneSessions(DateTime.subtract(yield* DateTime.now, { days: 2 })),
            4,
          );
          assert.isTrue(Option.isNone(yield* records.findSession("s2")));
          assert.isTrue(Option.isSome(yield* records.findSession("fresh")));
          yield* records.saveSession({ sessionId: "s5", connectionId: "c1", nameId: "ada" });
          yield* records.removeSession("s5");
          assert.isTrue(Option.isNone(yield* records.findSession("s5")));
          yield* records.saveSession({ sessionId: "s6", connectionId: "c1", nameId: "ada" });
          yield* records.remove("c1");
          assert.isTrue(Option.isNone(yield* records.findSession("s6")));
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite("SamlRecords (layerMemory)", SamlRecords.layerMemory);
suite("SamlRecords (layerSql)", SqlLayer);
