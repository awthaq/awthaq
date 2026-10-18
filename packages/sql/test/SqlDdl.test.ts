// Plan 22 section 3.1 (ADR-EA-004 rev 1.3): the fragments build the columns they name on the running
// dialect, `index` is always IF NOT EXISTS (SSMS-006), and `only` runs the branch of the current dialect.
// Runs on SQLite, and on Postgres under `pnpm test:pg` (the same file, `TestSql.layer` picks the database).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlDdl from "../src/SqlDdl.ts";
import * as TestSql from "../../test/src/TestSql.ts";

const SqlLive = TestSql.layer("sql_SqlDdl");
const ddlOf = Effect.flatMap(SqlClient.SqlClient, SqlDdl.make);

describe("SqlDdl", () => {
  it.effect("the type fragments build the declared logical column types", () =>
    Effect.gen(function* () {
      const ddl = yield* ddlOf;
      const { sql, timestamp, boolean, int64, nowTimestamp } = ddl;
      yield* sql`CREATE TABLE ddl_types (
        id ${ddl.autoIncrementKey},
        at ${timestamp} NOT NULL,
        made ${timestamp} NOT NULL DEFAULT ${nowTimestamp},
        flag ${boolean} NOT NULL DEFAULT ${ddl.false},
        yes ${boolean} NOT NULL DEFAULT ${ddl.true},
        wide ${int64} NOT NULL
      )`;
      const shape = yield* TestSql.schemaOf;
      const columns = shape.tables["ddl_types"]?.map((c) => [c.name, c.type]);
      assert.deepStrictEqual(columns, [
        ["id", "integer"],
        ["at", ddl.dialect === "pg" ? "timestamp" : "text"],
        ["made", ddl.dialect === "pg" ? "timestamp" : "text"],
        ["flag", ddl.dialect === "pg" ? "boolean" : "integer"],
        ["yes", ddl.dialect === "pg" ? "boolean" : "integer"],
        ["wide", "integer"],
      ]);
      yield* sql`INSERT INTO ddl_types (at, wide) VALUES (${ddl.dialect === "pg" ? "2026-01-01T00:00:00Z" : "2026-01-01T00:00:00.000Z"}, 4294967295)`;
      const rows = yield* sql<{ readonly id: number | bigint }>`SELECT id FROM ddl_types`;
      assert.strictEqual(Number(rows[0]?.id), 1);
    }).pipe(Effect.provide(SqlLive)),
  );

  it.effect("index renders IF NOT EXISTS: plain, unique, expression and partial", () =>
    Effect.gen(function* () {
      const ddl = yield* ddlOf;
      const { sql, index } = ddl;
      yield* sql`CREATE TABLE ddl_ix ("userId" TEXT NOT NULL, "rotatedAt" TEXT, note TEXT)`;
      yield* index("ddl_ix_user", "ddl_ix", ["userId", "note"]);
      yield* index("ddl_ix_note", "ddl_ix", ["note"], {
        unique: true,
        where: sql`note IS NOT NULL`,
      });
      yield* index("ddl_ix_active", "ddl_ix", [sql`("rotatedAt" IS NULL)`], {
        unique: true,
        where: sql`"rotatedAt" IS NULL`,
      });
      // SSMS-006: an operator-built index of the same name makes the migration a no-op, not an error.
      yield* index("ddl_ix_user", "ddl_ix", ["userId", "note"]);
      const shape = yield* TestSql.schemaOf;
      assert.deepStrictEqual(
        shape.indexes.map((i) => [i.name, i.columns, i.unique, i.partial]),
        [
          ["ddl_ix_active", ["<expr>"], true, true],
          ["ddl_ix_note", ["note"], true, true],
          ["ddl_ix_user", ["userId", "note"], false, false],
        ],
      );
    }).pipe(Effect.provide(SqlLive)),
  );

  it.effect(
    "only runs the branch of the current dialect and nothing on a dialect without one",
    () =>
      Effect.gen(function* () {
        const ddl = yield* ddlOf;
        const ran: Array<string> = [];
        yield* ddl.only({
          pg: () => Effect.sync(() => ran.push("pg")),
          sqlite: () => Effect.sync(() => ran.push("sqlite")),
        });
        yield* ddl.only(
          ddl.dialect === "pg"
            ? { sqlite: () => Effect.sync(() => ran.push("skipped")) }
            : { pg: () => Effect.sync(() => ran.push("skipped")) },
        );
        assert.deepStrictEqual(ran, [ddl.dialect]);
      }).pipe(Effect.provide(SqlLive)),
  );
});
