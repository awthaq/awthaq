// BEH-EA-241: `SamlRecords`, one contract suite over both layers. `layerSql` is migrated through the plugin's own
// real `migrations` (and, under `pnpm run test:pg`, runs on Postgres), so an email domain routing to exactly one
// connection is a real database constraint.
import { Migrations } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Saml from "../src/Saml.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import { idp, idpNext, NOT_AFTER, NOT_BEFORE } from "./samlFixtures.ts";

const SqlLive = TestSql.layer("saml_SamlRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Saml.Saml.migrations)).pipe(Layer.provide(SqlLive));

const SqlLayer = SamlRecords.layerSql.pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

const certificate = (who: typeof idp): SamlRecords.IdpCertificate => ({
  pem: who.cert,
  fingerprint: who.fingerprint,
  notBefore: NOT_BEFORE,
  notAfter: NOT_AFTER,
});

const input = (id: string, organizationId: string, domains: ReadonlyArray<string> = []): SamlRecords.NewConnection => ({
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
        const created = yield* records.create({ ...input("c1", "org-1", ["acme.example", "acme.test"]), trustsEmail: true });
        assert.deepStrictEqual(created.emailDomains, ["acme.example", "acme.test"]);
        const found = Option.getOrThrow(yield* records.findById("c1"));
        assert.strictEqual(found.organizationId, "org-1");
        assert.strictEqual(found.idpEntityId, "https://idp-c1.example.com/metadata");
        assert.isTrue(found.trustsEmail);
        assert.deepStrictEqual(
          found.idpCertificates.map((entry) => [entry.fingerprint, DateTime.toEpochMillis(entry.notBefore), DateTime.toEpochMillis(entry.notAfter)]),
          [[idp.fingerprint, DateTime.toEpochMillis(NOT_BEFORE), DateTime.toEpochMillis(NOT_AFTER)]],
        );
        assert.strictEqual(found.idpCertificates[0]?.pem, idp.cert);
        assert.deepStrictEqual([...found.emailDomains].sort(), ["acme.example", "acme.test"]);
        assert.isTrue(Option.isNone(yield* records.findById("nope")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("lists per organization oldest first, and routes a domain to exactly one connection", () =>
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input("c1", "org-1", ["acme.example"]));
        yield* records.create(input("c2", "org-1"));
        yield* records.create(input("c3", "org-2", ["other.example"]));
        assert.deepStrictEqual(
          (yield* records.listByOrganization("org-1")).map((row) => row.id),
          ["c1", "c2"],
        );
        assert.strictEqual(Option.getOrThrow(yield* records.findByDomain("acme.example")).id, "c1");
        assert.strictEqual(Option.getOrThrow(yield* records.findByDomain("other.example")).id, "c3");
        assert.isTrue(Option.isNone(yield* records.findByDomain("nobody.example")));
        // A domain cannot be claimed twice, and a refused create leaves no half-made connection.
        const taken = yield* records.create(input("c4", "org-2", ["fresh.example", "acme.example"])).pipe(Effect.flip);
        assert.strictEqual(taken._tag, "SamlDomainTaken");
        assert.strictEqual(taken.domain, "acme.example");
        assert.isTrue(Option.isNone(yield* records.findById("c4")));
        assert.isTrue(Option.isNone(yield* records.findByDomain("fresh.example")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("update changes only what is given; certificates are replaced whole; domains are replaced and re-checked", () =>
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input("c1", "org-1", ["a.example"]));
        yield* records.create(input("c2", "org-1", ["b.example"]));
        const renamed = yield* records.update("c1", { name: "renamed" });
        assert.strictEqual(renamed.name, "renamed");
        assert.strictEqual(renamed.ssoUrl, "https://idp-c1.example.com/sso");
        assert.deepStrictEqual(renamed.emailDomains, ["a.example"]);
        const rotated = yield* records.update("c1", { idpCertificates: [certificate(idpNext)], trustsEmail: true });
        assert.deepStrictEqual(rotated.idpCertificates.map((entry) => entry.fingerprint), [idpNext.fingerprint]);
        assert.isTrue(rotated.trustsEmail);
        // Domains are replaced; a domain another connection holds is refused and the old set is restored.
        const moved = yield* records.update("c1", { emailDomains: ["c.example"] });
        assert.deepStrictEqual(moved.emailDomains, ["c.example"]);
        assert.isTrue(Option.isNone(yield* records.findByDomain("a.example")));
        const clash = yield* records.update("c1", { emailDomains: ["d.example", "b.example"] }).pipe(Effect.flip);
        assert.strictEqual(clash._tag, "SamlDomainTaken");
        assert.deepStrictEqual(Option.getOrThrow(yield* records.findById("c1")).emailDomains, ["c.example"]);
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
        assert.strictEqual((yield* records.remove("c1").pipe(Effect.flip))._tag, "SamlRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("SamlRecords (layerMemory)", SamlRecords.layerMemory);
suite("SamlRecords (layerSql)", SqlLayer);
