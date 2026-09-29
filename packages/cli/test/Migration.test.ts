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
import * as SqlClient from "effect/unstable/sql/SqlClient";
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

  it.effect(
    "reports drift (exit 7) when a ledger holds an applied id the linker does not know",
    () =>
      Effect.gen(function* () {
        yield* run(Migration.apply(passwordAndRoles, yes));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO awthaq_plugin_migrations (migration_id, name) VALUES (99, '0099_gone_plugin_migration')`;
        const { exit, stdout } = yield* run(Migration.status(passwordAndRoles));
        assert.strictEqual(failureCode(exit), 7);
        assert.isTrue(stdout.some((line) => line.includes("DRIFT")));
      }).pipe(Effect.provide(Sql)),
  );

  it.effect(
    "reports drift when a same-id row carries a different name (the plugin set changed under the ledger)",
    () =>
      Effect.gen(function* () {
        yield* run(Migration.apply(passwordAndRoles, yes));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE awthaq_plugin_migrations SET name = '0001_other_plugin_create_x' WHERE migration_id = 1`;
        const { exit } = yield* run(Migration.status(passwordAndRoles));
        assert.strictEqual(failureCode(exit), 7);
      }).pipe(Effect.provide(Sql)),
  );

  it.effect("reports drift when a pending id sorts before an applied one", () =>
    Effect.gen(function* () {
      yield* run(Migration.apply(passwordAndRoles, yes));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM awthaq_plugin_migrations WHERE migration_id = 1`;
      const { exit, stdout } = yield* run(Migration.status(passwordAndRoles));
      assert.strictEqual(failureCode(exit), 7);
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
});
