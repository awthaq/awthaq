// @awthaq/sql: KeysetSql (KEY-03, BEH-EA-036)
//
// The keyset seek for SQL listings, built from the same `Keyset.Declaration` the memory adapter
// windows with. A uniform-direction declaration becomes one row-value comparison (strictly greater
// for ascending, strictly less for descending) plus the matching ORDER BY; a mixed-direction
// declaration has no row-value form and is refused when the seek is made. Columns come only from the
// declaration and pass through the client's identifier escaping; the direction is one of two fixed
// keywords; cursor values are always bound parameters (already encoded by the adapter's request schema).

import { Defects, type Keyset } from "@awthaq/ports";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

/** One listing's seek: the cursor predicate and the ORDER BY, both derived from its declaration. */
export interface Seek {
  /** `(c1, c2, ...) > (?, ?, ...)` (`<` when descending); `values` are the cursor's key values in key order. */
  readonly after: (sql: SqlClient.SqlClient, values: ReadonlyArray<unknown>) => Statement.Fragment;
  /** `c1 ASC, c2 ASC` (`DESC` when descending). */
  readonly orderBy: (sql: SqlClient.SqlClient) => Statement.Fragment;
}

/** Throws `Defects.InvalidConfiguration` when the declaration's keys do not share one direction. */
export const make = <Row, Cursor>(declaration: Keyset.Declaration<Row, Cursor>): Seek => {
  const keys = declaration.keys;
  const first = keys[0];
  if (keys.some((k) => k.direction !== first.direction)) {
    throw new Defects.InvalidConfiguration({
      setting: "keyset order",
      message: `awthaq: a keyset seek needs one direction for every key, got ${keys
        .map((k) => `${k.column} ${k.direction}`)
        .join(", ")}`,
    });
  }
  const descending = first.direction === "desc";
  return {
    after: (sql, values) => {
      if (values.length !== keys.length) {
        throw new Defects.InvariantViolation({
          invariant: "keyset cursor arity",
          message: `awthaq: a keyset cursor carries ${values.length} values for ${keys.length} keys`,
        });
      }
      const columns = sql.csv(keys.map((k) => sql`${sql(k.column)}`));
      const bound = sql.csv(values.map((value) => sql`${value}`));
      return descending ? sql`(${columns}) < (${bound})` : sql`(${columns}) > (${bound})`;
    },
    orderBy: (sql) =>
      sql.csv(
        keys.map((k) => (descending ? sql`${sql(k.column)} DESC` : sql`${sql(k.column)} ASC`)),
      ),
  };
};
