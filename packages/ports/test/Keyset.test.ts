// KEY-01: the keyset page contract, against a fake fetch.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Keyset from "../src/Keyset.ts";

interface Row {
  readonly id: string;
  readonly at: DateTime.Utc;
}
interface Cursor {
  readonly at: DateTime.Utc;
  readonly id: string;
}

const atKey = (direction: Keyset.Direction) =>
  Keyset.key({
    column: "at",
    direction,
    order: DateTime.Order,
    row: (row: Row) => row.at,
    cursor: (cursor: Cursor) => cursor.at,
  });
const idKey = (direction: Keyset.Direction) =>
  Keyset.key({
    column: "id",
    direction,
    order: Order.String,
    row: (row: Row) => row.id,
    cursor: (cursor: Cursor) => cursor.id,
  });
const cursorOf = (row: Row): Cursor => ({ at: row.at, id: row.id });

const ascending: Keyset.Declaration<Row, Cursor> = {
  keys: [atKey("asc"), idKey("asc")],
  cursorOf,
};
const descending: Keyset.Declaration<Row, Cursor> = {
  keys: [atKey("desc"), idKey("desc")],
  cursorOf,
};

const row = (id: string, millis: number): Row => ({ id, at: DateTime.makeUnsafe(millis) });
const ids = (rows: ReadonlyArray<Row>): ReadonlyArray<string> => rows.map((item) => item.id);

// Ties on `at` and mixed-case ids; by code unit "B1" < "_x" < "a1" < "b1" (a locale order would put "_x" and "a1" before "B1").
const rows: ReadonlyArray<Row> = [
  row("B1", 1000),
  row("a1", 1000),
  row("_x", 1000),
  row("A2", 2000),
  row("b0", 2000),
  row("a0", 2000),
  row("Z9", 3000),
  row("b1", 1000),
  row("A1", 3000),
];

// Today's users memory formula (UserStore.byCreation and the listPage filter), copied as a local oracle.
const usersOracle = (after: Option.Option<Cursor>, take: number): ReadonlyArray<string> =>
  [...rows]
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(a.at) - DateTime.toEpochMillis(b.at) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .filter(
      (user) =>
        Option.isNone(after) ||
        DateTime.toEpochMillis(user.at) > DateTime.toEpochMillis(after.value.at) ||
        (DateTime.toEpochMillis(user.at) === DateTime.toEpochMillis(after.value.at) &&
          user.id > after.value.id),
    )
    .slice(0, take)
    .map((user) => user.id);

// Today's impersonation memory formula (newestFirst and isBeforeCursor), copied as a local oracle.
const impersonationOracle = (after: Option.Option<Cursor>, take: number): ReadonlyArray<string> =>
  [...rows]
    .sort((a, b) => {
      const byTime = DateTime.toEpochMillis(b.at) - DateTime.toEpochMillis(a.at);
      return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .filter((record) => {
      if (Option.isNone(after)) return true;
      const recordMillis = DateTime.toEpochMillis(record.at);
      const cursorMillis = DateTime.toEpochMillis(after.value.at);
      return (
        recordMillis < cursorMillis || (recordMillis === cursorMillis && record.id < after.value.id)
      );
    })
    .slice(0, take)
    .map((record) => record.id);

// Every row's own cursor, plus positions that fall between and outside the rows.
const afters: ReadonlyArray<Option.Option<Cursor>> = [
  Option.none(),
  ...rows.map((item) => Option.some(cursorOf(item))),
  Option.some({ at: DateTime.makeUnsafe(1500), id: "zz" }),
  Option.some({ at: DateTime.makeUnsafe(0), id: "" }),
  Option.some({ at: DateTime.makeUnsafe(9000), id: "" }),
];

const run = <E>(
  declaration: Keyset.Declaration<Row, Cursor>,
  request: Keyset.Request<Cursor>,
  fetch: (fetch: Keyset.Fetch<Cursor>) => Effect.Effect<ReadonlyArray<Row>, E>,
) => Keyset.paginate(declaration, request, fetch);

describe("Keyset.limit", () => {
  it("clamps a requested limit to 1..200, 50 when absent or non-finite, truncating fractions", () => {
    const table: ReadonlyArray<readonly [number | undefined, number]> = [
      [undefined, 50],
      [Number.NaN, 50],
      [Number.POSITIVE_INFINITY, 50],
      [Number.NEGATIVE_INFINITY, 50],
      [0, 1],
      [-3, 1],
      [2.5, 2],
      [1, 1],
      [200, 200],
      [201, 200],
      [10_000, 200],
    ];
    for (const [requested, expected] of table) {
      assert.strictEqual(Keyset.limit(requested), expected, `limit(${String(requested)})`);
    }
    assert.deepStrictEqual(
      [Keyset.MIN_LIMIT, Keyset.MAX_LIMIT, Keyset.DEFAULT_LIMIT],
      [1, 200, 50],
    );
  });
});

describe("Keyset.paginate", () => {
  it.effect(
    "reads limit + 1 once, trims to limit and answers the cursor of the last kept row",
    () =>
      Effect.gen(function* () {
        const calls: Array<Keyset.Fetch<Cursor>> = [];
        const page = yield* run(ascending, { after: Option.none(), limit: 2 }, (fetch) => {
          calls.push(fetch);
          return Effect.succeed([row("a", 1), row("b", 2), row("c", 3)]);
        });
        assert.deepStrictEqual(ids(page.items), ["a", "b"]);
        assert.deepStrictEqual(
          Option.map(page.nextCursor, (cursor) => cursor.id),
          Option.some("b"),
        );
        assert.deepStrictEqual(
          calls.map((call) => call.take),
          [3],
        );
      }),
  );

  it.effect("asks the store for limit + 1 whatever the caller passes", () =>
    Effect.gen(function* () {
      const table: ReadonlyArray<readonly [number | undefined, number]> = [
        [2, 3],
        [undefined, 51],
        [10_000, 201],
        [0, 2],
        [-3, 2],
        [2.5, 3],
        [Number.NaN, 51],
        [Number.POSITIVE_INFINITY, 51],
      ];
      for (const [requested, take] of table) {
        const calls: Array<Keyset.Fetch<Cursor>> = [];
        yield* run(ascending, { after: Option.none(), limit: requested }, (fetch) => {
          calls.push(fetch);
          return Effect.succeed([]);
        });
        assert.deepStrictEqual(
          calls.map((call) => call.take),
          [take],
          `limit ${String(requested)}`,
        );
      }
    }),
  );

  it.effect("passes after through unchanged", () =>
    Effect.gen(function* () {
      const some = Option.some({ at: DateTime.makeUnsafe(5), id: "x" });
      const seen: Array<Option.Option<Cursor>> = [];
      for (const after of [Option.none<Cursor>(), some]) {
        yield* run(ascending, { after }, (fetch) => {
          seen.push(fetch.after);
          return Effect.succeed([]);
        });
      }
      assert.strictEqual(seen[0], Option.none<Cursor>());
      assert.strictEqual(seen[1], some);
    }),
  );

  it.effect("answers no cursor for exactly limit rows, the cursor of row limit for limit + 1", () =>
    Effect.gen(function* () {
      const three = [row("a", 1), row("b", 2), row("c", 3)];
      const full = yield* run(ascending, { after: Option.none(), limit: 3 }, () =>
        Effect.succeed(three),
      );
      assert.deepStrictEqual(ids(full.items), ["a", "b", "c"]);
      assert.isTrue(Option.isNone(full.nextCursor));

      const more = yield* run(ascending, { after: Option.none(), limit: 2 }, () =>
        Effect.succeed(three),
      );
      assert.deepStrictEqual(ids(more.items), ["a", "b"]);
      assert.deepStrictEqual(more.nextCursor, Option.some(cursorOf(row("b", 2))));

      const fewer = yield* run(ascending, { after: Option.none(), limit: 5 }, () =>
        Effect.succeed(three),
      );
      assert.deepStrictEqual(ids(fewer.items), ["a", "b", "c"]);
      assert.isTrue(Option.isNone(fewer.nextCursor));

      const empty = yield* run(ascending, { after: Option.none(), limit: 5 }, () =>
        Effect.succeed([]),
      );
      assert.deepStrictEqual(empty.items, []);
      assert.isTrue(Option.isNone(empty.nextCursor));
    }),
  );

  it.effect("fails with the fetch's own error, untouched", () =>
    Effect.gen(function* () {
      const failure = new Error("store down");
      const error = yield* Effect.flip(
        run(ascending, { after: Option.none() }, () => Effect.fail(failure)),
      );
      assert.strictEqual(error, failure);
    }),
  );
});

describe("Keyset.window", () => {
  it("ascending (at, id) equals today's users memory order at every cursor and take", () => {
    for (const after of afters) {
      for (let take = 1; take <= rows.length + 1; take++) {
        assert.deepStrictEqual(
          ids(Keyset.window(ascending, rows, { after, take })),
          usersOracle(after, take),
          `after ${JSON.stringify(after)} take ${take}`,
        );
      }
    }
  });

  it("descending (at, id) equals today's impersonation memory order at every cursor and take", () => {
    for (const after of afters) {
      for (let take = 1; take <= rows.length + 1; take++) {
        assert.deepStrictEqual(
          ids(Keyset.window(descending, rows, { after, take })),
          impersonationOracle(after, take),
          `after ${JSON.stringify(after)} take ${take}`,
        );
      }
    }
  });

  it("compares ids by code unit, not by locale", () => {
    assert.deepStrictEqual(ids(Keyset.window(ascending, rows, { after: Option.none(), take: 9 })), [
      "B1",
      "_x",
      "a1",
      "b1",
      "A2",
      "a0",
      "b0",
      "A1",
      "Z9",
    ]);
  });

  it("excludes a row equal to the cursor and keeps the next one for a cursor between rows", () => {
    const equal = Keyset.window(ascending, rows, {
      after: Option.some(cursorOf(row("a1", 1000))),
      take: 9,
    });
    assert.isFalse(ids(equal).includes("a1"));
    assert.strictEqual(ids(equal)[0], "b1");

    const between = Keyset.window(ascending, rows, {
      after: Option.some({ at: DateTime.makeUnsafe(1500), id: "zz" }),
      take: 1,
    });
    assert.deepStrictEqual(ids(between), ["A2"]);
  });

  it("pages a single-key declaration", () => {
    const single: Keyset.Declaration<Row, Cursor> = { keys: [idKey("asc")], cursorOf };
    const first = Keyset.window(single, rows, { after: Option.none(), take: 3 });
    assert.deepStrictEqual(ids(first), ["A1", "A2", "B1"]);
    const second = Keyset.window(single, rows, {
      after: Option.some(cursorOf(row("B1", 1000))),
      take: 2,
    });
    assert.deepStrictEqual(ids(second), ["Z9", "_x"]);
  });

  it("orders a mixed-direction declaration as declared (only the SQL builder refuses it)", () => {
    const mixed: Keyset.Declaration<Row, Cursor> = {
      keys: [atKey("asc"), idKey("desc")],
      cursorOf,
    };
    assert.deepStrictEqual(ids(Keyset.window(mixed, rows, { after: Option.none(), take: 9 })), [
      "b1",
      "a1",
      "_x",
      "B1",
      "b0",
      "a0",
      "A2",
      "Z9",
      "A1",
    ]);
    const after = Keyset.window(mixed, rows, {
      after: Option.some(cursorOf(row("a1", 1000))),
      take: 3,
    });
    assert.deepStrictEqual(ids(after), ["_x", "B1", "b0"]);
  });
});

describe("Keyset.chronological", () => {
  it("orders tied rows by (createdAt, id code unit) ascending and the exact reverse descending", () => {
    const sorted = (direction: Keyset.Direction) =>
      ids(
        [...rows].sort(
          Keyset.chronological({
            createdAt: (row: Row) => row.at,
            id: (row) => row.id,
            direction,
          }),
        ),
      );
    assert.deepStrictEqual(sorted("asc"), ["B1", "_x", "a1", "b1", "A2", "a0", "b0", "A1", "Z9"]);
    assert.deepStrictEqual(sorted("desc"), ["Z9", "A1", "b0", "a0", "A2", "b1", "a1", "_x", "B1"]);
  });
});
