// KEY-03: the keyset seek (`KeysetSql`) agrees with the memory window (`Keyset.window`) over a probe
// table, on in-memory SQLite locally and on Postgres in CI (both through `TestSql`).
import { Defects, Keyset } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeysetSql from "../src/KeysetSql.ts";
import * as TestSql from "../../test/src/TestSql.ts";

type Probe = {
  readonly at: number;
  readonly grp: number;
  readonly id: string;
  readonly tenantId: string;
  readonly endedAt: number | null;
};

// Canonical lowercase uuid-shaped ids order identically by code unit and under a glibc collation.
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Ties on `at` (and on `grp`), inserted out of order; tenant t1 owns the first six, endedAt marks 4 and 8.
const rows: ReadonlyArray<Probe> = [3, 1, 3, 2, 1, 3, 2, 1, 3].map((at, index) => {
  const n = 9 - index;
  return {
    at,
    grp: n % 3,
    id: uuid(n),
    tenantId: n <= 6 ? "t1" : "t2",
    endedAt: n % 4 === 0 ? 5 : null,
  };
});

const numberKey = (column: "at" | "grp", direction: Keyset.Direction) =>
  Keyset.key<Probe, Probe, number>({
    column,
    direction,
    order: Order.Number,
    row: (row) => row[column],
    cursor: (cursor) => cursor[column],
  });

const idKey = (direction: Keyset.Direction) =>
  Keyset.key<Probe, Probe, string>({
    column: "id",
    direction,
    order: Order.String,
    row: (row) => row.id,
    cursor: (cursor) => cursor.id,
  });

const declare = (direction: Keyset.Direction): Keyset.Declaration<Probe, Probe> => ({
  keys: [numberKey("at", direction), idKey(direction)],
  cursorOf: (row) => row,
});

const createProbe = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE keyset_probe ("at" BIGINT NOT NULL, grp BIGINT NOT NULL, id TEXT NOT NULL, "tenantId" TEXT NOT NULL, "endedAt" BIGINT)`;
    for (const row of rows) {
      yield* sql`INSERT INTO keyset_probe ("at", grp, id, "tenantId", "endedAt") VALUES (${row.at}, ${row.grp}, ${row.id}, ${row.tenantId}, ${row.endedAt})`;
    }
  });

/**
 * Every cursor position (none, then each row of `kept`) at every take 1..10: the SQL page, with the
 * seek composed inside `sql.and` next to `extra`, equals the window over the same pre-filtered rows.
 */
const agrees = (
  suite: string,
  declaration: Keyset.Declaration<Probe, Probe>,
  scope: { readonly tenant?: string; readonly activeOnly?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createProbe(sql);
    const seek = KeysetSql.make(declaration);
    const kept = rows.filter(
      (row) =>
        (scope.tenant === undefined || row.tenantId === scope.tenant) &&
        (scope.activeOnly !== true || row.endedAt === null),
    );
    const positions: ReadonlyArray<Option.Option<Probe>> = [
      Option.none(),
      ...kept.map(Option.some),
    ];
    for (const after of positions) {
      for (let take = 1; take <= 10; take++) {
        const conditions = [
          ...(scope.tenant === undefined ? [] : [sql`"tenantId" = ${scope.tenant}`]),
          ...(scope.activeOnly === true ? [sql`"endedAt" IS NULL`] : []),
          ...Option.match(after, {
            onNone: () => [],
            onSome: (cursor) => [seek.after(sql, cursor)],
          }),
        ];
        const viaSql = yield* sql<{ readonly id: string }>`
          SELECT * FROM keyset_probe
          WHERE ${sql.and(conditions)}
          ORDER BY ${seek.orderBy(sql)} LIMIT ${take}`;
        assert.deepStrictEqual(
          viaSql.map((row) => row.id),
          Keyset.window(declaration, kept, { after, take }).map((row) => row.id),
          `${suite}: after ${Option.match(after, { onNone: () => "none", onSome: (c) => c.id })}, take ${take}`,
        );
      }
    }
  }).pipe(Effect.provide(TestSql.layer(suite)));

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("KeysetSql", () => {
  it.effect("an ascending seek returns the rows the memory window returns", () =>
    agrees("keyset_sql_asc", declare("asc")),
  );

  it.effect("a descending seek returns the rows the memory window returns", () =>
    agrees("keyset_sql_desc", declare("desc")),
  );

  it.effect("a three-key seek agrees with the window", () =>
    agrees("keyset_sql_three", {
      keys: [numberKey("at", "asc"), numberKey("grp", "asc"), idKey("asc")],
      cursorOf: (row) => row,
    }),
  );

  it.effect("the seek composes inside sql.and with a tenant predicate and an IS NULL filter", () =>
    Effect.all([
      agrees("keyset_sql_scoped_asc", declare("asc"), { tenant: "t1", activeOnly: true }),
      agrees("keyset_sql_scoped_desc", declare("desc"), {
        tenant: "t1",
        activeOnly: true,
      }),
    ]),
  );

  it.effect("an empty condition list still compiles", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [text] = sql`SELECT 1 WHERE ${sql.and([])}`.compile();
      assert.include(text, "1=1");
    }).pipe(Effect.provide(TestSql.layer("keyset_sql_empty"))),
  );

  it.effect("the compiled seek is one row-value comparison with bound values and no OR", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const placeholder = String.raw`(?:\?|\$\d+)`;
      const cases: ReadonlyArray<readonly [Keyset.Direction, string, string]> = [
        ["asc", ">", "ASC"],
        ["desc", "<", "DESC"],
      ];
      for (const [direction, operator, keyword] of cases) {
        const seek = KeysetSql.make(declare(direction));
        const [text, params] =
          sql`SELECT 1 WHERE ${seek.after(sql, { id: "x", at: 7 })} ORDER BY ${seek.orderBy(sql)}`.compile();
        assert.match(
          text,
          new RegExp(
            String.raw`\("at"\s*,\s*"id"\) ${operator} \(${placeholder}\s*,\s*${placeholder}\)`,
          ),
        );
        assert.match(text, new RegExp(String.raw`ORDER BY "at" ${keyword}\s*,\s*"id" ${keyword}$`));
        assert.notInclude(text, " OR ");
        // The values bind in key order (at, id) whatever the field order of the cursor.
        assert.deepStrictEqual(params, [7, "x"]);
      }
    }).pipe(Effect.provide(TestSql.layer("keyset_sql_compiled"))),
  );

  it("make refuses a mixed-direction declaration with a tagged defect", () => {
    const error = thrown(() =>
      KeysetSql.make({ keys: [numberKey("at", "asc"), idKey("desc")], cursorOf: (row) => row }),
    );
    assert.isTrue(error instanceof Defects.InvalidConfiguration);
    if (error instanceof Defects.InvalidConfiguration) {
      assert.strictEqual(error._tag, "Defects/InvalidConfiguration");
      assert.strictEqual(error.setting, "keyset order");
      assert.include(error.message, "at asc");
      assert.include(error.message, "id desc");
    }
  });

  it.effect("after refuses a cursor that lacks a key's column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const seek = KeysetSql.make(declare("asc"));
      const error = thrown(() => seek.after(sql, { at: 1 }));
      assert.isTrue(error instanceof Defects.InvariantViolation);
      if (error instanceof Defects.InvariantViolation) {
        assert.strictEqual(error._tag, "Defects/InvariantViolation");
        assert.strictEqual(error.invariant, "keyset cursor columns");
        assert.include(error.message, "id");
      }
    }).pipe(Effect.provide(TestSql.layer("keyset_sql_arity"))),
  );

  it.effect("a column name reaches SQL only as an escaped identifier", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const weird = KeysetSql.make({
        keys: [
          Keyset.key<Probe, Probe, string>({
            column: 'we"ird',
            direction: "asc",
            order: Order.String,
            row: (row) => row.id,
            cursor: (cursor) => cursor.id,
          }),
        ],
        cursorOf: (row) => row,
      });
      const [text, params] =
        sql`SELECT 1 WHERE ${weird.after(sql, { 'we"ird': "a; DROP TABLE x" })} ORDER BY ${weird.orderBy(sql)}`.compile();
      assert.include(text, '"we""ird"');
      assert.notInclude(text, 'we"ird');
      assert.notInclude(text, "DROP");
      assert.deepStrictEqual(params, ["a; DROP TABLE x"]);
    }).pipe(Effect.provide(TestSql.layer("keyset_sql_escaped"))),
  );
});
