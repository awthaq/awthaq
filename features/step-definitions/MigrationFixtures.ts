// P20a/AH-003: plugins whose migrations really run SQL, so the linker/persistence scenarios
// (BEH-EA-016, BEH-EA-037..040) can watch ordering matter against a real (in-memory SQLite)
// database rather than compare names. Each `up` reads the table it depends on, so it fails
// with "no such table" if the linker ever ran it before that table's own migration.
import { AuthPlugin, Migrations } from "@awthaq/core";
import { CoreMigrations } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const NoApi = HttpApi.make("auth");

/** A migration body: runs one statement on the ambient client (the migrator provides it). */
const run = (statement: (client: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) =>
  Effect.flatMap(SqlClient.SqlClient, statement).pipe(Effect.asVoid);

/** id "password": creates its table, then copies from core's `users` — so core's migrations must already have run. */
export class MigPassword extends AuthPlugin.Service<MigPassword, Record<string, never>>()(
  "password",
  {
    apiVersion: 1,
    contract: NoApi,
    tables: ["password_account"],
    migrations: [
      {
        name: "create_password_account",
        up: run(
          (client) =>
            client`CREATE TABLE password_account (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id))`,
        ),
      },
      {
        name: "backfill_password_account",
        up: run(
          (client) => client`INSERT INTO password_account (id, userId) SELECT id, id FROM users`,
        ),
      },
    ],
  },
) {
  static readonly layer = AuthPlugin.layer(MigPassword, { make: Effect.succeed({}) });
}

/** id "oauth": a table with a foreign key into `password`'s table, so `dependsOn` is what makes its migration legal to run. */
export class MigOauth extends AuthPlugin.Service<MigOauth, Record<string, never>>()("oauth", {
  apiVersion: 1,
  contract: NoApi,
  tables: ["oauth_account"],
  migrations: [
    {
      name: "create_oauth_account",
      up: run(
        (client) =>
          client`CREATE TABLE oauth_account (id TEXT PRIMARY KEY, passwordAccountId TEXT REFERENCES password_account(id))`,
      ),
    },
    {
      name: "backfill_oauth_account",
      up: run(
        (client) =>
          client`INSERT INTO oauth_account (id, passwordAccountId) SELECT id, id FROM password_account`,
      ),
    },
  ],
}) {
  static readonly layer = AuthPlugin.layer(MigOauth, {
    dependsOn: [MigPassword],
    make: Effect.gen(function* () {
      yield* MigPassword;
      return {};
    }),
  });
}

/** BEH-EA-016's "Sessions2FA": depends on `password`, so it sorts after it whatever the tuple order. */
export class MigTwoFactor extends AuthPlugin.Service<MigTwoFactor, Record<string, never>>()(
  "sessions2fa",
  {
    apiVersion: 1,
    contract: NoApi,
    tables: ["sessions2fa_secret"],
    migrations: [
      {
        name: "create_sessions2fa_secret",
        up: run(
          (client) =>
            client`CREATE TABLE sessions2fa_secret (id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES password_account(id))`,
        ),
      },
    ],
  },
) {
  static readonly layer = AuthPlugin.layer(MigTwoFactor, {
    dependsOn: [MigPassword],
    make: Effect.gen(function* () {
      yield* MigPassword;
      return {};
    }),
  });
}

/**
 * The runner's two steps (`@awthaq/cli`'s `migration apply` does exactly these): core's
 * migrations into their own ledger, then the linker's plugin list into the plugin ledger.
 * Everything runs against one fresh in-memory SQLite database that is torn down after.
 */
export const migrateSqlite = (migrations: Migrations.Migrations) =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
    const applied = yield* Migrations.run(migrations);
    const coreRows = yield* client<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
    const pluginRows = yield* client<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id, name FROM ${client(Migrations.pluginMigrationsTable)} ORDER BY migration_id`;
    const tables = yield* client<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
    return { applied, coreRows, pluginRows, tables: tables.map((row) => row.name) };
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped);
