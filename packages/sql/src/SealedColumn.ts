// @awthaq/sql — SealedColumn
//
// Plan 05 (ADR-EA-019 decision 6): one interface for a column stored as an `Encryption` envelope.
// A plugin declares the column once (`column`), builds a `codec` over it in each records adapter,
// and its records hand out `Sealed<A>` values whose `open` effect is the only place a plaintext
// appears, so domain code never sees an envelope or an AAD.
//
// - One AAD convention, `<table>:<rowKey>:<column>`, so a ciphertext cannot be moved to another
//   row or column. Envelopes sealed under an older spelling are listed in `legacyAad`: they still
//   open, and re-seal to the canonical AAD on the next read.
// - Lazy re-seal (ADR-EA-019 decision 3): when the stored envelope is under a retired key (or a
//   legacy AAD), `open` writes the fresh envelope back by compare-and-swap, so a concurrent
//   rotation always wins. A failed or lost swap is logged (ids only) and never fails the read.
// - A value that does not open is the typed `SealedColumn/Unreadable`, never `null` and never a
//   defect. Each call site picks one of two treatments: `orDie` (fail closed) or `option`
//   (degrade this value with a warning).
// - `sweep` re-seals every stale or legacy value of a column: the operator's batch job.

import { Defects, Encryption, KeyProvider } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A column declaration with a name that is not a plain SQL identifier. Thrown at definition time. */
export class InvalidDeclaration extends Data.TaggedError("SealedColumn/InvalidDeclaration")<{
  readonly field: string;
  readonly message: string;
}> {}

export interface Column<A> {
  readonly table: string;
  readonly column: string;
  /** The row-key column: its value is bound into the AAD and used by the re-seal compare-and-swap. */
  readonly key: string;
  readonly schema: Schema.Codec<A, string>;
  /** Read-only AADs for envelopes sealed before this declaration; a hit re-seals under the canonical one. */
  readonly legacyAad: ReadonlyArray<(rowKey: string) => string>;
  /** Treat a non-envelope stored value as legacy plaintext and seal it on read. */
  readonly adoptPlaintext: boolean;
}

interface ColumnOptions {
  readonly table: string;
  readonly column: string;
  readonly key: string;
  readonly legacyAad?: ReadonlyArray<(rowKey: string) => string>;
  readonly adoptPlaintext?: boolean;
}

const validated = (options: ColumnOptions) => {
  for (const field of ["table", "column", "key"] as const) {
    if (!IDENTIFIER.test(options[field])) {
      throw new InvalidDeclaration({
        field,
        message: `awthaq: a sealed column's ${field} must be a plain SQL identifier`,
      });
    }
  }
  return {
    table: options.table,
    column: options.column,
    key: options.key,
    legacyAad: options.legacyAad ?? [],
    adoptPlaintext: options.adoptPlaintext ?? false,
  };
};

/** Declares a sealed column. Throws `SealedColumn/InvalidDeclaration` for a non-identifier table, column or key. */
export function column(options: ColumnOptions): Column<string>;
export function column<A>(
  options: ColumnOptions & { readonly schema: Schema.Codec<A, string> },
): Column<A>;
export function column(
  options: ColumnOptions & { readonly schema?: Schema.Codec<unknown, string> },
) {
  return { ...validated(options), schema: options.schema ?? Schema.String };
}

/** ADR-EA-019 decision 6: the one AAD convention. Matches core's `<entity>:<id>:<field>` shape. */
export const aadOf = <A>(declared: Column<A>, rowKey: string) =>
  `${declared.table}:${rowKey}:${declared.column}`;

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

/** Re-seal is on by default (ADR-EA-019 decision 3); a deployment reading a replica-only path can turn it off. */
export const SealedColumnConfig = Context.Reference<{ readonly resealOnRead: boolean }>(
  "awthaq/sql/SealedColumnConfig",
  { defaultValue: () => ({ resealOnRead: true }) },
);

/** Persists a re-seal only while the row still holds `stored`; `false` when a concurrent writer won. */
export interface Swap {
  (rowKey: string, stored: string, fresh: string): Effect.Effect<boolean, unknown>;
}

/** The SQL `Swap`: `UPDATE t SET c = fresh WHERE key = rowKey AND c = stored RETURNING key`. */
export const sqlSwap = <A>(declared: Column<A>) =>
  Effect.map(
    SqlClient.SqlClient,
    (sql): Swap =>
      (rowKey, stored, fresh) =>
        sql`UPDATE ${sql(declared.table)} SET ${sql(declared.column)} = ${fresh}
          WHERE ${sql(declared.key)} = ${rowKey} AND ${sql(declared.column)} = ${stored}
          RETURNING ${sql(declared.key)}`.pipe(Effect.map((rows) => rows.length > 0)),
  );

// ---- the low-level primitive (core PII and token codecs run on it too) ----------------

export interface Revealed {
  readonly plaintext: Redacted.Redacted<string>;
  /** A sealed value to write back: the stored one was stale, legacy-AAD or adopted plaintext. */
  readonly refreshed: Option.Option<string>;
}

export interface RevealOptions {
  readonly aad: string;
  readonly legacyAad?: ReadonlyArray<string>;
  readonly adoptPlaintext?: boolean;
}

/**
 * Opens `stored` under `options.aad`. On `DecryptionFailed`, each legacy AAD is tried in turn (an
 * `UnknownKeyId` is never retried: another AAD cannot make an unknown key known). A legacy hit, a
 * stale key, or (with `adoptPlaintext`) a plain value yields a `refreshed` envelope under the
 * canonical AAD. An envelope-shaped value that fails authentication is never read as plaintext.
 */
export const reveal = (
  encryption: Encryption.EncryptionShape,
  options: RevealOptions,
  stored: string,
) => {
  const seal = (plaintext: Redacted.Redacted<string>) => encryption.encrypt(plaintext, options.aad);
  if (options.adoptPlaintext === true && !Encryption.looksLikeEnvelope(stored)) {
    const plaintext = Redacted.make(stored);
    return seal(plaintext).pipe(
      Effect.map((sealed): Revealed => ({ plaintext, refreshed: Option.some(sealed) })),
    );
  }
  const viaLegacy = (
    remaining: ReadonlyArray<string>,
    failure: Encryption.DecryptionFailed,
  ): Effect.Effect<Revealed, Encryption.DecryptionFailed | KeyProvider.UnknownKeyId> => {
    const [next, ...rest] = remaining;
    if (next === undefined) return Effect.fail(failure);
    return encryption.decrypt(stored, next).pipe(
      Effect.flatMap((decrypted) =>
        seal(decrypted.plaintext).pipe(
          Effect.map((sealed): Revealed => ({
            plaintext: decrypted.plaintext,
            refreshed: Option.some(sealed),
          })),
        ),
      ),
      Effect.catchTag("DecryptionFailed", () => viaLegacy(rest, failure)),
    );
  };
  return encryption.decrypt(stored, options.aad).pipe(
    Effect.flatMap((decrypted) =>
      Option.isNone(decrypted.staleKid)
        ? Effect.succeed<Revealed>({ plaintext: decrypted.plaintext, refreshed: Option.none() })
        : seal(decrypted.plaintext).pipe(
            Effect.map((sealed): Revealed => ({
              plaintext: decrypted.plaintext,
              refreshed: Option.some(sealed),
            })),
          ),
    ),
    Effect.catchTag("DecryptionFailed", (failure) => viaLegacy(options.legacyAad ?? [], failure)),
  );
};

// ---- the codec ------------------------------------------------------------------------

/**
 * One codec per column per records layer. `seal` for writes; `sealed` wraps a stored value for a
 * record. `open`: canonical AAD first, then each legacy AAD; decode via the column schema
 * (`Malformed`); on a stale key or a legacy hit, re-seal under the canonical AAD by `swap`.
 */
export const codec = <A>(declared: Column<A>, swap: Swap) =>
  Effect.gen(function* () {
    const encryption = yield* Encryption.Encryption;
    const config = yield* SealedColumnConfig;
    const encode = Schema.encodeEffect(declared.schema);
    const decode = Schema.decodeUnknownEffect(declared.schema);

    const seal = (rowKey: string, value: Redacted.Redacted<A>) =>
      encode(Redacted.value(value)).pipe(
        Effect.orDie,
        Effect.flatMap((text) => encryption.encrypt(Redacted.make(text), aadOf(declared, rowKey))),
      );

    const ids = (rowKey: string) => ({
      table: declared.table,
      column: declared.column,
      rowKey,
    });

    const persist = (rowKey: string, stored: string, fresh: string) =>
      swap(rowKey, stored, fresh).pipe(
        Effect.flatMap((won) =>
          won
            ? Effect.void
            : Effect.logDebug("awthaq: a sealed column was re-sealed by another writer first").pipe(
                Effect.annotateLogs(ids(rowKey)),
              ),
        ),
        Effect.catch(() =>
          Effect.logWarning(
            "awthaq: re-sealing a sealed column failed; the read still succeeds",
          ).pipe(Effect.annotateLogs(ids(rowKey))),
        ),
      );

    const sealed = (rowKey: string, stored: string): Sealed<A> => ({
      open: reveal(
        encryption,
        {
          aad: aadOf(declared, rowKey),
          legacyAad: declared.legacyAad.map((legacy) => legacy(rowKey)),
          adoptPlaintext: declared.adoptPlaintext,
        },
        stored,
      ).pipe(
        Effect.catchTags({
          DecryptionFailed: () =>
            Effect.fail(new Unreadable({ ...ids(rowKey), reason: "DecryptionFailed" })),
          UnknownKeyId: () =>
            Effect.fail(new Unreadable({ ...ids(rowKey), reason: "UnknownKeyId" })),
        }),
        Effect.flatMap((revealed) =>
          decode(Redacted.value(revealed.plaintext)).pipe(
            Effect.mapError(() => new Unreadable({ ...ids(rowKey), reason: "Malformed" })),
            Effect.tap(() =>
              config.resealOnRead && Option.isSome(revealed.refreshed)
                ? persist(rowKey, stored, revealed.refreshed.value)
                : Effect.void,
            ),
            Effect.map((value) => Redacted.make(value)),
          ),
        ),
      ),
    });

    return { seal, sealed };
  });

// ---- the two sanctioned call-site treatments of Unreadable ---------------------------

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

const unreadableMarker: unique symbol = Symbol("awthaq/sql/SealedColumn/unreadable");

/** Degrade: `None` plus one warning (ids only). For one optional value or one row of a list. */
export const option = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.map(
    Effect.catchIf(self, isUnreadable, (unreadable) =>
      Effect.logWarning("awthaq: a sealed column cannot be opened").pipe(
        Effect.annotateLogs(describe(unreadable)),
        Effect.as(unreadableMarker),
      ),
    ),
    (value) => (value === unreadableMarker ? Option.none<A>() : Option.some(value)),
  );

// ---- maintenance ----------------------------------------------------------------------

export interface SweepReport {
  readonly scanned: number;
  readonly resealed: number;
  /** Values that did not open (tampered, wrong key). Never touched. */
  readonly unreadable: number;
}

/**
 * Batch re-seal (ADR-EA-019 decision 3 left a batch out of scope; retiring a kid and sunsetting
 * the legacy AADs are its callers). Keyset-pages `table` by `key`, opens every value, re-seals the
 * stale or legacy ones by compare-and-swap. An operator job, never run by a request.
 */
export const sweep = <A>(declared: Column<A>, options?: { readonly batch?: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encryption = yield* Encryption.Encryption;
    const swap = yield* sqlSwap(declared);
    const batch = options?.batch ?? 100;
    let scanned = 0;
    let resealed = 0;
    let unreadable = 0;
    let last: string | undefined;
    for (;;) {
      const rows = yield* sql<{ readonly rowKey: string; readonly stored: string }>`
        SELECT ${sql(declared.key)} AS "rowKey", ${sql(declared.column)} AS "stored"
        FROM ${sql(declared.table)}
        WHERE ${sql(declared.column)} IS NOT NULL
          ${last === undefined ? sql.literal("") : sql`AND ${sql(declared.key)} > ${last}`}
        ORDER BY ${sql(declared.key)}
        LIMIT ${batch}`;
      for (const row of rows) {
        scanned += 1;
        const outcome = yield* reveal(
          encryption,
          {
            aad: aadOf(declared, row.rowKey),
            legacyAad: declared.legacyAad.map((legacy) => legacy(row.rowKey)),
            adoptPlaintext: declared.adoptPlaintext,
          },
          row.stored,
        ).pipe(Effect.option);
        if (Option.isNone(outcome)) {
          unreadable += 1;
        } else if (Option.isSome(outcome.value.refreshed)) {
          const won = yield* swap(row.rowKey, row.stored, outcome.value.refreshed.value);
          if (won) resealed += 1;
        }
        last = row.rowKey;
      }
      if (rows.length < batch) break;
    }
    return { scanned, resealed, unreadable } satisfies SweepReport;
  });
