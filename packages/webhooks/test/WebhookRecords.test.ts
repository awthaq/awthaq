// Plan 05 / plan 17: `WebhookRecords`' three sealed columns, through the substrate's wiring suite on both adapters,
// and the plugin's declaration of them. The store's own contract (every operation, its races, tenant isolation) is
// `test/contract/WebhookRecords.ts`, run from `Contract.test.ts` (plan 25 ticket 16).
import { Migrations } from "@awthaq/core";
import { SealedColumn } from "@awthaq/sql";
import * as SqlClient from "effect/sql/SqlClient";
import type { Encryption } from "@awthaq/ports";
import { TestAuth, TestSql } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as Webhooks from "../src/Webhooks.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

/**
 * A migrated client (SQLite, or a Postgres schema under `pnpm test:pg`). Not `RecordsContract.recordsBase`: its mode
 * union does not promise `SqlClient` to the type checker, and its test `Encryption` would shadow the rotatable one
 * the sealed suite provides.
 */
const SqlLive = TestSql.layer("webhooks_sealed_columns");
const SqlBase = Layer.effectDiscard(Migrations.run(Webhooks.Webhooks.migrations)).pipe(
  Layer.provideMerge(SqlLive),
);

const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => {
    throw new Error(message);
  },
};

// ---- the three sealed columns: the substrate's wiring suite over both adapters --------------------------------

type SealedField = "secret" | "previousSecret" | "headers";

const sampleEndpoint = (id: string) => ({
  id,
  url: `https://${id}.example.com/hook`,
  eventTags: ["*"],
  createdBy: "admin-1",
});

const storedEndpoint = (id: string) =>
  Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
    Effect.map(records.findEndpoint(id), Option.getOrThrow),
  );
const secretOf = (id: string) => Effect.map(storedEndpoint(id), (endpoint) => endpoint.secret);
const previousSecretOf = (id: string) =>
  Effect.map(storedEndpoint(id), (endpoint) => Option.getOrThrow(endpoint.previousSecret));
const headersOf = (id: string) =>
  Effect.map(storedEndpoint(id), (endpoint) => Option.getOrThrow(endpoint.headers));

/** One records adapter's storage: how the suite looks at, and plants, what is at rest. */
type Storage<R> = {
  readonly name: string;
  readonly layer: Layer.Layer<R, unknown, Encryption.Encryption>;
  readonly raw: (id: string, column: SealedField) => Effect.Effect<string, unknown, R>;
  readonly plant: (
    id: string,
    column: SealedField,
    stored: string,
  ) => Effect.Effect<void, unknown, R>;
};

const memoryStorage: Storage<WebhookRecords.WebhookRecords | WebhookRecords.MemoryEnvelopes> = {
  name: "layerMemory",
  layer: WebhookRecords.layerMemory,
  raw: (id, column) =>
    Effect.flatMap(WebhookRecords.MemoryEnvelopes, (rows) => rows.stored(id, column)),
  plant: (id, column, stored) =>
    Effect.flatMap(WebhookRecords.MemoryEnvelopes, (rows) => rows.plant(id, column, stored)),
};

const sqlStorage: Storage<WebhookRecords.WebhookRecords | SqlClient.SqlClient> = {
  name: "layerSql",
  layer: WebhookRecords.layerSql.pipe(Layer.provideMerge(SqlBase)),
  raw: (id, column) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly value: string;
      }>`SELECT ${sql(column)} AS value FROM webhooks_endpoint WHERE id = ${id}`;
      return rows[0]?.value ?? "";
    }),
  plant: (id, column, stored) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE webhooks_endpoint SET ${sql(column)} = ${stored} WHERE id = ${id}`;
    }),
};

const sealedSuites = <Extra>(storage: Storage<WebhookRecords.WebhookRecords | Extra>) => {
  const forColumn = <A>(
    column: SealedColumn.Column<A>,
    field: SealedField,
    sample: A,
    write: (id: string, value: A) => Effect.Effect<unknown, unknown, WebhookRecords.WebhookRecords>,
    read: (
      id: string,
    ) => Effect.Effect<SealedColumn.Sealed<A>, unknown, WebhookRecords.WebhookRecords>,
  ) =>
    TestAuth.runSealedColumnTests<A, WebhookRecords.WebhookRecords | Extra>(vitestFramework, {
      column,
      sample,
      adapters: [
        {
          name: storage.name,
          layer: storage.layer,
          raw: (id) => storage.raw(id, field),
          plant: (id, stored) => storage.plant(id, field, stored),
        },
      ],
      write: (id, value) => Effect.asVoid(write(id, value)),
      read,
    });
  forColumn(
    WebhookRecords.secretColumn,
    "secret",
    "whsec_sample",
    (id, value) =>
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
        records.createEndpoint({ ...sampleEndpoint(id), secret: Redacted.make(value) }),
      ),
    secretOf,
  );
  forColumn(
    WebhookRecords.previousSecretColumn,
    "previousSecret",
    "whsec_previous",
    (id, value) =>
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
        Effect.andThen(
          records.createEndpoint({ ...sampleEndpoint(id), secret: Redacted.make("whsec_current") }),
          records.setSecrets(id, {
            secret: Redacted.make("whsec_current"),
            previousSecret: Redacted.make(value),
            previousSecretExpiresAt: at(5_000),
          }),
        ),
      ),
    previousSecretOf,
  );
  forColumn(
    WebhookRecords.headersColumn,
    "headers",
    { authorization: "Bearer very-secret-token" },
    (id, value) =>
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
        records.createEndpoint({
          ...sampleEndpoint(id),
          secret: Redacted.make("whsec_current"),
          headers: { value, names: Object.keys(value) },
        }),
      ),
    headersOf,
  );
};

sealedSuites(memoryStorage);
sealedSuites(sqlStorage);

// Plan 17: the plugin declares its sealed columns, so `auth.sealedColumns` (the `also` of a rotation sweep) lists them.
describe("WebhookRecords sealed column declarations", () => {
  it("the plugin declares secret, previousSecret and headers", () => {
    assert.deepStrictEqual(
      Webhooks.Webhooks.sealedColumns.map((declared) => `${declared.table}.${declared.column}`),
      ["webhooks_endpoint.secret", "webhooks_endpoint.previousSecret", "webhooks_endpoint.headers"],
    );
    assert.deepStrictEqual(Webhooks.Webhooks.sealedColumns, [
      WebhookRecords.secretColumn,
      WebhookRecords.previousSecretColumn,
      WebhookRecords.headersColumn,
    ]);
  });
});
