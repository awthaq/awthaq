// Plan 16 (moved from the repository Postgres suite): `Migrator`'s Postgres ledger check
// (`select 'name'::regclass`) cannot decode its row under @effect/sql-pg 4.0.0-rc.116 once the ledger
// exists, and the failure wrecks the connection: a *second* migrator run on a migrated database dies.
// A client-scoped regclass codec (README, "Postgres client configuration") makes a re-run the no-op it
// should be.
//
// Skips (not fails) without `AWTHAQ_POSTGRES_URL`.
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { regclassTypes } from "../../test/src/TestSql.ts";
import * as CoreMigrations from "../src/CoreMigrations.ts";

const postgresUrl = process.env["AWTHAQ_POSTGRES_URL"];

const skip = postgresUrl === undefined;

// Its own schema: parallel files must not share `public`.
const schema = "t_sql_core_migrations_postgres";

describe.skipIf(skip)("CoreMigrations (real Postgres)", () => {
  it.effect(
    "re-running coreMigrations on a migrated database applies nothing (regclass codec)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const again = yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
        assert.strictEqual(again.length, 0);
        // The connection is still healthy afterwards.
        const rows = yield* sql`SELECT 1 AS ok`;
        assert.strictEqual(rows.length, 1);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.effectDiscard(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
                yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
                yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
              }),
            ),
            PgClient.layer({
              url: Redacted.make(postgresUrl ?? ""),
              types: regclassTypes(),
              maxConnections: 1,
              startupParameters: { search_path: schema },
            }),
          ),
        ),
      ),
  );
});
