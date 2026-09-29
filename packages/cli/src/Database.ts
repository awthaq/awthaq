// @awthaq/cli — Database
//
// The SQL client the database-backed commands (BEH-EA-208, class 2) use when the
// operator gives `--database-url` (or `AWTHAQ_DATABASE_URL`) instead of relying on
// the `sql` Layer the configuration module exports. Two forms:
//
//   sqlite:./auth.db            sqlite::memory:      (`@effect/sql-sqlite-node`)
//   postgres://…  postgresql://…                     (`@effect/sql-pg`)
//
// The URL is a Schema (BEH-EA-226) and is never printed: a connection string
// carries a password, so an error names the scheme, not the value (BEH-EA-201).
//
// Postgres: `Migrator`'s Postgres branch checks for its ledger with
// `select 'name'::regclass`, and `@effect/sql-pg` 4.0.0-rc.116 has no codec for
// OID 2205 (regclass) — once the ledger exists, that row fails to decode and the
// connection is left unusable, so *any* second migrator run on a migrated
// database (every redeploy) fails. `packages/sql/README.md` ("Postgres client
// configuration") documents the workaround, a client-scoped codec (never a global
// override); this module registers it on the client the CLI builds, which is why
// `migration status|apply` works on an already-migrated database.

import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { DatabaseUnavailable } from "./CliErrors.ts";
import type { CliConfig } from "./Config.ts";

const SQLITE_PREFIX = "sqlite:";
const POSTGRES_PREFIXES: ReadonlyArray<string> = ["postgres://", "postgresql://"];

const isSqlite = (value: string) => value.startsWith(SQLITE_PREFIX);
const isPostgres = (value: string) => POSTGRES_PREFIXES.some((prefix) => value.startsWith(prefix));

/** BEH-EA-226: `--database-url` decodes through this Schema before any connection is attempted. */
export const DatabaseUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      isSqlite(value) || isPostgres(value)
        ? undefined
        : "a database URL: sqlite:<path> (or sqlite::memory:), postgres://… or postgresql://…",
    ),
  ),
);

/** The OID-2205 codec `packages/sql/README.md` documents: registered on the client the CLI builds, never globally. */
const regclassTypes = () => {
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

/** Which driver a URL selects, for messages that must not print the URL itself. */
export const describeUrl = (url: string) => (isSqlite(url) ? "sqlite" : "postgres");

/** A layer that fails `DatabaseUnavailable` — `Layer` has no `fail`, and a failed effect-context layer is one. */
const unavailable = (message: string): Layer.Layer<SqlClient.SqlClient, DatabaseUnavailable> =>
  Layer.effectContext(Effect.fail(new DatabaseUnavailable({ message })));

/** A `SqlClient` for `url` (already decoded by `DatabaseUrl`); a connection failure is `DatabaseUnavailable`, never the URL. */
export const layerFor = (url: string): Layer.Layer<SqlClient.SqlClient, DatabaseUnavailable> => {
  const message = `could not open the ${describeUrl(url)} database`;
  if (isSqlite(url)) {
    return SqliteClient.layer({ filename: url.slice(SQLITE_PREFIX.length) }).pipe(
      Layer.catchCause(() => unavailable(message)),
    );
  }
  return PgClient.layer({ url: Redacted.make(url), types: regclassTypes() }).pipe(
    Layer.catchCause(() => unavailable(message)),
  );
};

/** Builds the client for `url` once, to prove the database answers before a command relies on it. */
export const ping = (sql: SqlClient.SqlClient) =>
  sql`SELECT 1`.pipe(
    Effect.mapError(
      () => new DatabaseUnavailable({ message: "the database did not answer a trivial query" }),
    ),
  );

/**
 * The client a database-backed command runs on: an explicit `--database-url` wins, then the
 * `sql` Layer the configuration module exports, otherwise `DatabaseUnavailable` says how to
 * provide one.
 */
export const layerFrom = (
  config: CliConfig,
  url: string | undefined,
): Layer.Layer<SqlClient.SqlClient, DatabaseUnavailable> => {
  if (url !== undefined) return layerFor(url);
  if (config.sql !== undefined) {
    return config.sql.pipe(
      Layer.catchCause(() => unavailable("the configuration module's SQL client failed to start")),
    );
  }
  return unavailable(
    "no database: pass --database-url, set AWTHAQ_DATABASE_URL, or export `sql` from the configuration module",
  );
};
