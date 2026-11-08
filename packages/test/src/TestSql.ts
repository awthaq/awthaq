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
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

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

// ---- the structural schema of the ambient database (plan 22 section 3.5) ---------------------

/** The declared type, reduced to what both dialects can be compared on. */
export type LogicalType = "text" | "timestamp" | "boolean" | "integer" | "other";

export interface ColumnShape {
  readonly name: string;
  readonly type: LogicalType;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly primaryKey: boolean;
}

export interface IndexShape {
  readonly name: string;
  readonly table: string;
  /** An expression column reads as `"<expr>"`. */
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
  readonly partial: boolean;
}

export interface TriggerShape {
  readonly name: string;
  readonly table: string;
}

export interface SchemaShape {
  readonly tables: Readonly<Record<string, ReadonlyArray<ColumnShape>>>;
  readonly indexes: ReadonlyArray<IndexShape>;
  readonly triggers: ReadonlyArray<TriggerShape>;
}

const ledgers = ["effect_sql_migrations", "awthaq_plugin_migrations"];

const logicalType = (declared: string): LogicalType => {
  switch (declared.toLowerCase()) {
    case "text":
    case "character varying":
      return "text";
    case "timestamp with time zone":
      return "timestamp";
    case "boolean":
      return "boolean";
    case "integer":
    case "bigint":
    case "smallint":
      return "integer";
    default:
      return "other";
  }
};

const byName = <A extends { readonly name: string }>(rows: ReadonlyArray<A>) =>
  [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const sqliteSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tableRows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ${sql.in(ledgers)}`;
    const tables: Record<string, ReadonlyArray<ColumnShape>> = {};
    const indexes: Array<IndexShape> = [];
    for (const { name: table } of byName(tableRows)) {
      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${table})`;
      tables[table] = columns.map((column) => ({
        name: column.name,
        type: logicalType(column.type),
        notNull: column.notnull === 1 || column.pk > 0,
        hasDefault: column.dflt_value !== null,
        primaryKey: column.pk > 0,
      }));
      const list = yield* sql<{
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`SELECT name, "unique", origin, partial FROM pragma_index_list(${table})`;
      for (const index of list) {
        if (index.origin !== "c") continue;
        const parts = yield* sql<{ readonly name: string | null }>`
          SELECT name FROM pragma_index_info(${index.name}) ORDER BY seqno`;
        indexes.push({
          name: index.name,
          table,
          columns: parts.map((part) => part.name ?? "<expr>"),
          unique: index.unique === 1,
          partial: index.partial === 1,
        });
      }
    }
    const triggers = yield* sql<{ readonly name: string; readonly table: string }>`
      SELECT name, tbl_name AS "table" FROM sqlite_master WHERE type = 'trigger'`;
    return { tables, indexes: byName(indexes), triggers: byName(triggers) } satisfies SchemaShape;
  });

const postgresSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const columns = yield* sql<{
      readonly table: string;
      readonly name: string;
      readonly type: string;
      readonly nullable: string;
      readonly dflt: string | null;
      readonly pk: boolean;
    }>`
      SELECT c.table_name AS "table", c.column_name AS name, c.data_type AS type,
             c.is_nullable AS nullable, c.column_default AS dflt,
             EXISTS (
               SELECT 1 FROM pg_index ix
               JOIN pg_class t ON t.oid = ix.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (ix.indkey)
               WHERE ix.indisprimary AND n.nspname = c.table_schema
                 AND t.relname = c.table_name AND a.attname = c.column_name
             ) AS pk
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT IN ${sql.in(ledgers)}
      ORDER BY c.table_name, c.ordinal_position`;
    const tables: Record<string, Array<ColumnShape>> = {};
    for (const column of columns) {
      const list = tables[column.table] ?? [];
      list.push({
        name: column.name,
        type: logicalType(column.type),
        notNull: column.nullable === "NO",
        hasDefault: column.dflt !== null,
        primaryKey: column.pk,
      });
      tables[column.table] = list;
    }
    const indexRows = yield* sql<{
      readonly table: string;
      readonly name: string;
      readonly unique: boolean;
      readonly partial: boolean;
      readonly columns: ReadonlyArray<string>;
    }>`
      SELECT t.relname AS "table", i.relname AS name, ix.indisunique AS "unique",
             (ix.indpred IS NOT NULL) AS partial,
             ARRAY(
               SELECT CASE WHEN u.k = 0 THEN '<expr>' ELSE a.attname::text END
               FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS u(k, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.k
               ORDER BY u.ord
             ) AS columns
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND NOT ix.indisprimary
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid)
        AND t.relname NOT IN ${sql.in(ledgers)}`;
    const triggers = yield* sql<{ readonly name: string; readonly table: string }>`
      SELECT g.tgname AS name, t.relname AS "table"
      FROM pg_trigger g
      JOIN pg_class t ON t.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE NOT g.tgisinternal AND n.nspname = current_schema()`;
    return {
      tables,
      indexes: byName(indexRows),
      triggers: byName(triggers),
    } satisfies SchemaShape;
  });

/**
 * The structural schema of the ambient database (tables, columns, plain indexes, triggers; no
 * ledger, no SQLite internals), sorted so two shapes compare by value. Statement text is not part
 * of it: `"id"` versus `id` or whitespace in a trigger body is not a schema difference.
 */
export const schemaOf: Effect.Effect<SchemaShape, SqlError, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.onDialectOrElse({
      pg: () => postgresSchema(sql),
      orElse: () => sqliteSchema(sql),
    });
  },
);

/**
 * Where two shapes (Postgres, then SQLite) disagree under the parity rule: a Postgres `timestamp`
 * matches SQLite `text`, `boolean` matches `integer`; a primary key's default (a sequence) is not
 * compared, and triggers are compared by the tables they guard. Empty when the logical schemas agree; each entry names table, column and aspect.
 */
export const parityDifferences = (pg: SchemaShape, sqlite: SchemaShape): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const comparable = (type: LogicalType): LogicalType =>
    type === "timestamp" ? "text" : type === "boolean" ? "integer" : type;
  const names = new Set([...Object.keys(pg.tables), ...Object.keys(sqlite.tables)]);
  for (const table of [...names].sort()) {
    const left = pg.tables[table];
    const right = sqlite.tables[table];
    if (left === undefined || right === undefined) {
      out.push(`table ${table}: only on ${left === undefined ? "SQLite" : "Postgres"}`);
      continue;
    }
    const columns = new Set([...left.map((c) => c.name), ...right.map((c) => c.name)]);
    for (const name of [...columns].sort()) {
      const a = left.find((c) => c.name === name);
      const b = right.find((c) => c.name === name);
      if (a === undefined || b === undefined) {
        out.push(`${table}.${name}: only on ${a === undefined ? "SQLite" : "Postgres"}`);
        continue;
      }
      if (comparable(a.type) !== comparable(b.type))
        out.push(`${table}.${name}: type ${a.type} (Postgres) vs ${b.type} (SQLite)`);
      if (a.notNull !== b.notNull) out.push(`${table}.${name}: nullability differs`);
      if (a.primaryKey !== b.primaryKey) out.push(`${table}.${name}: primary key differs`);
      if (!a.primaryKey && a.hasDefault !== b.hasDefault)
        out.push(`${table}.${name}: default differs`);
    }
  }
  const key = (i: IndexShape) =>
    `${i.name} on ${i.table} (${i.columns.join(", ")}) unique=${i.unique} partial=${i.partial}`;
  const left = new Set(pg.indexes.map(key));
  const right = new Set(sqlite.indexes.map(key));
  for (const k of [...left].sort()) if (!right.has(k)) out.push(`index ${k}: only on Postgres`);
  for (const k of [...right].sort()) if (!left.has(k)) out.push(`index ${k}: only on SQLite`);
  // Triggers are the one place the dialects differ in shape (plpgsql functions versus SQLite trigger bodies),
  // so their names differ: what must agree is which tables are guarded by at least one.
  const tl = new Set(pg.triggers.map((i) => i.table));
  const tr = new Set(sqlite.triggers.map((i) => i.table));
  for (const k of [...tl].sort()) if (!tr.has(k)) out.push(`triggers on ${k}: only on Postgres`);
  for (const k of [...tr].sort()) if (!tl.has(k)) out.push(`triggers on ${k}: only on SQLite`);
  return out;
};
