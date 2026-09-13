// Shipping-gap map (.scratch/shipping-gaps), ticket 15: `Migrations.run`
// actually executes a plugin-declared `Migrations` list through the real
// framework `Migrator`, in order, exactly once each.
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql";
import { Migrations } from "../src/index.ts";

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
      const rows = yield* sql`SELECT * FROM effect_sql_migrations`;
      assert.strictEqual(rows.length, 0);
    }).pipe(Effect.provide(SqlLive)),
  );
});
