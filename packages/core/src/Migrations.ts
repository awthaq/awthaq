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
 * Shipping-gap map (.scratch/shipping-gaps), ticket 15: wires this
 * scaffold's plugin-declared `Migrations` list (`Auth.make`'s own
 * `built.migrations`, already dependency-ordered and renumbered into
 * `"0001_<pluginId>_<name>"`-style names by `Auth.ts`'s own
 * `renumberMigrations`) onto Effect's real `Migrator` — the same runner
 * `@awthaq/sql`'s `CoreMigrations.coreMigrations` uses for the core
 * tables. Array index (already the correct dependency order) becomes the
 * migrator's own numeric id; no plugin populates `migrations` yet (the
 * "no line of source exists yet" era's own scaffold-only starting point),
 * so this has no real caller today — proportionate for a first wiring,
 * not dead weight: a plugin author adding `migrations: [...]` to their
 * own `AuthPlugin.Service` options gets a real, tested runner for free.
 */
export const run = (
  migrations: Migrations,
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
> =>
  Migrator.make({})({
    loader: Effect.succeed(
      migrations.map((m, i): Migrator.ResolvedMigration => [i + 1, m.name, Effect.succeed(m.up)]),
    ),
  });
