// KEY-01 spike: the declaration shape infers with no annotations or assertions on the keys.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Keyset from "../src/Keyset.ts";

interface UserRow {
  readonly id: string;
  readonly createdAt: DateTime.Utc;
}
interface UserCursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}
interface EpisodeRow {
  readonly id: string;
  readonly startedAt: DateTime.Utc;
}
interface EpisodeCursor {
  readonly startedAt: DateTime.Utc;
  readonly id: string;
}

const users: Keyset.Declaration<UserRow, UserCursor> = {
  keys: [
    Keyset.key({
      column: "createdAt",
      direction: "asc",
      order: DateTime.Order,
      row: (user) => user.createdAt,
      cursor: (cursor) => cursor.createdAt,
    }),
    Keyset.key({
      column: "id",
      direction: "asc",
      order: Order.String,
      row: (user) => user.id,
      cursor: (cursor) => cursor.id,
    }),
  ],
  cursorOf: (user) => ({ createdAt: user.createdAt, id: user.id }),
};

const episodes: Keyset.Declaration<EpisodeRow, EpisodeCursor> = {
  keys: [
    Keyset.key({
      column: "startedAt",
      direction: "desc",
      order: DateTime.Order,
      row: (episode) => episode.startedAt,
      cursor: (cursor) => cursor.startedAt,
    }),
    Keyset.key({
      column: "id",
      direction: "desc",
      order: Order.String,
      row: (episode) => episode.id,
      cursor: (cursor) => cursor.id,
    }),
  ],
  cursorOf: (episode) => ({ startedAt: episode.startedAt, id: episode.id }),
};

// A row accessor whose value type differs from its order is refused.
Keyset.key<UserRow, UserCursor, string>({
  column: "createdAt",
  direction: "asc",
  order: Order.String,
  // @ts-expect-error a DateTime.Utc is not the string the order compares
  row: (user) => user.createdAt,
  cursor: (cursor) => cursor.id,
});

// An empty key tuple is refused.
export const noKeys: Keyset.Declaration<UserRow, UserCursor> = {
  // @ts-expect-error a declaration needs at least one key
  keys: [],
  cursorOf: (user) => ({ createdAt: user.createdAt, id: user.id }),
};

describe("Keyset declarations", () => {
  it.effect("paginate answers a page over an inferred declaration", () =>
    Effect.gen(function* () {
      const rows: ReadonlyArray<EpisodeRow> = [
        { id: "a", startedAt: DateTime.makeUnsafe(1) },
        { id: "b", startedAt: DateTime.makeUnsafe(2) },
      ];
      const page = yield* Keyset.paginate(episodes, { after: Option.none(), limit: 1 }, (fetch) =>
        Effect.succeed(Keyset.window(episodes, rows, fetch)),
      );
      assert.deepStrictEqual(
        page.items.map((row) => row.id),
        ["b"],
      );
      assert.isTrue(Option.isSome(page.nextCursor));
      assert.strictEqual(users.keys.length, 2);
    }),
  );
});
