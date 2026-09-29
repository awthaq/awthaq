// @awthaq/core — Migrations
//
// A minimal placeholder ahead of the Persistence stratum (BEH-EA-033 through
// BEH-EA-040, spec/behaviors/05-persistence-stratum.md), which owns the real,
// SqlClient-shaped migration signature. `AuthPlugin` and `Auth.make` only need
// a name to re-key (BEH-EA-016) and something runnable — that is fixed here so
// the plugin contract does not have to wait on the persistence stratum to
// exist.

import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface Migration {
  readonly name: string;
  readonly up: Effect.Effect<void, unknown, unknown>;
  readonly down?: Effect.Effect<void, unknown, unknown>;
}

export type Migrations = ReadonlyArray<Migration>;

/**
 * N11 — the migration id space. Effect's `Migrator` records only a numeric id
 * per migration and skips any id at or below the newest one already recorded
 * in its tracking table. The core tables (`@awthaq/sql`'s
 * `CoreMigrations.coreMigrations`, ids 1-17 in `effect_sql_migrations`) and
 * the plugin list below (array-index ids from 1) are two independent id
 * spaces, so they must never share a ledger: run together in one table, every
 * plugin migration numbered <= 17 would be skipped without an error. Each
 * owner therefore has its own tracking table — core keeps the migrator's
 * default `effect_sql_migrations`, plugins use this one (a plugin store that
 * ships its own out-of-band migration, like the SQL rate limiter, picks its
 * own). A runner applies core first, then `run(auth.migrations)`.
 *
 * Within the plugin ledger the ids are positions in `Auth.make`'s
 * dependency-ordered list, so adding a plugin that sorts *before* one already
 * applied shifts the later ids; pin the plugin set (or append new plugins
 * last) on a database that has already been migrated.
 */
export const pluginMigrationsTable = "awthaq_plugin_migrations";

/**
 * Shipping-gap map (.scratch/shipping-gaps), ticket 15: wires this
 * scaffold's plugin-declared `Migrations` list (`Auth.make`'s own
 * `built.migrations`, already dependency-ordered and renumbered into
 * `"0001_<pluginId>_<name>"`-style names by `Auth.ts`'s own
 * `renumberMigrations`) onto Effect's real `Migrator` — the same runner
 * `@awthaq/sql`'s `CoreMigrations.coreMigrations` uses for the core
 * tables. Array index (already the correct dependency order) becomes the
 * migrator's own numeric id.
 *
 * BE-001 (.issues/high): every plugin that owns a table now populates its
 * own `migrations` (`admin`, `jwt`, `organization`, `passkey`, `roles` —
 * see each plugin's own `src/*.ts`, and `packages/core/test/AuthPlugin.test.ts`'s
 * `Auth.make` suite for the aggregation itself under test), each plugin's
 * own test suite runs its real migrations rather than a hand-rolled inline
 * `CREATE TABLE`, and `oauth`/`password` deliberately keep `tables: []`
 * (see either plugin's own comment for why). This module's own `run` still
 * has no PRODUCTION call site — no bootstrap/CLI/deployment path invokes
 * it yet — because that requires `AuthCore` (M1 Core, this module's own
 * original "no line of source exists yet" era) to exist as a real
 * `AuthPlugin` `Auth.make` can prepend core's own migrations alongside;
 * see `Auth.ts`'s own module header for that scoping. A plugin author
 * adding `migrations: [...]` to their own `AuthPlugin.Service` options
 * still gets a real, tested runner for free the moment that lands.
 */
export const run = (
  migrations: Migrations,
  options?: { readonly table?: string },
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
> =>
  Migrator.make({})({
    loader: Effect.succeed(
      migrations.map((m, i): Migrator.ResolvedMigration => [i + 1, m.name, Effect.succeed(m.up)]),
    ),
    table: options?.table ?? pluginMigrationsTable,
  });
