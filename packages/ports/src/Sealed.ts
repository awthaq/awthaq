// @awthaq/ports — Sealed
//
// Plan 17 (ADR-EA-019 decision 6): a value an adapter stores sealed, handed to domain code unopened.
// `@awthaq/sql`'s `SealedColumn` builds these over an `Encryption` envelope; the core store ports
// (`UserStore`, `SessionStore`, `AccountStore`) carry them, so the meaning of a value that does not
// open is decided in the domain, where it is known, and not hidden in an adapter.
//
// `open` is the only place the plaintext appears. A value that does not open fails the typed
// `Unreadable`, never `null` and never a defect. A call site picks one treatment:
//   - `orDie`:    fail closed (a defect naming the column, never the value);
//   - `option` / `optional`: degrade this value to `None` with one ids-only warning;
//   - or map `Unreadable` to its own typed domain failure (provider tokens: re-consent).
//
// `SealedColumn` re-exports everything here, so a plugin that already uses `SealedColumn.Sealed`,
// `SealedColumn.Unreadable`, `SealedColumn.orDie` or `SealedColumn.option` compiles unchanged. There is
// one class, and its tag stays "SealedColumn/Unreadable".

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Defects from "./Defects.ts";

export class Unreadable extends Data.TaggedError("SealedColumn/Unreadable")<{
  readonly table: string;
  readonly column: string;
  readonly rowKey: string;
  readonly reason: "DecryptionFailed" | "UnknownKeyId" | "Malformed";
}> {}

/** What a record carries in place of an envelope. Domain code opens it where it needs the value. */
export interface Sealed<A> {
  readonly open: Effect.Effect<Redacted.Redacted<A>, Unreadable>;
}

/** A value its adapter holds in plaintext (a `Ref` store, `encryptPii: false`): it always opens. */
export const plain = <A>(value: A): Sealed<A> => ({ open: Effect.succeed(Redacted.make(value)) });

/** `None` stays `None`; a present value is opened (fails `Unreadable`). */
export const openOption = <A>(value: Option.Option<Sealed<A>>) =>
  Option.match(value, {
    onNone: () => Effect.succeedNone,
    onSome: (sealed) => Effect.map(sealed.open, Option.some),
  });

const isUnreadable = <E>(error: E): error is Extract<E, Unreadable> => error instanceof Unreadable;

const describe = (unreadable: Unreadable) => ({
  table: unreadable.table,
  column: unreadable.column,
  rowKey: unreadable.rowKey,
  reason: unreadable.reason,
});

/** Fail closed: a defect naming the column (never the value). For a value the operation cannot proceed without. */
export const orDie = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.catchIf(self, isUnreadable, (unreadable) =>
    Defects.invariantViolation(
      "sealedColumn.readable",
      `awthaq: ${unreadable.table}.${unreadable.column} of ${unreadable.rowKey} cannot be opened (${unreadable.reason})`,
    ),
  );

const unreadableMarker: unique symbol = Symbol("awthaq/ports/Sealed/unreadable");

/** Degrade: `None` plus one warning (ids only). For one optional value or one row of a list. */
export const option = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.map(
    Effect.catchIf(self, isUnreadable, (unreadable) =>
      Effect.logWarning(
        "awthaq: a sealed column cannot be opened; it may be sealed under a retired legacy AAD; restore from backup or re-enter the secret",
      ).pipe(Effect.annotateLogs(describe(unreadable)), Effect.as(unreadableMarker)),
    ),
    (value) => (value === unreadableMarker ? Option.none<A>() : Option.some(value)),
  );

/** `option` over an optional column: absent, or unreadable (one ids-only warning), are both `None`. */
export const optional = <A>(value: Option.Option<Sealed<A>>) =>
  Effect.map(option(openOption(value)), Option.flatten);
