// KEY-03: the keyset seek (`KeysetSql`) agrees with the memory window (`Keyset.window`) over a probe
// table, on in-memory SQLite locally and on Postgres in CI (both through `TestSql`).
import { Keyset } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeysetSql from "../src/KeysetSql.ts";
import * as TestSql from "../../test/src/TestSql.ts";

interface Probe {
  readonly at: number;
  readonly id: string;
}

// Canonical lowercase uuid-shaped ids order identically by code unit and under a glibc collation.
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Ties on `at`, inserted out of order.
const rows: ReadonlyArray<Probe> = [3, 1, 3, 2, 1, 3, 2, 1, 3].map((at, index) => ({
  at,
  id: uuid(9 - index),
}));

const declare = (direction: Keyset.Direction): Keyset.Declaration<Probe, Probe> => ({
  keys: [
    Keyset.key({
      column: "at",
      direction,
      order: Order.Number,
      row: (row) => row.at,
      cursor: (cursor) => cursor.at,
    }),
    Keyset.key({
      column: "id",
      direction,
      order: Order.String,
      row: (row) => row.id,
      cursor: (cursor) => cursor.id,
    }),
  ],
  cursorOf: (row) => row,
});

const createProbe = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE keyset_probe ("at" BIGINT NOT NULL, id TEXT NOT NULL)`;
    for (const row of rows) {
      yield* sql`INSERT INTO keyset_probe ("at", id) VALUES (${row.at}, ${row.id})`;
    }
  });

/** Every cursor position (none, then each row) at every take 1..10: the SQL page equals the window. */
const agrees = (suite: string, direction: Keyset.Direction) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createProbe(sql);
    const declaration = declare(direction);
    const seek = KeysetSql.make(declaration);
    const positions: ReadonlyArray<Option.Option<Probe>> = [
      Option.none(),
      ...rows.map(Option.some),
    ];
    for (const after of positions) {
      for (let take = 1; take <= 10; take++) {
        const viaSql = yield* sql<{ readonly id: string }>`
          SELECT * FROM keyset_probe
          WHERE ${sql.and(Option.match(after, { onNone: () => [], onSome: (c) => [seek.after(sql, [c.at, c.id])] }))}
          ORDER BY ${seek.orderBy(sql)} LIMIT ${take}`;
        assert.deepStrictEqual(
          viaSql.map((row) => row.id),
          Keyset.window(declaration, rows, { after, take }).map((row) => row.id),
          `${suite}: after ${Option.match(after, { onNone: () => "none", onSome: (c) => c.id })}, take ${take}`,
        );
      }
    }
  }).pipe(Effect.provide(TestSql.layer(suite)));

describe("KeysetSql", () => {
  it.effect("an ascending seek returns the rows the memory window returns", () =>
    agrees("keyset_sql_asc", "asc"),
  );
});
