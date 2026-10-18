// @awthaq/core — Migrations
//
// The plugin migration contract (BEH-EA-037/038, spec/behaviors/05-persistence-stratum.md): a name
// to re-key (BEH-EA-016) and something runnable. A records module declares its own migrations
// as a `group` beside the codec and queries of the tables it builds, written with `@awthaq/sql`'s
// `SqlDdl` fragments (one statement for both dialects, ADR-EA-004 rev 1.3), and a plugin's
// `migrations` is a `ledger` over its modules' groups that names the historical order once.

import { Defects } from "@awthaq/ports";
import { SqlDdl } from "@awthaq/sql";
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
 * Wires a plugin-declared `Migrations` list (`Auth.make`'s own `built.migrations`, already
 * dependency-ordered and renumbered into `"0001_<pluginId>_<name>"`-style names by `Auth.ts`'s
 * own `renumberMigrations`) onto Effect's real `Migrator`, the same runner `@awthaq/sql`'s
 * `CoreMigrations.coreMigrations` uses for the core tables. Array index (already the correct
 * dependency order) becomes the migrator's own numeric id. The CLI's `apply`
 * (`@awthaq/cli`'s `Migration.ts`) is its production call site.
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

// ---- groups and ledgers (plan 22) ---------------------------------------------------------

/** A migration body over the resolved dialect helper; its own `SqlClient` is `ddl.sql`. */
export type Up<E> = (ddl: SqlDdl.Ddl) => Effect.Effect<unknown, E>;

const migrationOf = (name: string, up: Up<unknown>): Migration => ({
  name,
  up: Effect.gen(function* () {
    const ddl = yield* SqlDdl.make(yield* SqlClient.SqlClient);
    yield* up(ddl);
  }),
});

/**
 * BEH-EA-037 (plan 22): a records module's own migrations, keyed by their ledger name. The key is
 * the name, so there is no second spelling to drift. Declare a group next to the codec and queries
 * of the tables it builds; append only, because a migration's position in the plugin's ledger is its
 * id (BEH-EA-038).
 */
export function group<const B extends Readonly<Record<string, Up<unknown>>>>(
  bodies: B,
): { readonly [K in keyof B]: Migration };
export function group(
  bodies: Readonly<Record<string, Up<unknown>>>,
): Readonly<Record<string, Migration>> {
  return Object.fromEntries(
    Object.entries(bodies).map(([name, up]) => [name, migrationOf(name, up)]),
  );
}

/** The migration names a group (or a union of groups) declares. */
type NamesOf<G> = G extends unknown ? keyof G & string : never;

/** Names declared by two groups at once: `never` when the groups are disjoint. */
type Shared<Gs extends ReadonlyArray<unknown>> = Gs extends readonly [infer H, ...infer T]
  ? (keyof H & NamesOf<T[number]>) | Shared<T>
  : never;

/**
 * BEH-EA-037/038 (plan 22): the plugin's migration ledger, the one place its historical order is
 * written. `order` must name every migration of every group, and two groups may not share a name;
 * both are compile errors that name the offending migrations. Positions are migration ids: append,
 * never reorder. A name listed twice is refused by `Auth.make` (BEH-EA-038).
 */
export const ledger = <
  const Gs extends ReadonlyArray<Readonly<Record<string, Migration>>>,
  const O extends ReadonlyArray<NamesOf<Gs[number]>>,
>(
  groups: Gs & ([Shared<Gs>] extends [never] ? unknown : { readonly sharedNames: Shared<Gs> }),
  order: O &
    ([Exclude<NamesOf<Gs[number]>, O[number]>] extends [never]
      ? unknown
      : { readonly missing: Exclude<NamesOf<Gs[number]>, O[number]> }),
): Migrations =>
  order.map((name) => {
    for (const candidate of groups) {
      const found = candidate[name];
      if (found !== undefined) return found;
    }
    // Unreachable through the types; a migration that dies when run, never a silent skip.
    return {
      name,
      up: Defects.invariantViolation("migrations.ledger", `no group declares migration "${name}"`),
    };
  });
