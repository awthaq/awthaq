// BEH-EA-204 (ECS-009, MW-006): `migration status|apply` over both ledgers, against a real
// in-memory SQLite database and a real `Auth.make` composition — core's ledger
// (`effect_sql_migrations`) and the plugin ledger (`awthaq_plugin_migrations`) are two id spaces
// and neither may hide the other.
import { CoreMigrations } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Runtime from "effect/Runtime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migration from "../src/Migration.ts";
import * as Output from "../src/Output.ts";
import { passwordAndRoles } from "./support/TestApp.ts";

const Sql = SqliteClient.layer({ filename: ":memory:" });

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Output.Output>,
  json = false,
) =>
  Effect.gen(function* () {
    const { captured, layer } = yield* Output.capture(json);
    const exit = yield* Effect.exit(effect.pipe(Effect.provide(layer)));
    return {
      exit,
      stdout: yield* Ref.get(captured.stdout),
      stderr: yield* Ref.get(captured.stderr),
      documents: yield* Ref.get(captured.documents),
    };
  });

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  return tables.map((table) => table.name);
});

const ledgerRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly migration_id: number;
    }>`SELECT migration_id FROM ${sql(table)} ORDER BY migration_id`;
    return rows.map((row) => row.migration_id);
  });

const yes = { yes: true, dryRun: false, allowEmpty: false };

/** However many core migrations exist today (other programs add them), and the two the Roles plugin adds. */
const coreCount = CoreMigrations.coreMigrations.pipe(Effect.map((all) => all.length));
const PLUGIN_COUNT = 2;

/** The plan `migration apply` reports on an empty database: every core migration, then the two plugin ones. */
const freshPlan = Effect.gen(function* () {
  const core = yield* CoreMigrations.coreMigrations;
  return [
    ...core.map(([id, name]) => ({ ledger: "core", id, name })),
    { ledger: "plugins", id: 1, name: "0001_roles_create_roles_assignments" },
    { ledger: "plugins", id: 2, name: "0002_roles_create_roles_assignments_user_id_index" },
  ];
});

/** Applies everything, then adds a ledger row the linker never produced, so the next run sees drift. */
const driftedLedger = Effect.gen(function* () {
  yield* run(Migration.apply(passwordAndRoles, yes));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (500, 'unknown_core')`;
});

/** Makes core migration 1 (`CREATE TABLE users`) fail mid-write, after the plan was read and printed. */
const blockedWrite = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE users (id TEXT)`;
});

const failureCode = <A, E>(exit: Exit.Exit<A, E>) => {
  if (!Exit.isFailure(exit)) return -1;
  const error = Exit.findErrorOption(exit);
  return error._tag === "Some" ? Runtime.getErrorExitCode(error.value) : -1;
};

describe("Migration.status", () => {
  it.effect(
    "on an empty database lists core then plugin migrations as pending, creating no ledger",
    () =>
      Effect.gen(function* () {
        const { exit, stdout } = yield* run(Migration.status(passwordAndRoles));
        assert.isTrue(Exit.isSuccess(exit));
        const core = yield* coreCount;
        assert.strictEqual(stdout[0], `core (effect_sql_migrations): 0 applied, ${core} pending`);
        assert.isTrue(
          stdout.some((line) =>
            /plugins \(awthaq_plugin_migrations\): 0 applied, 2 pending/.test(line),
          ),
        );
        assert.deepStrictEqual(yield* tableNames, []);
      }).pipe(Effect.provide(Sql)),
  );

  // The detection itself (unknown id, renamed id, pending before applied) is core's `Migrations.status`
  // (`packages/core/test/Migrations.test.ts`); here, how the command reports it.
  it.effect("a drifted ledger exits 7 and prints DRIFT", () =>
    Effect.gen(function* () {
      yield* run(Migration.apply(passwordAndRoles, yes));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM awthaq_plugin_migrations WHERE migration_id = 1`;
      const { exit, stdout } = yield* run(Migration.status(passwordAndRoles));
      assert.strictEqual(failureCode(exit), 7);
      assert.isTrue(stdout.some((line) => line.includes("DRIFT")));
      assert.isTrue(stdout.some((line) => line.includes("would be skipped")));
    }).pipe(Effect.provide(Sql)),
  );
});

describe("Migration.apply", () => {
  it.effect("without --yes exits 6 and applies nothing", () =>
    Effect.gen(function* () {
      const { exit, stdout } = yield* run(
        Migration.apply(passwordAndRoles, { yes: false, dryRun: false, allowEmpty: false }),
      );
      assert.strictEqual(failureCode(exit), 6);
      assert.isTrue(stdout.some((line) => line.includes("pending")));
      assert.deepStrictEqual(yield* tableNames, []);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("--dry-run prints the ordered plan and applies nothing", () =>
    Effect.gen(function* () {
      const { exit, stdout } = yield* run(
        Migration.apply(passwordAndRoles, { yes: false, dryRun: true, allowEmpty: false }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(
        stdout.filter((line) => line.includes("pending  ")).length,
        (yield* coreCount) + PLUGIN_COUNT,
      );
      assert.deepStrictEqual(yield* tableNames, []);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("--yes applies core first, then plugins, each into its own ledger", () =>
    Effect.gen(function* () {
      const { exit } = yield* run(Migration.apply(passwordAndRoles, yes));
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual((yield* ledgerRows("effect_sql_migrations")).length, yield* coreCount);
      assert.deepStrictEqual(yield* ledgerRows("awthaq_plugin_migrations"), [1, 2]);
      const after = yield* run(Migration.status(passwordAndRoles));
      assert.isTrue(Exit.isSuccess(after.exit));
      assert.isTrue(after.stdout[0]?.includes(`${yield* coreCount} applied, 0 pending`) ?? false);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("with nothing pending exits 4, or succeeds with --allow-empty", () =>
    Effect.gen(function* () {
      yield* run(Migration.apply(passwordAndRoles, yes));
      const again = yield* run(Migration.apply(passwordAndRoles, yes));
      assert.strictEqual(failureCode(again.exit), 4);
      const allowed = yield* run(Migration.apply(passwordAndRoles, { ...yes, allowEmpty: true }));
      assert.isTrue(Exit.isSuccess(allowed.exit));
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("refuses to run on a drifted ledger even with --yes", () =>
    Effect.gen(function* () {
      yield* run(Migration.apply(passwordAndRoles, yes));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (500, 'unknown_core')`;
      const { exit } = yield* run(Migration.apply(passwordAndRoles, yes));
      assert.strictEqual(failureCode(exit), 7);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("--json emits one document with the plan and whether it was applied", () =>
    Effect.gen(function* () {
      const { captured, layer } = yield* Output.capture(true);
      yield* Migration.apply(passwordAndRoles, yes).pipe(Effect.provide(layer));
      const docs = yield* Ref.get(captured.documents);
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(Object.keys(docs[0] ?? {}), ["pending", "drift", "applied"]);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("text: --yes ends with `applied N migration(s)` and prints it once", () =>
    Effect.gen(function* () {
      const { exit, stdout, stderr } = yield* run(Migration.apply(passwordAndRoles, yes));
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(
        stdout.at(-1),
        `applied ${(yield* coreCount) + PLUGIN_COUNT} migration(s)`,
      );
      assert.deepStrictEqual(
        stdout.slice(0, -1).filter((line) => line.startsWith("applied ")),
        [],
      );
      assert.deepStrictEqual(stderr, []);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("text: --dry-run never prints an `applied N migration(s)` line", () =>
    Effect.gen(function* () {
      const { exit, stdout, stderr } = yield* run(
        Migration.apply(passwordAndRoles, { yes: false, dryRun: true, allowEmpty: false }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(
        stdout.filter((line) => line.startsWith("applied ")),
        [],
      );
      assert.deepStrictEqual(stderr, []);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("--json: --yes prints exactly one stdout entry, the document, with applied true", () =>
    Effect.gen(function* () {
      const { captured, layer } = yield* Output.capture(true);
      yield* Migration.apply(passwordAndRoles, yes).pipe(Effect.provide(layer));
      const stdout = yield* Ref.get(captured.stdout);
      const docs = yield* Ref.get(captured.documents);
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(stdout.length, 1);
      assert.strictEqual(stdout[0], JSON.stringify(docs[0], null, 2));
      assert.deepStrictEqual(docs[0], {
        pending: yield* freshPlan,
        drift: false,
        applied: true,
      });
      assert.deepStrictEqual(yield* Ref.get(captured.stderr), []);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect(
    "--json: --dry-run prints exactly one stdout entry, the document, with applied false",
    () =>
      Effect.gen(function* () {
        const { captured, layer } = yield* Output.capture(true);
        yield* Migration.apply(passwordAndRoles, {
          yes: false,
          dryRun: true,
          allowEmpty: false,
        }).pipe(Effect.provide(layer));
        const stdout = yield* Ref.get(captured.stdout);
        const docs = yield* Ref.get(captured.documents);
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(stdout.length, 1);
        assert.strictEqual(stdout[0], JSON.stringify(docs[0], null, 2));
        assert.deepStrictEqual(docs[0], {
          pending: yield* freshPlan,
          drift: false,
          applied: false,
        });
        assert.deepStrictEqual(yield* Ref.get(captured.stderr), []);
      }).pipe(Effect.provide(Sql)),
  );

  // The refusal and failure paths: `finish(true)` must run only after the write succeeded, and a
  // refused or failed run reports `applied: false` (one document) or no `applied N` line at all.
  it.effect("--json on a drifted ledger: one document, applied false, then LedgerDrift (7)", () =>
    Effect.gen(function* () {
      yield* driftedLedger;
      const { exit, stdout, documents } = yield* run(Migration.apply(passwordAndRoles, yes), true);
      assert.strictEqual(failureCode(exit), 7);
      assert.deepStrictEqual(documents, [{ pending: [], drift: true, applied: false }]);
      assert.deepStrictEqual(stdout, [JSON.stringify(documents[0], null, 2)]);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("text on a drifted ledger: LedgerDrift (7) and no `applied N migration(s)` line", () =>
    Effect.gen(function* () {
      yield* driftedLedger;
      const { exit, stdout } = yield* run(Migration.apply(passwordAndRoles, yes));
      assert.strictEqual(failureCode(exit), 7);
      assert.isTrue(stdout.some((line) => line.includes("DRIFT")));
      assert.deepStrictEqual(
        stdout.filter((line) => line.startsWith("applied ")),
        [],
      );
    }).pipe(Effect.provide(Sql)),
  );

  it.effect(
    "--json without --yes: one document, applied false, then ConfirmationRequired (6)",
    () =>
      Effect.gen(function* () {
        const { exit, stdout, documents } = yield* run(
          Migration.apply(passwordAndRoles, { yes: false, dryRun: false, allowEmpty: false }),
          true,
        );
        assert.strictEqual(failureCode(exit), 6);
        assert.deepStrictEqual(documents, [
          { pending: yield* freshPlan, drift: false, applied: false },
        ]);
        assert.deepStrictEqual(stdout, [JSON.stringify(documents[0], null, 2)]);
        assert.deepStrictEqual(yield* tableNames, []);
      }).pipe(Effect.provide(Sql)),
  );

  it.effect(
    "text without --yes: ConfirmationRequired (6) and no `applied N migration(s)` line",
    () =>
      Effect.gen(function* () {
        const { exit, stdout } = yield* run(
          Migration.apply(passwordAndRoles, { yes: false, dryRun: false, allowEmpty: false }),
        );
        assert.strictEqual(failureCode(exit), 6);
        assert.deepStrictEqual(
          stdout.filter((line) => line.startsWith("applied ")),
          [],
        );
        assert.deepStrictEqual(yield* tableNames, []);
      }).pipe(Effect.provide(Sql)),
  );

  it.effect("--json when the write fails mid-run: no document at all", () =>
    Effect.gen(function* () {
      yield* blockedWrite;
      const { exit, stdout, documents } = yield* run(Migration.apply(passwordAndRoles, yes), true);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(documents, []);
      assert.deepStrictEqual(stdout, []);
    }).pipe(Effect.provide(Sql)),
  );

  it.effect("text when the write fails mid-run: no `applied N migration(s)` line", () =>
    Effect.gen(function* () {
      yield* blockedWrite;
      const { exit, stdout } = yield* run(Migration.apply(passwordAndRoles, yes));
      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(stdout.some((line) => line.includes("pending  ")));
      assert.deepStrictEqual(
        stdout.filter((line) => line.startsWith("applied ")),
        [],
      );
    }).pipe(Effect.provide(Sql)),
  );
});
