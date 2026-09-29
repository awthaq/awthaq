// @awthaq/cli — Migration
//
// spec/behaviors/26-cli.md BEH-EA-204 (ECS-009, MW-006).
//
// Two ledgers, two id spaces (BEH-EA-038, N11): core's `coreMigrations` (ids 1-20)
// record into `effect_sql_migrations`; the linker's re-keyed plugin list
// (`Migrations.run`, ids from 1 in dependency order) records into
// `awthaq_plugin_migrations`. Effect's `Migrator` skips any id at or below the
// newest one recorded, so putting both in one table would silently skip every
// plugin migration numbered <= 20. `status` and `apply` therefore go through
// `Migrations.run` and the core loader, never a single hand-rolled runner.
//
// The migrator itself is forward-only and silent about two things that change
// what `apply` does: a ledger id the linker no longer produces (or a same-id,
// different-name row — a plugin set that changed under the ledger), and a pending
// id that sorts *before* an applied one (a plugin added ahead of one already
// applied shifts every later id). Both are reported as drift; `status` fails with
// the drift code and `apply` refuses to run (BEH-EA-039's first CLI guardrails).
// `status` is read-only: it never creates a ledger table, an absent one is empty.

import { Migrations } from "@awthaq/core";
import { CoreMigrations } from "@awthaq/sql";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ConfirmationRequired, DatabaseUnavailable, LedgerDrift, MigrationFailed, NothingToApply } from "./CliErrors.ts";
import type { LoadedAuth } from "./Config.ts";
import * as Output from "./Output.ts";

export const coreLedgerTable = "effect_sql_migrations";
export const pluginLedgerTable = Migrations.pluginMigrationsTable;

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

export interface StatusReport {
  readonly ledgers: ReadonlyArray<LedgerReport>;
  readonly drift: boolean;
}

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

const hasDrift = (report: LedgerReport) => report.unknown.length > 0 || report.outOfOrder.length > 0;

const sqlFailure = () =>
  new DatabaseUnavailable({ message: "the database did not answer a ledger query" });

/** Whether `table` exists on the current client (dialect-aware); `status` and `import` read, never create. */
export const tableExists = Effect.fnUntraced(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql
    .onDialectOrElse({
      pg: () =>
        sql<{
          readonly n: number;
        }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${table}`,
      orElse: () =>
        sql<{
          readonly n: number;
        }>`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
    })
    .pipe(Effect.mapError(sqlFailure));
  return Number(found[0]?.n ?? 0) > 0;
});

/** A ledger table that has never been created is an empty ledger; `status` must not create it. */
const readLedger = Effect.fnUntraced(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(table))) return [];
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id ASC`.pipe(
    Effect.mapError(sqlFailure),
  );
  return rows.map((row): Entry => ({ id: Number(row.migration_id), name: row.name }));
});

const coreKnown = Effect.gen(function* () {
  const resolved = yield* CoreMigrations.coreMigrations;
  return resolved.map(([id, name]): Entry => ({ id, name }));
}).pipe(
  Effect.mapError(() => new MigrationFailed({ message: "could not resolve core's migrations" })),
);

/** The linker's plugin record: array position + 1 is the id (`Migrations.run`), the re-keyed name the label. */
export const pluginKnown = (auth: LoadedAuth): ReadonlyArray<Entry> =>
  auth.migrations.map((migration, index): Entry => ({ id: index + 1, name: migration.name }));

/** Reads both ledgers and diffs each against the linker's record. Read-only. */
export const inspect = (auth: LoadedAuth) =>
  Effect.gen(function* () {
    const core = diff("core", coreLedgerTable, yield* coreKnown, yield* readLedger(coreLedgerTable));
    const plugins = diff(
      "plugins",
      pluginLedgerTable,
      pluginKnown(auth),
      yield* readLedger(pluginLedgerTable),
    );
    const ledgers = [core, plugins];
    const report: StatusReport = { ledgers, drift: ledgers.some(hasDrift) };
    return report;
  });

const label = (entry: Entry) => `${String(entry.id).padStart(4, "0")}  ${entry.name}`;

const renderLedger = (report: LedgerReport) => [
  `${report.ledger} (${report.table}): ${report.applied.length} applied, ${report.pending.length} pending`,
  ...report.pending.map((entry) => `  pending  ${label(entry)}`),
  ...report.unknown.map((entry) => `  DRIFT    applied ${label(entry)} is not in the linker's record`),
  ...report.outOfOrder.map(
    (entry) => `  DRIFT    pending ${label(entry)} sorts before an applied migration and would be skipped`,
  ),
];

export const renderStatus = (report: StatusReport) => [
  ...report.ledgers.flatMap(renderLedger),
  ...(report.drift ? ["drift: the ledger and the linker's record disagree; resolve it before applying"] : []),
];

const driftMessage = (report: StatusReport) => {
  const found = report.ledgers.flatMap((ledger) => [
    ...ledger.unknown.map((entry) => `${ledger.ledger} ledger holds ${label(entry)}, unknown to the linker`),
    ...ledger.outOfOrder.map(
      (entry) => `${ledger.ledger} migration ${label(entry)} sorts before an applied one`,
    ),
  ]);
  return `ledger drift: ${found.join("; ")}`;
};

/** BEH-EA-204: reports both ledgers; fails `LedgerDrift` (exit 7) when they disagree with the linker. */
export const status = (auth: LoadedAuth) =>
  Effect.gen(function* () {
    const report = yield* inspect(auth);
    yield* Output.report(report, renderStatus);
    if (report.drift) return yield* new LedgerDrift({ message: driftMessage(report) });
  });

export interface ApplyOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly allowEmpty: boolean;
}

/**
 * BEH-EA-204: print the ordered pending set, refuse on drift, require `--yes`.
 * Core runs first (its own ledger), then the plugin list through `Migrations.run`.
 */
export const apply = (auth: LoadedAuth, options: ApplyOptions) =>
  Effect.gen(function* () {
    const report = yield* inspect(auth);
    const pending = report.ledgers.flatMap((ledger) =>
      ledger.pending.map((entry) => ({ ledger: ledger.ledger, id: entry.id, name: entry.name })),
    );
    const out = yield* Output.Output;
    // One JSON document per run: the plan, with whether it was applied. Text mode prints the
    // plan first, so an operator sees what is about to run before it does.
    const finish = (applied: boolean) =>
      out.json ? out.document({ pending, drift: report.drift, applied }) : Effect.void;
    if (!out.json) yield* Effect.forEach(renderStatus(report), out.line, { discard: true });
    if (report.drift) {
      yield* finish(false);
      return yield* new LedgerDrift({ message: driftMessage(report) });
    }
    if (pending.length === 0) {
      yield* finish(false);
      if (options.allowEmpty) return;
      return yield* new NothingToApply({ message: "no pending migrations" });
    }
    if (options.dryRun) return yield* finish(false);
    if (!options.yes) {
      yield* finish(false);
      return yield* new ConfirmationRequired({
        command: "migration apply",
        message: `${pending.length} migration(s) pending; re-run with --yes to apply them (or --dry-run to only print the plan)`,
      });
    }
    yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations }).pipe(
      Effect.mapError(
        () => new MigrationFailed({ message: "a core migration failed; none of that batch was applied" }),
      ),
    );
    yield* Migrations.run(auth.migrations).pipe(
      Effect.mapError(
        () =>
          new MigrationFailed({
            message:
              "a plugin migration failed; none of that batch was applied (core migrations already applied stay applied)",
          }),
      ),
    );
    yield* finish(true);
    if (!out.json) yield* out.line(`applied ${pending.length} migration(s)`);
  });
