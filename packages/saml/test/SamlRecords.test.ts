// `SamlRecords`' sealed `privateKey` column (BEH-EA-314, ADR-EA-019 decision 6): the substrate's wiring suite over
// both adapters, and the plugin's declaration of it. The store's contract (every operation, its races, its
// tenant isolation) is `contract/SamlRecords.ts`, run from `Contract.test.ts` (plan 25 ticket 22). `layerSql` is
// migrated through the plugin's own real `migrations`, Organization's first (Saml's backfill its domains into
// organization's claim tables, BEH-EA-317).
import { Auth, Migrations } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Saml from "../src/Saml.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import { TestSql } from "@awthaq/test";
import { NOT_AFTER, NOT_BEFORE } from "./samlFixtures.ts";
import { vitestFramework } from "./vitestFramework.ts";

const SqlLive = TestSql.layer("saml_SamlRecords");

const Migrated = Layer.effectDiscard(
  Migrations.run(Auth.make([Organization.Organization, Saml.Saml]).migrations),
).pipe(Layer.provide(SqlLive));

// The records layer needs `Encryption` (the sealed `privateKey` column); the sealed suite provides a rotatable one.
const SqlNeedsEncryption = SamlRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

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

// Plan 17: the plugin declares its sealed column, so `auth.sealedColumns` (the `also` of a rotation sweep) lists it.
describe("SamlRecords sealed column declaration", () => {
  it("the plugin declares the SP private key", () => {
    assert.deepStrictEqual(Saml.Saml.sealedColumns, [SamlRecords.privateKeyColumn]);
  });
});
