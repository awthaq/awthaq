// Plan 22 section 3.5: `TestSql.schemaOf` reads the structure a migration built (columns, plain, partial and
// expression indexes, triggers), minus the two ledgers, and `parityDifferences` compares two dialects' shapes.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSql from "../src/TestSql.ts";

const SqlLive = TestSql.layer("test_TestSqlSchema");

it.effect("schemaOf reads columns, indexes (partial, expression, unique) and triggers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE shape_probe (id TEXT PRIMARY KEY, "createdAt" TEXT NOT NULL, note TEXT, n INTEGER NOT NULL DEFAULT 0)`;
    yield* sql`CREATE INDEX shape_probe_created ON shape_probe ("createdAt")`;
    yield* sql`CREATE UNIQUE INDEX shape_probe_note ON shape_probe (note) WHERE note IS NOT NULL`;
    yield* sql`CREATE INDEX shape_probe_expr ON shape_probe ((n IS NULL))`;
    yield* sql.onDialectOrElse({
      pg: () =>
        Effect.gen(function* () {
          yield* sql.unsafe(
            `CREATE FUNCTION shape_probe_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
          );
          yield* sql.unsafe(
            `CREATE TRIGGER shape_probe_trg BEFORE UPDATE ON shape_probe FOR EACH ROW EXECUTE FUNCTION shape_probe_guard()`,
          );
        }),
      orElse: () =>
        sql.unsafe(
          `CREATE TRIGGER shape_probe_trg BEFORE UPDATE ON shape_probe BEGIN SELECT 1; END`,
        ),
    });

    const shape = yield* TestSql.schemaOf;
    assert.deepStrictEqual(Object.keys(shape.tables), ["shape_probe"]);
    assert.deepStrictEqual(
      shape.tables["shape_probe"]?.map((c) => [
        c.name,
        c.type,
        c.notNull,
        c.hasDefault,
        c.primaryKey,
      ]),
      [
        ["id", "text", true, false, true],
        ["createdAt", "text", true, false, false],
        ["note", "text", false, false, false],
        ["n", "integer", true, true, false],
      ],
    );
    assert.deepStrictEqual(
      shape.indexes.map((i) => [i.name, i.columns, i.unique, i.partial]),
      [
        ["shape_probe_created", ["createdAt"], false, false],
        ["shape_probe_expr", ["<expr>"], false, false],
        ["shape_probe_note", ["note"], true, true],
      ],
    );
    assert.deepStrictEqual(shape.triggers, [{ name: "shape_probe_trg", table: "shape_probe" }]);
  }).pipe(Effect.provide(SqlLive)),
);

it("parityDifferences matches timestamp to text and boolean to integer and names the first mismatch", () => {
  const column = (name: string, type: TestSql.LogicalType) => ({
    name,
    type,
    notNull: true,
    hasDefault: false,
    primaryKey: false,
  });
  const pg = {
    tables: { t: [column("a", "timestamp"), column("b", "boolean"), column("c", "integer")] },
    indexes: [],
    triggers: [],
  };
  const same = {
    tables: { t: [column("a", "text"), column("b", "integer"), column("c", "integer")] },
    indexes: [],
    triggers: [],
  };
  assert.deepStrictEqual(TestSql.parityDifferences(pg, same), []);
  const drifted = {
    tables: { t: [column("a", "text"), column("b", "integer"), column("c", "text")] },
    indexes: [],
    triggers: [],
  };
  assert.deepStrictEqual(TestSql.parityDifferences(pg, drifted), [
    "t.c: type integer (Postgres) vs text (SQLite)",
  ]);
});
