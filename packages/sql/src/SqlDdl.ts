// @awthaq/sql — SqlDdl
//
// ADR-EA-004 (revision 1.3), plan 22: the dialect-specific tokens of a migration statement as
// fragments, so one statement is written once for both dialects. A plugin's migration receives a
// `Ddl` (`Migrations.group` in `@awthaq/core` resolves it once per migration) and interpolates
// `${timestamp}` / `${boolean}` into a single `sql\`...\``, instead of writing a `pg` copy and a
// `sqlite` copy through `onDialectOrElse`. `index` renders `CREATE [UNIQUE] INDEX IF NOT EXISTS`
// by construction (SSMS-006: an operator may build any index `CONCURRENTLY` out of band first), and
// `only` covers a statement that exists on one dialect. A body that is genuinely different per
// dialect (a trigger) is the rare exception and branches with `ddl.sql.onDialectOrElse` itself.

import { Defects } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type * as Statement from "effect/unstable/sql/Statement";
import type * as Models from "./Models.ts";

/**
 * The type tokens that differ between the supported dialects, as fragments that interpolate into
 * one statement. Everything else (`TEXT`, `INTEGER`, `NOT NULL`, `PRIMARY KEY`, `UNIQUE`,
 * `DEFAULT '<text>'`) is spelled the same on both and is written inline.
 */
export interface Types {
  readonly dialect: Models.Dialect;
  /** `TIMESTAMPTZ` | `TEXT`. Pair with `Models.dialectFields(...).dateTime`. */
  readonly timestamp: Statement.Fragment;
  /** `BOOLEAN` | `INTEGER`. Pair with `.boolean`. */
  readonly boolean: Statement.Fragment;
  /** `FALSE` | `0` and `TRUE` | `1`, for a boolean column's `DEFAULT`. */
  readonly false: Statement.Fragment;
  readonly true: Statement.Fragment;
  /** `BIGINT` | `INTEGER`. Pair with `Models.dialectFields(...).int64` (Postgres decodes int8 as `bigint`). */
  readonly int64: Statement.Fragment;
  /** `SERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT`. */
  readonly autoIncrementKey: Statement.Fragment;
  /** `now()` | `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, the ISO text `Models` decodes on SQLite. */
  readonly nowTimestamp: Statement.Fragment;
}

export interface IndexOptions {
  readonly unique?: boolean | undefined;
  /** A partial index's predicate. */
  readonly where?: Statement.Fragment | undefined;
}

export interface Ddl extends Types {
  readonly sql: SqlClient.SqlClient;
  /**
   * SSMS-006: always `CREATE [UNIQUE] INDEX IF NOT EXISTS`. A string column is quoted as an
   * identifier; a fragment (an expression such as `("rotatedAt" IS NULL)`) is inlined.
   */
  readonly index: (
    name: string,
    table: string,
    columns: ReadonlyArray<string | Statement.Fragment>,
    options?: IndexOptions,
  ) => Effect.Effect<void, SqlError>;
  /** A statement that exists on some dialects only; a dialect without a branch does nothing. */
  readonly only: <E>(branches: {
    readonly pg?: () => Effect.Effect<unknown, E>;
    readonly sqlite?: () => Effect.Effect<unknown, E>;
  }) => Effect.Effect<void, E>;
}

const pg = (sql: SqlClient.SqlClient) =>
  ({
    dialect: "pg" as const,
    timestamp: sql.literal("TIMESTAMPTZ"),
    boolean: sql.literal("BOOLEAN"),
    false: sql.literal("FALSE"),
    true: sql.literal("TRUE"),
    int64: sql.literal("BIGINT"),
    autoIncrementKey: sql.literal("SERIAL PRIMARY KEY"),
    nowTimestamp: sql.literal("now()"),
  }) satisfies Types;

const sqlite = (sql: SqlClient.SqlClient) =>
  ({
    dialect: "sqlite" as const,
    timestamp: sql.literal("TEXT"),
    boolean: sql.literal("INTEGER"),
    false: sql.literal("0"),
    true: sql.literal("1"),
    int64: sql.literal("INTEGER"),
    autoIncrementKey: sql.literal("INTEGER PRIMARY KEY AUTOINCREMENT"),
    nowTimestamp: sql.literal("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"),
  }) satisfies Types;

/** Resolves the ambient client's dialect once. Any other dialect dies (`UnsupportedDialect`). */
export const make = (sql: SqlClient.SqlClient) =>
  sql
    .onDialectOrElse({
      pg: () => Effect.succeed<Types>(pg(sql)),
      sqlite: () => Effect.succeed<Types>(sqlite(sql)),
      orElse: () => Defects.unsupportedDialect("migrations"),
    })
    .pipe(
      Effect.map(
        (types: Types) =>
          ({
            ...types,
            sql,
            index: (name, table, columns, options?: IndexOptions) =>
              sql`CREATE ${sql.literal(options?.unique === true ? "UNIQUE " : "")}INDEX IF NOT EXISTS ${sql(name)} ON ${sql(table)} (${sql.join(
                ", ",
                false,
              )(
                columns.map((column) =>
                  typeof column === "string" ? sql`${sql(column)}` : column,
                ),
              )})${
                options?.where === undefined ? sql.literal("") : sql` WHERE ${options.where}`
              }`.pipe(Effect.asVoid),
            only: (branches) => {
              const branch = types.dialect === "pg" ? branches.pg : branches.sqlite;
              return branch === undefined ? Effect.void : Effect.asVoid(branch());
            },
          }) satisfies Ddl,
      ),
    );
