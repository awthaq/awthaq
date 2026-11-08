// @awthaq/cli — Migration
//
// spec/behaviors/26-cli.md BEH-EA-204 (ECS-009, MW-006).
//
// Two ledgers, two id spaces (BEH-EA-038, N11): core's `coreMigrations` record into
// `effect_sql_migrations`; the linker's re-keyed plugin list records into
// `awthaq_plugin_migrations`. Reading both and refusing drift (a ledger id the
// linker no longer produces, or a pending id that sorts before an applied one) is
// core's `Migrations.status` / `Migrations.apply` (plan 15), the same runner
// `AuthHost` uses at boot. This module keeps what is about the command line:
// rendering, the plan preview, `--dry-run`, `--yes`, `--allow-empty`, `--json`
// and the exit codes. `status` is read-only: it never creates a ledger table.

import { Migrations } from "@awthaq/core";
import * as Effect from "effect/Effect";
import {
  ConfirmationRequired,
  DatabaseUnavailable,
  LedgerDrift,
  MigrationFailed,
  NothingToApply,
} from "./CliErrors.ts";
import type { LoadedAuth } from "./Config.ts";
import * as Output from "./Output.ts";

const sqlFailure = () =>
  new DatabaseUnavailable({ message: "the database did not answer a ledger query" });

/** Both ledgers against the linker's record (core's `Migrations.status`), with the CLI's error mapping. */
const inspect = (auth: LoadedAuth) =>
  Migrations.status(auth.migrations).pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(sqlFailure()),
      "Migrations/MigrationFailed": (error) =>
        Effect.fail(new MigrationFailed({ message: error.message })),
    }),
  );

const label = Migrations.label;

const renderLedger = (report: Migrations.LedgerReport) => [
  `${report.ledger} (${report.table}): ${report.applied.length} applied, ${report.pending.length} pending`,
  ...report.pending.map((entry) => `  pending  ${label(entry)}`),
  ...report.unknown.map(
    (entry) => `  DRIFT    applied ${label(entry)} is not in the linker's record`,
  ),
  ...report.outOfOrder.map(
    (entry) =>
      `  DRIFT    pending ${label(entry)} sorts before an applied migration and would be skipped`,
  ),
];

export const renderStatus = (report: Migrations.Status) => [
  ...report.ledgers.flatMap(renderLedger),
  ...(report.drift
    ? ["drift: the ledger and the linker's record disagree; resolve it before applying"]
    : []),
];

/** BEH-EA-204: reports both ledgers; fails `LedgerDrift` (exit 7) when they disagree with the linker. */
export const status = (auth: LoadedAuth) =>
  Effect.gen(function* () {
    const report = yield* inspect(auth);
    yield* Output.report(report, renderStatus);
    if (report.drift) return yield* new LedgerDrift({ message: Migrations.driftMessage(report) });
  });

export interface ApplyOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly allowEmpty: boolean;
}

/**
 * BEH-EA-204: print the ordered pending set, refuse on drift, require `--yes`.
 * The write is core's `Migrations.apply`: core first (its own ledger), then the plugin list.
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
      return yield* new LedgerDrift({ message: Migrations.driftMessage(report) });
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
    yield* Migrations.apply(auth.migrations).pipe(
      Effect.catchTags({
        SqlError: () => Effect.fail(sqlFailure()),
        "Migrations/LedgerDrift": (error) =>
          Effect.fail(new LedgerDrift({ message: error.message })),
        "Migrations/MigrationFailed": (error) =>
          Effect.fail(new MigrationFailed({ message: error.message })),
      }),
    );
    yield* finish(true);
    if (!out.json) yield* out.line(`applied ${pending.length} migration(s)`);
  });
