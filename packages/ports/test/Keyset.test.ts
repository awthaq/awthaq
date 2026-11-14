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

const ascending: Keyset.Declaration<Row, Cursor> = {
  keys: [
    Keyset.key({
      column: "at",
      direction: "asc",
      order: DateTime.Order,
      row: (row) => row.at,
      cursor: (cursor) => cursor.at,
    }),
    Keyset.key({
      column: "id",
      direction: "asc",
      order: Order.String,
      row: (row) => row.id,
      cursor: (cursor) => cursor.id,
    }),
  ],
  cursorOf: (row) => ({ at: row.at, id: row.id }),
};

const row = (id: string, millis: number): Row => ({ id, at: DateTime.makeUnsafe(millis) });

describe("Keyset.paginate", () => {
  it.effect(
    "reads limit + 1 once, trims to limit and answers the cursor of the last kept row",
    () =>
      Effect.gen(function* () {
        const calls: Array<Keyset.Fetch<Cursor>> = [];
        const rows = [row("a", 1), row("b", 2), row("c", 3)];
        const page = yield* Keyset.paginate(
          ascending,
          { after: Option.none(), limit: 2 },
          (fetch) => {
            calls.push(fetch);
            return Effect.succeed(rows);
          },
        );
        assert.deepStrictEqual(
          page.items.map((item) => item.id),
          ["a", "b"],
        );
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
});
