// The one place a store test chooses its database (TS-001/PV-010).
//
// Every plugin record-store suite (admin, jwt, organization, passkey, roles,
// qadi claims, migrate-better-auth) builds its `SqlClient` here. By default that
// is a fresh `:memory:` SQLite database per layer build, as before. With
// `AWTHAQ_POSTGRES_URL` set, the *same suites* run against a real Postgres
// instead: each layer build gets its own schema (named per suite, so suites
// running in parallel never touch each other), dropped and recreated first, so
// "a fresh database per `Effect.provide`" holds on both backends.
//
// `pnpm run test:pg` sets the variable and runs the plugin suites this way.

import { CoreMigrations } from "@awthaq/sql";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const postgresUrl = process.env["AWTHAQ_POSTGRES_URL"];

const asSqlClient = <E>(layer: Layer.Layer<SqlClient.SqlClient, E>) => layer;

/**
 * `Migrator`'s Postgres branch checks for its ledger with `select 'name'::regclass`.
 * `@effect/sql-pg` 4.0.0-rc.116 has no codec for OID 2205 (regclass), so once the
 * ledger table *exists* that row fails to decode ("Invalid UTF-8 in text value") and
 * the connection is left unusable — i.e. running any migrator a second time on an
 * already-migrated Postgres database breaks. A client-scoped codec (never a global
 * override) restores it; see `packages/sql/README.md`, "Postgres client configuration".
 */
export const regclassTypes = () => {
  const registry = PgTypes.makeRegistry();
  registry.register(2205, {
    encode: (value: string) => Result.succeed(new TextEncoder().encode(value)),
    decode: (bytes: Uint8Array) =>
      Result.succeed(
        String(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)),
      ),
  });
  return registry;
};

const postgres = (url: string, suite: string) => {
  // Vitest runs files in parallel workers: files sharing a suite name (BDD worlds) must not drop each
  // other's schema, so the worker's pool id joins the name (stable and bounded, unlike a pid).
  const worker = process.env["VITEST_POOL_ID"] ?? "";
  const schema =
    `t_${suite.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}${worker === "" ? "" : `_w${worker}`}`.slice(
      0,
      63,
    );
  const client = PgClient.layer({
    url: Redacted.make(url),
    // Every statement resolves unqualified names in this suite's own schema.
    startupParameters: { search_path: schema },
    maxConnections: 4,
    // The pool reclaims idle connections on the `Clock` every `idleTimeout` (default 10 s), so a test that
    // advances `TestClock` by days replays millions of ticks and times out. A very long timeout keeps that bounded.
    idleTimeout: Duration.days(100_000),
    types: regclassTypes(),
  });
  const reset = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
    }),
  );
  return Layer.provideMerge(reset, client);
};

/**
 * Makes the next matching statement on `table` fail with "injected", so an
 * atomicity test asserts what the database holds after a real mid-operation
 * failure. SQLite: a trigger with `RAISE(ABORT)`; Postgres: a plpgsql trigger
 * function that raises.
 */
export const injectFailure = (options: {
  readonly name: string;
  readonly table: string;
  readonly event: "DELETE" | "INSERT" | "UPDATE";
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.onDialectOrElse({
      pg: () =>
        Effect.gen(function* () {
          yield* sql.unsafe(
            `CREATE OR REPLACE FUNCTION ${options.name}() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'injected'; END $$`,
          );
          yield* sql.unsafe(
            `CREATE TRIGGER ${options.name} BEFORE ${options.event} ON ${options.table}
             FOR EACH ROW EXECUTE FUNCTION ${options.name}()`,
          );
        }),
      orElse: () =>
        sql.unsafe(
          `CREATE TRIGGER ${options.name} BEFORE ${options.event} ON ${options.table}
           BEGIN SELECT RAISE(ABORT, 'injected'); END`,
        ),
    });
  });

/** `suite` names the schema on Postgres; use one distinct name per test file. */
export const layer = (suite: string) =>
  asSqlClient(
    postgresUrl === undefined
      ? SqliteClient.layer({ filename: ":memory:" })
      : postgres(postgresUrl, suite),
  );

/**
 * Readies the ambient database for a row-level-security probe: core's tables exist (`enableRls`
 * always covers the partitioned core tables), `role` exists, and it can use this suite's schema
 * (`layer` gives each suite its own, never `public`). Idempotent; call before `TenantScope.enableRls`.
 */
export const prepareRlsProbe = (role: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      loader: CoreMigrations.coreMigrations,
      table: "effect_sql_migrations",
    });
    yield* sql.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
    );
    const current = yield* sql<{ readonly name: string }>`SELECT current_schema() AS name`;
    const schema = current[0]?.name ?? "public";
    yield* sql.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
    yield* sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`);
  });
