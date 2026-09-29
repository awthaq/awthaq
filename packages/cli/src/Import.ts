// @awthaq/cli — Import
//
// spec/behaviors/26-cli.md BEH-EA-207 (BAM-001, ECS-002, FAMS-010; decision 07 §6): the mechanism of
// `awthaq import --from <source>`, source-agnostic — a source is a `SourceAdapter` (`Sources.ts`).
//
// Write-side contract (ECS-002), the same shape as the other two write commands (`migration apply`
// needs `--yes`, `seed admin` needs `--force` over an existing admin):
//
//   - PLAN MODE is the default (`--dry-run` is an explicit alias): read and map the whole export,
//     print per-table row counts, the unmapped-field report and conflict counts, write nothing.
//   - `--yes` writes, in bounded batches (`--batch-size`), each batch in ONE transaction: a failed
//     batch rolls back only itself, is reported with its source row ids and error tag, and stops the
//     run (`--continue-on-error` keeps going), leaving the checkpoint at the last committed batch.
//   - The checkpoint is the `awthaq_import_runs` table (one row per source row; the ledger row is
//     written inside the same transaction as the user it records, so a rollback un-records it too).
//     Re-running against the same source skips every row already `done` and never inserts one twice.
//   - Rows go through `Users`/`Accounts` (`UserImport.importUser`: idempotent and atomic per user), never raw INSERTs. An address that
//     already exists in the target is a *conflict*: reported and skipped, not a failure.
//   - A row that can never be imported as it stands (an email-less Firebase user, a better-auth hash
//     nothing can verify) is *unmappable*: reported, skipped, re-evaluated on the next run.
//   - Each `--yes` run publishes one `auth.import.completed` (every row imported or skipped) or
//     `auth.import.failed` (a batch failed) with the run id and counts, which `AuditLog` persists.
//
// `awthaq_import_runs` is CLI tooling state, not part of the runtime (nothing in `Auth.make` depends on
// it): `import --yes` creates it with `CREATE TABLE IF NOT EXISTS` (portable across the two dialects),
// and plan mode only reads it when it exists.

import { Accounts, AuthEvents, UserImport, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { requireService, withApplication } from "./Application.ts";
import { ImportFailed, UsageError } from "./CliErrors.ts";
import type { CliConfig } from "./Config.ts";
import * as Migration from "./Migration.ts";
import * as Output from "./Output.ts";
import * as Sources from "./Sources.ts";

export const ledgerTable = "awthaq_import_runs";

/** BEH-EA-226: `--batch-size` decodes as a positive integer (one transaction per batch, so it is also the rollback unit). */
export const BatchSize = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10_000 })));

export interface ImportOptions {
  readonly from: string;
  readonly source: Sources.ImportSource;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly continueOnError: boolean;
  /** `--report <file>`: the per-row unmapped/unmappable/failure detail as JSON. */
  readonly report: string | undefined;
}

export interface Failure {
  readonly sourceRowIds: ReadonlyArray<string>;
  /** The failure's `_tag` (or `Defect`): never its message, which may quote a value. */
  readonly error: string;
}

export interface Summary {
  readonly source: string;
  readonly mode: "plan" | "import";
  readonly runId: string | undefined;
  readonly tables: Readonly<Record<string, Sources.TableCount>>;
  readonly users: {
    readonly seen: number;
    /** Plan mode: rows that `--yes` would write. Import mode: rows written. */
    readonly toImport: number;
    readonly alreadyImported: number;
    readonly emailConflicts: number;
    readonly unmappable: number;
    readonly failed: number;
  };
  readonly accounts: number;
  /** `table.column` -> number of rows carrying data there that has no awthaq destination. */
  readonly unmapped: Readonly<Record<string, number>>;
  readonly unmappableRows: ReadonlyArray<{ readonly sourceRowId: string; readonly reason: string }>;
  readonly failures: ReadonlyArray<Failure>;
}

// ---- checkpoint ledger ------------------------------------------------------

const ensureLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS ${sql(ledgerTable)} (
    source TEXT NOT NULL,
    source_row_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    imported_user_id TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, source_row_id)
  )`.pipe(Effect.orDie);
});

/** Source rows a previous run already imported (the resume point); empty when the ledger was never created. */
const doneIds = (source: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* Migration.tableExists(ledgerTable).pipe(Effect.orDie))) return new Set<string>();
    const rows = yield* sql<{
      readonly source_row_id: string;
    }>`SELECT source_row_id FROM ${sql(ledgerTable)} WHERE source = ${source} AND status = 'done'`.pipe(
      Effect.orDie,
    );
    return new Set(rows.map((row) => row.source_row_id));
  });

const record = (entry: {
  readonly source: string;
  readonly sourceRowId: string;
  readonly runId: string;
  readonly status: "done" | "skipped" | "unmappable";
  readonly userId: string | null;
  readonly error: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    yield* sql`INSERT INTO ${sql(ledgerTable)}
      (source, source_row_id, run_id, status, imported_user_id, error, updated_at)
      VALUES (${entry.source}, ${entry.sourceRowId}, ${entry.runId}, ${entry.status}, ${entry.userId}, ${entry.error}, ${now})
      ON CONFLICT (source, source_row_id) DO UPDATE SET
        run_id = excluded.run_id, status = excluded.status,
        imported_user_id = excluded.imported_user_id, error = excluded.error, updated_at = excluded.updated_at`;
  });

// ---- batches ----------------------------------------------------------------

interface Tally {
  seen: number;
  alreadyImported: number;
  emailConflicts: number;
  imported: number;
  toImport: number;
  accounts: number;
  unmapped: Map<string, number>;
  unmappable: Array<{ sourceRowId: string; reason: string }>;
  failures: Array<Failure>;
}

const newTally = (): Tally => ({
  seen: 0,
  alreadyImported: 0,
  emailConflicts: 0,
  imported: 0,
  toImport: 0,
  accounts: 0,
  unmapped: new Map(),
  unmappable: [],
  failures: [],
});

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : "Defect";

type Outcome =
  | { readonly _tag: "mapped"; readonly id: string; readonly mapped: Sources.MappedInput }
  | { readonly _tag: "unmappable"; readonly id: string; readonly reason: string };

const classify = (row: Sources.SourceRow): Effect.Effect<Outcome> =>
  row.map.pipe(
    Effect.map((mapped): Outcome => ({ _tag: "mapped", id: row.id, mapped })),
    Effect.catchTag("Unmappable", (error) =>
      Effect.succeed<Outcome>({ _tag: "unmappable", id: row.id, reason: error.reason }),
    ),
  );

/** One batch. Returns whether the run may continue (false only after a failed batch without `--continue-on-error`). */
const processBatch = (
  tally: Tally,
  env: {
    readonly users: Users.UsersShape;
    readonly accounts: Accounts.AccountsShape;
    readonly sqlTransaction: SqlTransaction.SqlTransactionShape;
    readonly source: string;
    readonly runId: string;
    readonly write: boolean;
    readonly done: ReadonlySet<string>;
    readonly continueOnError: boolean;
  },
  batch: ReadonlyArray<Sources.SourceRow>,
) =>
  Effect.gen(function* () {
    const outcomes = yield* Effect.forEach(batch, classify);
    const candidates: Array<{ readonly id: string; readonly mapped: Sources.MappedInput }> = [];
    const conflicts: Array<{ readonly id: string }> = [];
    const unmappable: Array<{ readonly id: string; readonly reason: string }> = [];
    for (const outcome of outcomes) {
      tally.seen += 1;
      if (outcome._tag === "unmappable") {
        tally.unmappable.push({ sourceRowId: outcome.id, reason: outcome.reason });
        unmappable.push(outcome);
        continue;
      }
      if (env.done.has(outcome.id)) {
        tally.alreadyImported += 1;
        continue;
      }
      for (const field of outcome.mapped.unmapped) {
        tally.unmapped.set(field, (tally.unmapped.get(field) ?? 0) + 1);
      }
      const existing =
        outcome.mapped.user.identity._tag === "Email"
          ? yield* env.users.findByEmail(outcome.mapped.user.identity.email)
          : Option.none<Users.UserRecord>();
      if (Option.isSome(existing)) {
        tally.emailConflicts += 1;
        conflicts.push({ id: outcome.id });
        continue;
      }
      candidates.push({ id: outcome.id, mapped: outcome.mapped });
    }
    tally.toImport += candidates.length;
    tally.accounts += candidates.reduce((n, c) => n + (c.mapped.user.credentials?.length ?? 0), 0);
    if (!env.write) return true;

    const sql = yield* SqlClient.SqlClient;
    // The whole batch — its users, their accounts and their ledger rows — is one transaction.
    const exit = yield* Effect.exit(
      sql.withTransaction(
        Effect.gen(function* () {
          for (const candidate of candidates) {
            // `importUser` is itself atomic and idempotent (`createOrGet`, credentials linked only if
            // absent); the batch transaction around it is what makes the ledger rows part of the batch.
            const written = yield* UserImport.importUser(candidate.mapped.user).pipe(
              Effect.provideService(Users.Users, env.users),
              Effect.provideService(Accounts.Accounts, env.accounts),
              Effect.provideService(SqlTransaction.SqlTransaction, env.sqlTransaction),
            );
            yield* record({
              source: env.source,
              sourceRowId: candidate.id,
              runId: env.runId,
              status: "done",
              userId: written.user.id,
              error: null,
            });
          }
          for (const conflict of conflicts) {
            yield* record({
              source: env.source,
              sourceRowId: conflict.id,
              runId: env.runId,
              status: "skipped",
              userId: null,
              error: "email already exists in the target",
            });
          }
          for (const row of unmappable) {
            yield* record({
              source: env.source,
              sourceRowId: row.id,
              runId: env.runId,
              status: "unmappable",
              userId: null,
              error: row.reason,
            });
          }
        }),
      ),
    );
    if (Exit.isSuccess(exit)) {
      tally.imported += candidates.length;
      return true;
    }
    const error = Exit.findErrorOption(exit);
    tally.failures.push({
      sourceRowIds: candidates.map((candidate) => candidate.id),
      error: error._tag === "Some" ? tagOf(error.value) : "Defect",
    });
    return env.continueOnError;
  });

// ---- the command ------------------------------------------------------------

const summarize = (
  options: ImportOptions,
  write: boolean,
  runId: string | undefined,
  tables: Readonly<Record<string, Sources.TableCount>>,
  tally: Tally,
): Summary => ({
  source: options.from,
  mode: write ? "import" : "plan",
  runId,
  tables,
  users: {
    seen: tally.seen,
    toImport: write ? tally.imported : tally.toImport,
    alreadyImported: tally.alreadyImported,
    emailConflicts: tally.emailConflicts,
    unmappable: tally.unmappable.length,
    failed: tally.failures.reduce((n, failure) => n + failure.sourceRowIds.length, 0),
  },
  accounts: tally.accounts,
  unmapped: Object.fromEntries(Array.from(tally.unmapped).sort(([a], [b]) => a.localeCompare(b))),
  unmappableRows: tally.unmappable,
  failures: tally.failures,
});

export const renderSummary = (summary: Summary) => [
  summary.mode === "plan"
    ? `import plan for ${summary.source} (nothing written; re-run with --yes to import)`
    : `import run ${summary.runId ?? ""} for ${summary.source}`,
  ...Object.entries(summary.tables).map(
    ([table, count]) =>
      `  table ${table}: ${count.rows} row(s)${count.imported ? "" : ` — not imported: ${count.note ?? ""}`}`,
  ),
  `  users: ${summary.users.seen} read, ${summary.users.toImport} ${summary.mode === "plan" ? "to import" : "imported"}, ` +
    `${summary.users.alreadyImported} already imported, ${summary.users.emailConflicts} email conflict(s), ` +
    `${summary.users.unmappable} unmappable, ${summary.users.failed} failed`,
  `  accounts: ${summary.accounts}`,
  ...(Object.keys(summary.unmapped).length === 0
    ? []
    : [
        "  unmapped fields (data with no awthaq destination):",
        ...Object.entries(summary.unmapped).map(([field, rows]) => `    ${field} (${rows} row(s))`),
      ]),
  ...summary.unmappableRows.map((row) => `  unmappable ${row.sourceRowId}: ${row.reason}`),
  ...summary.failures.map(
    (failure) => `  FAILED batch (${failure.error}): ${failure.sourceRowIds.join(", ")}`,
  ),
];

/** BEH-EA-207: plan by default; `--yes` writes in checkpointed, transactional batches. */
export const importUsers = (config: CliConfig, options: ImportOptions) =>
  Effect.gen(function* () {
    const adapter = Sources.adapters.get(options.from);
    if (adapter === undefined) {
      return yield* new UsageError({
        message: `unknown --from ${options.from}; supported: ${Sources.sourceNames.join(", ")}`,
      });
    }
    const write = options.yes && !options.dryRun;
    const summary = yield* Effect.scoped(
      Effect.gen(function* () {
        const open = yield* adapter.open(options.source);
        const tables = yield* open.tables;
        return yield* withApplication(config, (context) =>
          Effect.gen(function* () {
            const users = yield* requireService(context, Users.Users, "Users", "import");
            const accounts = yield* requireService(context, Accounts.Accounts, "Accounts", "import");
            const sqlTransaction = yield* requireService(
              context,
              SqlTransaction.SqlTransaction,
              "SqlTransaction",
              "import",
            );
            const sql = yield* requireService(context, SqlClient.SqlClient, "SqlClient", "import");
            const events = write
              ? yield* requireService(context, AuthEvents.AuthEvents, "AuthEvents", "import")
              : undefined;
            const runId = write ? globalThis.crypto.randomUUID() : undefined;
            const run = Effect.gen(function* () {
              if (write) yield* ensureLedger;
              const done = yield* doneIds(options.from);
              const tally = newTally();
              const env = {
                users,
                accounts,
                sqlTransaction,
                source: options.from,
                runId: runId ?? "",
                write,
                done,
                continueOnError: options.continueOnError,
              };
              yield* open.rows.pipe(
                Stream.grouped(Math.max(1, options.source.batchSize)),
                Stream.runForEachWhile((batch) => processBatch(tally, env, batch)),
                Effect.mapError(
                  () => new ImportFailed({ runId: runId ?? "", message: "the import source stopped answering mid-run" }),
                ),
              );
              return tally;
            });
            const tally = yield* run.pipe(Effect.provideService(SqlClient.SqlClient, sql));
            const result = summarize(options, write, runId, tables, tally);
            if (events !== undefined && runId !== undefined) {
              const counts = {
                source: options.from,
                runId,
                imported: tally.imported,
                skipped: tally.alreadyImported + tally.emailConflicts,
                failed: result.users.failed,
                unmapped: tally.unmapped.size + tally.unmappable.length,
              };
              yield* events.publish(
                result.users.failed === 0
                  ? { _tag: "auth.import.completed", ...counts }
                  : { _tag: "auth.import.failed", ...counts },
              );
            }
            return result;
          }),
        );
      }),
    );

    yield* Output.report(summary, renderSummary);
    if (options.report !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .writeFileString(options.report, `${JSON.stringify(summary, null, 2)}\n`)
        .pipe(Effect.mapError(() => new UsageError({ message: `could not write the report to ${options.report}` })));
    }
    if (summary.users.failed > 0) {
      return yield* new ImportFailed({
        runId: summary.runId ?? "",
        message: `${summary.failures.length} batch(es) failed and were rolled back; re-run to resume from the checkpoint`,
      });
    }
    return summary;
  });
