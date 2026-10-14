// Plan 02: the three places `StoreContract` runs. Every port's cases are one list, run on the `Ref`
// adapter, on SQLite (`:memory:`, or a Postgres schema under `pnpm test:pg`) and on a WAL file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountStore,
  AuditLogStore,
  Encryption,
  KeyProvider,
  SessionStore,
  SqlTransaction,
  UserStore,
  VerificationStore,
} from "@awthaq/ports";
import {
  AccountStoreSql,
  AuditLogStoreSql,
  CoreMigrations,
  Repositories,
  SessionStoreSql,
  UserStoreSql,
  VerificationStoreSql,
} from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
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

/** A fixed test key, isolated from the real `process.env`: the accounts adapter encrypts tokens at rest. */
const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** What `Auth.make`'s linker generates for a plugin's declared user fields: nullable scalar columns on `users`. */
const addUserFieldColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const types = (dialect: "pg" | "sqlite") =>
    dialect === "pg"
      ? { text: "TEXT", real: "DOUBLE PRECISION", flag: "BOOLEAN" }
      : { text: "TEXT", real: "REAL", flag: "INTEGER" };
  const columns = yield* sql.onDialectOrElse({
    pg: () => Effect.succeed(types("pg")),
    orElse: () => Effect.succeed(types("sqlite")),
  });
  yield* sql.unsafe(`ALTER TABLE users ADD COLUMN contract_text ${columns.text}`);
  yield* sql.unsafe(`ALTER TABLE users ADD COLUMN contract_real ${columns.real}`);
  yield* sql.unsafe(`ALTER TABLE users ADD COLUMN contract_flag ${columns.flag}`);
});

/** Every store of the seam, over one client with the core schema applied. */
const sqlStores = <E>(client: Layer.Layer<SqlClient.SqlClient, E>) => {
  const migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      yield* addUserFieldColumns;
    }),
  ).pipe(Layer.provide(client));
  return Layer.mergeAll(
    AccountStoreSql.layer,
    AuditLogStoreSql.layer,
    SessionStoreSql.layer,
    UserStoreSql.layer,
    VerificationStoreSql.layer,
    SqlTransaction.layerSql,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive)),
        Repositories.AuditLogRepositoryLive,
        Repositories.SessionsRepositoryLive,
        Repositories.UsersRepositoryLive,
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
  StoreContract.run(framework, {
    adapter: "AccountStore (Ref)",
    layer: AccountStore.layerMemory,
    cases: StoreContract.accounts,
  });
  StoreContract.run(framework, {
    adapter: "SessionStore (Ref)",
    layer: SessionStore.layerMemory,
    cases: StoreContract.sessions,
  });
  StoreContract.run(framework, {
    adapter: "UserStore (Ref)",
    layer: Layer.mergeAll(UserStore.layerMemory, SqlTransaction.layerNoop),
    cases: StoreContract.users,
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
  StoreContract.run(framework, {
    adapter: `AccountStore (${label})`,
    layer: sqlStores(client),
    cases: StoreContract.accounts,
  });
  StoreContract.run(framework, {
    adapter: `SessionStore (${label})`,
    layer: sqlStores(client),
    cases: StoreContract.sessions,
  });
  StoreContract.run(framework, {
    adapter: `UserStore (${label})`,
    layer: sqlStores(client),
    cases: StoreContract.users,
  });
};
