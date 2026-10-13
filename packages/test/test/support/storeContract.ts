// Plan 02: the three places `StoreContract` runs. Every port's cases are one list, run on the `Ref`
// adapter, on SQLite (`:memory:`, or a Postgres schema under `pnpm test:pg`) and on a WAL file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogStore, VerificationStore } from "@awthaq/ports";
import { AuditLogStoreSql, CoreMigrations, Repositories, VerificationStoreSql } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as StoreContract from "../../src/StoreContract.ts";
import type { TestFramework } from "../../src/TestFramework.ts";

const framework: TestFramework = {
  describe: (name, body) => describe(name, body),
  // Postgres cases pay a round trip per statement, so give every case a generous budget.
  it: (name, body) => it(name, body, 60_000),
  fail: (message) => {
    throw new Error(message);
  },
};

/** Every store of the seam, over one client with the core schema applied. */
const sqlStores = <E>(client: Layer.Layer<SqlClient.SqlClient, E>) => {
  const migrated = Layer.effectDiscard(
    Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
  ).pipe(Layer.provide(client));
  return Layer.mergeAll(AuditLogStoreSql.layer, VerificationStoreSql.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Repositories.AuditLogRepositoryLive,
        Repositories.VerificationRepositoryLive,
        Repositories.VerificationReservationsRepositoryLive,
      ),
    ),
    Layer.provideMerge(client),
    Layer.provideMerge(migrated),
  );
};

/** A fresh database file per layer build, removed when the layer's scope closes (SEA-004). */
export const walFileClient = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-store-contract-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    ),
    (dir) => SqliteClient.layer({ filename: join(dir, "auth.db") }),
  ),
);

/** Runs the contract of every port on the `Ref` adapters. */
export const runOnMemory = (): void => {
  StoreContract.run(framework, {
    adapter: "AuditLogStore (Ref)",
    layer: AuditLogStore.layerMemory,
    cases: StoreContract.auditLog,
  });
  StoreContract.run(framework, {
    adapter: "VerificationStore (Ref)",
    layer: VerificationStore.layerMemory,
    cases: StoreContract.verification,
  });
};

/** Runs the contract of every port on the SQL adapters over `client`. */
export const runOnSql = <E>(label: string, client: Layer.Layer<SqlClient.SqlClient, E>): void => {
  StoreContract.run(framework, {
    adapter: `AuditLogStore (${label})`,
    layer: sqlStores(client),
    cases: StoreContract.auditLog,
  });
  StoreContract.run(framework, {
    adapter: `VerificationStore (${label})`,
    layer: sqlStores(client),
    cases: StoreContract.verification,
  });
};
