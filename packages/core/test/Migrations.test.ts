// Shipping-gap map (.scratch/shipping-gaps), ticket 15: `Migrations.run`
// actually executes a plugin-declared `Migrations` list through the real
// framework `Migrator`, in order, exactly once each.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { CoreMigrations } from "@awthaq/sql";
import * as TestSql from "../../test/src/TestSql.ts";
import * as Migrations from "../src/Migrations.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

describe("Migrations.run", () => {
  it.effect("runs every migration's `up` effect, in order, exactly once", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const migrations: Migrations.Migrations = [
        { name: "first", up: Effect.sync(() => seen.push("first")) },
        { name: "second", up: Effect.sync(() => seen.push("second")) },
      ];
      const resultA = yield* Migrations.run(migrations);
      assert.strictEqual(resultA.length, 2);
      assert.deepStrictEqual(seen, ["first", "second"]);

      // A second run against the same database applies nothing new — the
      // migrator's own tracking table already has both by name.
      const resultB = yield* Migrations.run(migrations);
      assert.strictEqual(resultB.length, 0);
      assert.deepStrictEqual(seen, ["first", "second"]);
    }).pipe(Effect.provide(SqlLive)),
  );

  it.effect("an empty list is a no-op", () =>
    Effect.gen(function* () {
      const result = yield* Migrations.run([]);
      assert.strictEqual(result.length, 0);
      // Confirms the tracking table itself was still created.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT * FROM awthaq_plugin_migrations`;
      assert.strictEqual(rows.length, 0);
    }).pipe(Effect.provide(SqlLive)),
  );

  // N11: `coreMigrations` and the index-numbered plugin list both
  // number from 1. Sharing one tracking table made the migrator skip every
  // plugin migration whose id was <= the newest core id, silently.
  it.effect("N11: core and plugin migrations apply on one database without skipping", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      const created: Array<string> = [];
      const plugin = (name: string): Migrations.Migration => ({
        name,
        up: sql`CREATE TABLE ${sql(name)} (id TEXT)`.pipe(
          Effect.andThen(Effect.sync(() => created.push(name))),
        ),
      });
      const applied = yield* Migrations.run([plugin("plugin_a"), plugin("plugin_b")]);
      assert.strictEqual(applied.length, 2);
      assert.deepStrictEqual(created, ["plugin_a", "plugin_b"]);
      // The two owners keep separate ledgers.
      const core = yield* sql`SELECT migration_id FROM effect_sql_migrations`;
      const plugins = yield* sql`SELECT migration_id FROM awthaq_plugin_migrations`;
      // Derived, not hard-coded: a new core migration must not touch this test.
      assert.strictEqual(core.length, (yield* CoreMigrations.coreMigrations).length);
      assert.strictEqual(plugins.length, 2);
    }).pipe(Effect.provide(SqlLive)),
  );
});

// BEH-EA-037/038 (plan 22): `group` keys a records module's migrations by their ledger name and resolves the
// dialect once per migration; `ledger` returns them in the order it names.
const accounts = Migrations.group({
  create_t: ({ sql, timestamp }) =>
    sql`CREATE TABLE t (id TEXT PRIMARY KEY, "at" ${timestamp} NOT NULL)`,
  create_t_at_index: ({ index }) => index("t_at", "t", ["at"]),
});
const extras = Migrations.group({
  add_t_note: ({ sql }) => sql`ALTER TABLE t ADD COLUMN note TEXT`,
});

describe("Migrations.group / Migrations.ledger", () => {
  it("group keys each migration by its name", () => {
    assert.deepStrictEqual(Object.keys(accounts), ["create_t", "create_t_at_index"]);
    assert.strictEqual(accounts.create_t.name, "create_t");
  });

  it("ledger returns the migrations in the order it names, across groups", () => {
    const ledger = Migrations.ledger(
      [accounts, extras],
      ["create_t", "add_t_note", "create_t_at_index"],
    );
    assert.deepStrictEqual(
      ledger.map((m) => m.name),
      ["create_t", "add_t_note", "create_t_at_index"],
    );
    assert.strictEqual(ledger[1], extras.add_t_note);
  });

  it.effect(
    "a ledger runs through Migrations.run and builds the schema, idempotent on the second run",
    () =>
      Effect.gen(function* () {
        const ledger = Migrations.ledger(
          [accounts, extras],
          ["create_t", "add_t_note", "create_t_at_index"],
        );
        const first = yield* Migrations.run(ledger);
        assert.strictEqual(first.length, 3);
        assert.strictEqual((yield* Migrations.run(ledger)).length, 0);
        const sql = yield* SqlClient.SqlClient;
        const columns = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM pragma_table_info('t')`;
        assert.deepStrictEqual(
          columns.map((c) => c.name),
          ["id", "at", "note"],
        );
      }).pipe(Effect.provide(SqlLive)),
  );
});

// BEH-EA-204 / BEH-EA-H2 (plan 15): the one runner, shared by `awthaq migration apply` and `AuthHost`.
// SQLite `:memory:` by default; a per-suite Postgres schema under `pnpm test:pg` (`TestSql`).
describe("Migrations.status / apply / verify", () => {
  const Db = TestSql.layer("core_Migrations");
  const coreCount = Effect.map(CoreMigrations.coreMigrations, (all) => all.length);

  const tableOf = (name: string): Migrations.Migration => ({
    name,
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ${sql(name)} (id TEXT)`;
    }),
  });
  const plugins = [tableOf("plugin_a"), tableOf("plugin_b")];

  const ledgerIds = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly migration_id: number;
      }>`SELECT migration_id FROM ${sql(table)} ORDER BY migration_id`;
      return rows.map((row) => Number(row.migration_id));
    });

  const failure = <A, E>(exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();

  it.effect(
    "status: an empty database lists core then plugin migrations as pending and creates no ledger table",
    () =>
      Effect.gen(function* () {
        const status = yield* Migrations.status(plugins);
        assert.deepStrictEqual(
          status.ledgers.map((ledger) => [ledger.ledger, ledger.table, ledger.pending.length]),
          [
            ["core", Migrations.coreMigrationsTable, yield* coreCount],
            ["plugins", Migrations.pluginMigrationsTable, 2],
          ],
        );
        assert.isFalse(status.drift);
        assert.isFalse(yield* Migrations.tableExists(Migrations.coreMigrationsTable));
        assert.isFalse(yield* Migrations.tableExists(Migrations.pluginMigrationsTable));
      }).pipe(Effect.provide(Db)),
  );

  it.effect("status: drift when a ledger holds an id the linker does not produce", () =>
    Effect.gen(function* () {
      yield* Migrations.apply(plugins);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO awthaq_plugin_migrations (migration_id, name) VALUES (99, '0099_gone_plugin_migration')`;
      const status = yield* Migrations.status(plugins);
      assert.isTrue(status.drift);
      assert.deepStrictEqual(
        status.ledgers[1]?.unknown.map((entry) => entry.id),
        [99],
      );
    }).pipe(Effect.provide(Db)),
  );

  it.effect("status: drift when a same-id row carries a different name", () =>
    Effect.gen(function* () {
      yield* Migrations.apply(plugins);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE awthaq_plugin_migrations SET name = '0001_other_plugin_create_x' WHERE migration_id = 1`;
      const status = yield* Migrations.status(plugins);
      assert.isTrue(status.drift);
      assert.deepStrictEqual(
        status.ledgers[1]?.unknown.map((entry) => entry.name),
        ["0001_other_plugin_create_x"],
      );
    }).pipe(Effect.provide(Db)),
  );

  it.effect("status: drift when a pending id sorts before an applied one", () =>
    Effect.gen(function* () {
      yield* Migrations.apply(plugins);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM awthaq_plugin_migrations WHERE migration_id = 1`;
      const status = yield* Migrations.status(plugins);
      assert.isTrue(status.drift);
      assert.deepStrictEqual(
        status.ledgers[1]?.outOfOrder.map((entry) => entry.name),
        ["plugin_a"],
      );
    }).pipe(Effect.provide(Db)),
  );

  it.effect(
    "apply: core first, then plugins, each into its own ledger; a second apply calls no Migrator and applies nothing",
    () =>
      Effect.gen(function* () {
        const before = yield* Migrations.apply(plugins);
        assert.strictEqual(before.ledgers[0]?.pending.length, yield* coreCount);
        assert.strictEqual(
          (yield* ledgerIds(Migrations.coreMigrationsTable)).length,
          yield* coreCount,
        );
        assert.deepStrictEqual(yield* ledgerIds(Migrations.pluginMigrationsTable), [1, 2]);
        // With nothing pending no `Migrator` runs: it would recreate the plugin ledger it always ensures.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE awthaq_plugin_migrations`;
        const again = yield* Migrations.apply([]);
        assert.isTrue(again.ledgers.every((ledger) => ledger.pending.length === 0));
        assert.isFalse(yield* Migrations.tableExists(Migrations.pluginMigrationsTable));
      }).pipe(Effect.provide(Db)),
  );

  it.effect(
    "apply: refuses a plugin inserted before an applied one with Migrations/LedgerDrift and applies nothing",
    () =>
      Effect.gen(function* () {
        yield* Migrations.apply([tableOf("plugin_a"), tableOf("plugin_c")]);
        // The next deploy composes plugin_b between them: `Migrator` alone would skip it silently (id 2 is
        // recorded, as plugin_c).
        const exit = yield* Effect.exit(
          Migrations.apply([tableOf("plugin_a"), tableOf("plugin_b"), tableOf("plugin_c")]),
        );
        const error = failure(exit);
        assert.isTrue(Option.isSome(error) && error.value._tag === "Migrations/LedgerDrift");
        assert.isTrue(
          Option.isSome(error) &&
            error.value.message.includes(
              "plugins ledger holds 0002  plugin_c, unknown to the linker",
            ),
        );
        assert.isFalse(yield* Migrations.tableExists("plugin_b"));
        assert.deepStrictEqual(yield* ledgerIds(Migrations.pluginMigrationsTable), [1, 2]);
      }).pipe(Effect.provide(Db)),
  );

  it.effect(
    'apply: a failing plugin migration is Migrations/MigrationFailed { ledger: "plugins" }, and core\'s batch stays applied',
    () =>
      Effect.gen(function* () {
        const broken: Migrations.Migration = {
          name: "broken",
          up: Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`SELECT * FROM no_such_table_anywhere`;
          }),
        };
        const exit = yield* Effect.exit(Migrations.apply([tableOf("plugin_a"), broken]));
        const error = failure(exit);
        assert.isTrue(
          Option.isSome(error) &&
            error.value._tag === "Migrations/MigrationFailed" &&
            error.value.ledger === "plugins",
        );
        assert.strictEqual(
          (yield* ledgerIds(Migrations.coreMigrationsTable)).length,
          yield* coreCount,
        );
        assert.deepStrictEqual(yield* ledgerIds(Migrations.pluginMigrationsTable), []);
        assert.isFalse(yield* Migrations.tableExists("plugin_a"));
      }).pipe(Effect.provide(Db)),
  );

  it.effect("verify: succeeds on a current schema and applies nothing", () =>
    Effect.gen(function* () {
      yield* Migrations.apply(plugins);
      const current = yield* Migrations.verify(plugins);
      assert.isTrue(current.ledgers.every((ledger) => ledger.pending.length === 0));
      assert.deepStrictEqual(yield* ledgerIds(Migrations.pluginMigrationsTable), [1, 2]);
    }).pipe(Effect.provide(Db)),
  );

  it.effect(
    "verify: refuses with Migrations/Pending naming every pending entry, and creates no ledger table",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Migrations.verify(plugins));
        const error = failure(exit);
        assert.isTrue(Option.isSome(error) && error.value._tag === "Migrations/Pending");
        const message = Option.isSome(error) ? error.value.message : "";
        assert.isTrue(message.startsWith(`${(yield* coreCount) + 2} migration(s) pending: core `));
        assert.isTrue(message.endsWith("plugins plugin_a, plugins plugin_b"));
        assert.isFalse(yield* Migrations.tableExists(Migrations.coreMigrationsTable));
        assert.isFalse(yield* Migrations.tableExists(Migrations.pluginMigrationsTable));
      }).pipe(Effect.provide(Db)),
  );

  it.effect("verify: refuses a drifted ledger with Migrations/LedgerDrift", () =>
    Effect.gen(function* () {
      yield* Migrations.apply(plugins);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (500, 'unknown_core')`;
      const error = failure(yield* Effect.exit(Migrations.verify(plugins)));
      assert.isTrue(Option.isSome(error) && error.value._tag === "Migrations/LedgerDrift");
    }).pipe(Effect.provide(Db)),
  );

  it.effect("apply: two concurrent applies on one database apply each migration once", () =>
    Effect.gen(function* () {
      const runs: Array<string> = [];
      const counted = (name: string): Migrations.Migration => ({
        name,
        up: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE ${sql(name)} (id TEXT)`;
          runs.push(name);
        }),
      });
      const both = [counted("plugin_x"), counted("plugin_y")];
      yield* Effect.all([Migrations.apply(both), Migrations.apply(both)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(runs, ["plugin_x", "plugin_y"]);
      assert.strictEqual(
        (yield* ledgerIds(Migrations.coreMigrationsTable)).length,
        yield* coreCount,
      );
      assert.deepStrictEqual(yield* ledgerIds(Migrations.pluginMigrationsTable), [1, 2]);
    }).pipe(Effect.provide(Db)),
  );
});
