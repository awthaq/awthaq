// The sealed `clientSecret` column (plan 17): the substrate's wiring suite over both adapters. The store's
// behaviour is its RecordsContract suite (`test/contract/ConnectionRecords.ts`, run by `Contract.test.ts`, libSQL
// included); what stays here needs each adapter's raw seam.
import { Migrations } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as ConnectionRecords from "../src/ConnectionRecords.ts";
import * as Organization from "../src/Organization.ts";
import { TestSql } from "@awthaq/test";
import { vitestFramework } from "./support.ts";

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

// Plan 17: the plugin declares its sealed column, so `auth.sealedColumns` (the `also` of a rotation sweep) lists it.
describe("ConnectionRecords sealed column declaration", () => {
  it("the plugin declares the OAuth connection clientSecret", () => {
    assert.deepStrictEqual(Organization.Organization.sealedColumns, [
      ConnectionRecords.clientSecretColumn,
    ]);
  });
});
