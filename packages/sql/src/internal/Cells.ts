// @awthaq/sql — sealed cells (CSG-006, plan 17): the helpers every core adapter with a sealed column
// shares (private to the package). A cell is the stored string of a nullable sealed column; a
// `Sealed` is how it crosses the port.

import { Sealed } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SealedColumn from "../SealedColumn.ts";

/**
 * One codec over a sealed column (`SealedColumn.codec`): `seal` for writes, `sealed` wraps a stored
 * cell for a record. The default store layers build none and hand out `Sealed.plain`; the sealing
 * ones (`UserStoreSql`/`SessionStoreSql` `layerSealedPii`) build one per `CoreSealedColumns` declaration, which
 * puts `Encryption` in the layer's requirements, so forgetting to provide it is a compile error, not a
 * runtime surprise. Rows leave a store adapter as stored: the sealed cell is opened where the domain needs it.
 */
export type ColumnCodec = Effect.Success<ReturnType<typeof SealedColumn.sqlCodec>>;

/** The stored cell of a nullable sealed column, as a `Sealed`: the codec when sealing, `Sealed.plain` otherwise. */
export const sealedCell = (
  codec: Option.Option<ColumnCodec>,
  rowKey: string,
  stored: string | null,
) =>
  Option.map(Option.fromNullOr(stored), (cell) =>
    Option.match(codec, {
      onNone: () => Sealed.plain(cell),
      onSome: (c) => c.sealed(rowKey, cell),
    }),
  );

/** A value on its way into a nullable sealed column: sealed under the canonical AAD when a codec is present. */
export const sealCell = (codec: Option.Option<ColumnCodec>, rowKey: string, value: string | null) =>
  Effect.flatMap(Effect.succeed(value), (present) =>
    present === null
      ? Effect.succeed(null)
      : Option.match(codec, {
          onNone: () => Effect.succeed(present),
          onSome: (c) => c.seal(rowKey, Redacted.make(present)),
        }),
  );
