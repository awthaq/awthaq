// KEY-01, BEH-EA-036: the one keyset page contract every listing shares.
//
// A listing declares its order once (`Declaration`): the keys, each with a column, a direction and a
// value order, and how a row becomes a cursor. Everything else derives from it: `paginate` owns the
// limit clamp, the single place a page limit gains one (`take = limit + 1`), the trim and the next
// cursor; `window` is the in-memory twin of the SQL predicate (sort, strictly after the cursor, take).
// `@awthaq/sql`'s `KeysetSql` reads the same `column` and `direction` to build the row-value predicate.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type * as Ordering from "effect/Ordering";

/** The fewest rows a page may ask for. */
export const MIN_LIMIT = 1;
/** The most rows a page may ask for. */
export const MAX_LIMIT = 200;
/** The page size when a caller names none. */
export const DEFAULT_LIMIT = 50;

/** One rule for every listing: truncated, clamped to `MIN_LIMIT..MAX_LIMIT`, `DEFAULT_LIMIT` when absent or non-finite. */
export const limit = (requested: number | undefined): number =>
  requested === undefined || !Number.isFinite(requested)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(Math.trunc(requested), MIN_LIMIT), MAX_LIMIT);

/** A page of items; `nextCursor` is `None` on the last page, an exactly-full final page does not invent one. */
export interface Page<Item, Cursor> {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor: Option.Option<Cursor>;
}

/** What a caller asks of a listing: where to resume, and how many rows (clamped by `limit`). */
export interface Request<Cursor> {
  readonly after: Option.Option<Cursor>;
  readonly limit?: number | undefined;
}

/** What `paginate` asks the store for: rows strictly after `after`, at most `take` of them. */
export interface Fetch<Cursor> {
  readonly after: Option.Option<Cursor>;
  readonly take: number;
}

/** The sort direction of one key; a closed union, never caller input. */
export type Direction = "asc" | "desc";

/**
 * One ordered key. The value type is hidden in the closures so keys of different value types share
 * one tuple with no `any`; `rows` and `against` already apply the direction.
 */
export interface Key<Row, Cursor> {
  /** The SQL column, a fixed literal from the declaration. */
  readonly column: string;
  readonly direction: Direction;
  /** Orders two rows by this key, direction applied. */
  readonly rows: Order.Order<Row>;
  /** Where `row` sits against `cursor` on this key, direction applied (1 = after the cursor). */
  readonly against: (row: Row, cursor: Cursor) => Ordering.Ordering;
}

/** Builds a `Key`; `order`, `row` and `cursor` are tied to one value type `V`, so a mismatched accessor does not compile. */
export const key = <Row, Cursor, V>(spec: {
  readonly column: string;
  readonly direction: Direction;
  readonly order: Order.Order<V>;
  readonly row: (row: Row) => V;
  readonly cursor: (cursor: Cursor) => V;
}): Key<Row, Cursor> => {
  const order = spec.direction === "desc" ? Order.flip(spec.order) : spec.order;
  return {
    column: spec.column,
    direction: spec.direction,
    rows: Order.mapInput(order, spec.row),
    against: (row, cursor) => order(spec.row(row), spec.cursor(cursor)),
  };
};

/** A listing's declared order: at least one key, and how a row becomes the cursor of the next page. */
export interface Declaration<Row, Cursor> {
  readonly keys: readonly [Key<Row, Cursor>, ...Array<Key<Row, Cursor>>];
  readonly cursorOf: (row: Row) => Cursor;
}

/** The memory twin of the SQL page: sorts by the declared keys, keeps rows strictly after `fetch.after`, slices to `fetch.take`. */
export const window = <Row, Cursor>(
  declaration: Declaration<Row, Cursor>,
  rows: Iterable<Row>,
  fetch: Fetch<Cursor>,
): ReadonlyArray<Row> => {
  const byKeys = Order.combineAll(declaration.keys.map((k) => k.rows));
  const after = fetch.after;
  const follows = (row: Row, cursor: Cursor): boolean => {
    for (const k of declaration.keys) {
      const at = k.against(row, cursor);
      if (at !== 0) return at === 1;
    }
    return false;
  };
  return Array.from(rows)
    .sort(byKeys)
    .filter((row) => Option.isNone(after) || follows(row, after.value))
    .slice(0, fetch.take);
};

/** Clamps the limit, reads `limit + 1` rows through `fetch` once, trims to `limit` and derives `nextCursor` only when more came back. */
export const paginate = <Row, Cursor, E, R>(
  declaration: Declaration<Row, Cursor>,
  request: Request<Cursor>,
  fetch: (fetch: Fetch<Cursor>) => Effect.Effect<ReadonlyArray<Row>, E, R>,
): Effect.Effect<Page<Row, Cursor>, E, R> => {
  const size = limit(request.limit);
  return Effect.map(fetch({ after: request.after, take: size + 1 }), (rows) => {
    const items = rows.slice(0, size);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > size && last !== undefined
          ? Option.some(declaration.cursorOf(last))
          : Option.none(),
    };
  });
};
