// Shipping-gap map (.scratch/shipping-gaps), ticket 15: `Migrations.run`
// actually executes a plugin-declared `Migrations` list through the real
// framework `Migrator`, in order, exactly once each.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CoreMigrations } from "@awthaq/sql";
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
