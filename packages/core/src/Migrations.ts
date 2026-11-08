// @awthaq/core — Migrations
//
// The plugin migration contract (BEH-EA-037/038, spec/behaviors/05-persistence-stratum.md): a name
// to re-key (BEH-EA-016) and something runnable. A records module declares its own migrations
// as a `group` beside the codec and queries of the tables it builds, written with `@awthaq/sql`'s
// `SqlDdl` fragments (one statement for both dialects, ADR-EA-004 rev 1.3), and a plugin's
// `migrations` is a `ledger` over its modules' groups that names the historical order once.

import { Defects } from "@awthaq/ports";
import { CoreMigrations, SqlDdl } from "@awthaq/sql";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

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
 *  own). `apply` (below) runs core first, then `run(auth.migrations)`.
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
 * own `renumberMigrations`) onto Effect's real `Migrator`. Array index (already the correct
 * dependency order) becomes the migrator's own numeric id. It has no drift guard of its own: the
 * runner is `apply` / `verify` below, called by `awthaq migration apply` and by `AuthHost`.
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

// ---- the runner (plan 15) -----------------------------------------------------------------
//
// BEH-EA-204 / BEH-EA-039: the migrator is forward-only and silent about two things that change what an
// apply does: a ledger id the linker no longer produces (or a same-id, different-name row: a plugin set
// that changed under the ledger), and a pending id that sorts *before* an applied one (a plugin added ahead
// of one already applied shifts every later id, and `Migrator` skips it). Both are drift. `status` reports
// them; `apply` and `verify` refuse them. One implementation, shared by `awthaq migration apply` and
// `AuthHost`'s SQL mode (moved here from the CLI, plan 15).

/** Core's ledger: `Migrator`'s default table, where `CoreMigrations.coreMigrations` records. */
export const coreMigrationsTable = "effect_sql_migrations";

/** One migration the linker knows about, or one row a ledger holds. */
export interface Entry {
  readonly id: number;
  readonly name: string;
}

export type LedgerName = "core" | "plugins";

/** What one ledger says relative to what the linker would apply. */
export interface LedgerReport {
  readonly ledger: LedgerName;
  readonly table: string;
  readonly applied: ReadonlyArray<Entry>;
  readonly pending: ReadonlyArray<Entry>;
  /** Applied rows the linker's record does not contain (same id and name). */
  readonly unknown: ReadonlyArray<Entry>;
  /** Pending ids that sort before an applied one: `Migrator` would skip them silently. */
  readonly outOfOrder: ReadonlyArray<Entry>;
}

/** Both ledgers, core first, and whether either disagrees with the linker. */
export interface Status {
  readonly ledgers: ReadonlyArray<LedgerReport>;
  readonly drift: boolean;
}

/** A ledger holds an id the linker does not produce, or a pending id sorts before an applied one (BEH-EA-204). */
export class LedgerDrift extends Data.TaggedError("Migrations/LedgerDrift")<{
  readonly message: string;
  readonly status: Status;
}> {}

/** `verify`: the schema is behind the composition. `message` names every pending entry, ledger first. */
export class Pending extends Data.TaggedError("Migrations/Pending")<{
  readonly message: string;
  readonly status: Status;
}> {}

/** A batch failed and rolled back; `ledger` says which (core's batch may already be applied when plugins' fails). */
export class MigrationFailed extends Data.TaggedError("Migrations/MigrationFailed")<{
  readonly message: string;
  readonly ledger: LedgerName;
  readonly cause: unknown;
}> {}

/** What a host composition does with the migrations when it is built (BEH-EA-204 rule, plan 15). */
export type OnBuild = "apply" | "verify";
export type OnBuildError = LedgerDrift | Pending | MigrationFailed | SqlError;

/** The pure diff of one ledger against the linker's ordered record (`known`, ascending ids). */
export const diff = (
  ledger: LedgerName,
  table: string,
  known: ReadonlyArray<Entry>,
  applied: ReadonlyArray<Entry>,
): LedgerReport => {
  const appliedIds = new Set(applied.map((entry) => entry.id));
  const knownByKey = new Set(known.map((entry) => `${entry.id}:${entry.name}`));
  const newestApplied = applied.reduce((max, entry) => Math.max(max, entry.id), 0);
  const pending = known.filter((entry) => !appliedIds.has(entry.id));
  return {
    ledger,
    table,
    applied,
    pending,
    unknown: applied.filter((entry) => !knownByKey.has(`${entry.id}:${entry.name}`)),
    outOfOrder: pending.filter((entry) => entry.id < newestApplied),
  };
};

const hasDrift = (report: LedgerReport) =>
  report.unknown.length > 0 || report.outOfOrder.length > 0;

/** Whether `table` exists on the current client (dialect-aware). Reads, never creates. */
export const tableExists = Effect.fnUntraced(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql.onDialectOrElse({
    pg: () =>
      sql<{
        readonly n: number;
      }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${table}`,
    orElse: () =>
      sql<{
        readonly n: number;
      }>`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  });
  return Number(found[0]?.n ?? 0) > 0;
});

/** A ledger table that has never been created is an empty ledger; reading it must not create it. */
const readLedger = Effect.fnUntraced(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(table))) return [];
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id ASC`;
  return rows.map((row): Entry => ({ id: Number(row.migration_id), name: row.name }));
});

const coreKnown = Effect.map(CoreMigrations.coreMigrations, (resolved) =>
  resolved.map(([id, name]): Entry => ({ id, name })),
).pipe(
  Effect.mapError(
    (cause) =>
      new MigrationFailed({
        message: "could not resolve core's migrations",
        ledger: "core",
        cause,
      }),
  ),
);

/** The linker's plugin record: array position + 1 is the id (`run`), the re-keyed name the label. */
export const pluginKnown = (plugins: Migrations): ReadonlyArray<Entry> =>
  plugins.map((migration, index): Entry => ({ id: index + 1, name: migration.name }));

/** Read-only: both ledgers against the linker's record (core's migrations, then `plugins`). Never creates a ledger table. */
export const status = Effect.fnUntraced(function* (plugins: Migrations) {
  const core = diff(
    "core",
    coreMigrationsTable,
    yield* coreKnown,
    yield* readLedger(coreMigrationsTable),
  );
  const pluginLedger = diff(
    "plugins",
    pluginMigrationsTable,
    pluginKnown(plugins),
    yield* readLedger(pluginMigrationsTable),
  );
  const ledgers = [core, pluginLedger];
  const result: Status = { ledgers, drift: ledgers.some(hasDrift) };
  return result;
});

/** `0001  name`: how the CLI and the error messages print an entry. */
export const label = (entry: Entry) => `${String(entry.id).padStart(4, "0")}  ${entry.name}`;

/** Every drifted entry, ledger first (the CLI's `LedgerDrift` text, unchanged). */
export const driftMessage = (current: Status) => {
  const found = current.ledgers.flatMap((ledger) => [
    ...ledger.unknown.map(
      (entry) => `${ledger.ledger} ledger holds ${label(entry)}, unknown to the linker`,
    ),
    ...ledger.outOfOrder.map(
      (entry) => `${ledger.ledger} migration ${label(entry)} sorts before an applied one`,
    ),
  ]);
  return `ledger drift: ${found.join("; ")}`;
};

const pendingMessage = (current: Status) => {
  const pending = current.ledgers.flatMap((ledger) =>
    ledger.pending.map((entry) => `${ledger.ledger} ${entry.name}`),
  );
  return `${pending.length} migration(s) pending: ${pending.join(", ")}`;
};

/**
 * Refuses on drift; applies core's pending batch, then the plugins', each into its own ledger. A no-op (no
 * `Migrator` call) when nothing is pending. Concurrent applies are serialized by `Migrator`'s own ledger lock
 * (it re-reads the newest id under it), so a second replica booting at once applies nothing.
 */
export const apply = Effect.fnUntraced(function* (plugins: Migrations) {
  const before = yield* status(plugins);
  if (before.drift) {
    return yield* new LedgerDrift({ message: driftMessage(before), status: before });
  }
  if (before.ledgers.every((ledger) => ledger.pending.length === 0)) return before;
  yield* Migrator.make({})({
    loader: CoreMigrations.coreMigrations,
    table: coreMigrationsTable,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new MigrationFailed({
          message: "a core migration failed; none of that batch was applied",
          ledger: "core",
          cause,
        }),
    ),
  );
  yield* run(plugins).pipe(
    Effect.mapError(
      (cause) =>
        new MigrationFailed({
          message:
            "a plugin migration failed; none of that batch was applied (core migrations already applied stay applied)",
          ledger: "plugins",
          cause,
        }),
    ),
  );
  return before;
});

/** Refuses on drift or on anything pending; applies nothing and creates no ledger table. */
export const verify = Effect.fnUntraced(function* (plugins: Migrations) {
  const current = yield* status(plugins);
  if (current.drift) {
    return yield* new LedgerDrift({ message: driftMessage(current), status: current });
  }
  if (current.ledgers.some((ledger) => ledger.pending.length > 0)) {
    return yield* new Pending({ message: pendingMessage(current), status: current });
  }
  return current;
});

/** What `AuthHost` runs when its SQL layer is built (BEH-EA-204 rule, plan 15). */
export const onBuild = (mode: OnBuild, plugins: Migrations) =>
  mode === "apply" ? Effect.asVoid(apply(plugins)) : Effect.asVoid(verify(plugins));

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
