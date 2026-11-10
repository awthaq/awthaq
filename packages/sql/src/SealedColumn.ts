// @awthaq/sql — SealedColumn
//
// Plan 05 (ADR-EA-019 decision 6): one interface for a column stored as an `Encryption` envelope.
// A plugin declares the column once (`column`), builds a `codec` over it in each records adapter,
// and its records hand out `Sealed<A>` values whose `open` effect is the only place a plaintext
// appears, so domain code never sees an envelope or an AAD.
//
// - One AAD convention, `<table>:<rowKey>:<column>`, so a ciphertext cannot be moved to another
//   row or column. There is no fallback to an older spelling (ADR-EA-019 revisions 1.2 and 1.3):
//   an envelope sealed under one fails as `Unreadable`. Core's own six columns are declared the same
//   way (`CoreSealedColumns`, plan 17).
// - Lazy re-seal (ADR-EA-019 decision 3): when the stored envelope is under a retired key,
//   `open` writes the fresh envelope back by compare-and-swap, so a concurrent
//   rotation always wins. A failed or lost swap is logged (ids only) and never fails the read.
// - A value that does not open is the typed `SealedColumn/Unreadable`, never `null` and never a
//   defect. Each call site picks one of two treatments: `orDie` (fail closed) or `option`
//   (degrade this value with a warning). The value, its error and the treatments live in
//   `@awthaq/ports` (`Sealed`) so the core store ports can carry them; they are re-exported here.
// - `sweep` re-seals every stale value of a column: the operator's batch job (key rotation);
//   `sweepAll` runs it over every column and logs one summary per column. `Deployed` lists the
//   columns a composition (`Persistence.sql(options)`) really seals, and `sweepDeployed` sweeps them.

import { Encryption, KeyProvider, Sealed as SealedPort, SqlTransaction, Tenant } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
  /** Treat a non-envelope stored value as legacy plaintext and seal it on read. */
  readonly adoptPlaintext: boolean;
}

interface ColumnOptions {
  readonly table: string;
  readonly column: string;
  readonly key: string;
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

/** What the AAD convention and `sweep` need of a column: everything but its value schema. */
export type Sweepable = Pick<Column<unknown>, "table" | "column" | "key" | "adoptPlaintext">;

/** ADR-EA-019 decision 6: the one AAD convention, for plugin columns and core's six alike. */
export const aadOf = (declared: Pick<Sweepable, "table" | "column">, rowKey: string) =>
  `${declared.table}:${rowKey}:${declared.column}`;

/** The typed failure of a value that does not open. The class lives in `@awthaq/ports` (`Sealed`); one class, one tag. */
export const Unreadable = SealedPort.Unreadable;
export type Unreadable = SealedPort.Unreadable;

/** What a record carries in place of an envelope. Domain code opens it where it needs the value. */
export type Sealed<A> = SealedPort.Sealed<A>;

/** Re-seal is on by default (ADR-EA-019 decision 3); a deployment reading a replica-only path can turn it off. */
export const SealedColumnConfig = Context.Reference<{ readonly resealOnRead: boolean }>(
  "awthaq/sql/SealedColumnConfig",
  { defaultValue: () => ({ resealOnRead: true }) },
);

/** BEH-EA-355: deployment-scoped. */
export const SealedColumnConfigScoped = Tenant.perDeployment(SealedColumnConfig);

/** Persists a re-seal only while the row still holds `stored`; `false` when a concurrent writer won. */
export interface Swap {
  (rowKey: string, stored: string, fresh: string): Effect.Effect<boolean, unknown>;
}

/**
 * The SQL `Swap`: `UPDATE t SET c = fresh WHERE key = rowKey AND c = stored RETURNING key`, in a
 * savepoint when nested (a one-statement transaction otherwise), so a failed re-seal rolls back only
 * itself and never aborts the enclosing Postgres transaction (SQLSTATE 25P02).
 */
export const sqlSwap = (declared: Pick<Sweepable, "table" | "column" | "key">) =>
  Effect.map(
    SqlClient.SqlClient,
    (sql): Swap =>
      (rowKey, stored, fresh) =>
        SqlTransaction.transactional(sql)(
          sql`UPDATE ${sql(declared.table)} SET ${sql(declared.column)} = ${fresh}
          WHERE ${sql(declared.key)} = ${rowKey} AND ${sql(declared.column)} = ${stored}
          RETURNING ${sql(declared.key)}`,
        ).pipe(Effect.map((rows) => rows.length > 0)),
  );

// ---- the low-level primitive (core PII and token codecs run on it too) ----------------

export interface Revealed {
  readonly plaintext: Redacted.Redacted<string>;
  /** A sealed value to write back: the stored one was stale or adopted plaintext. */
  readonly refreshed: Option.Option<string>;
}

export interface RevealOptions {
  readonly aad: string;
  readonly adoptPlaintext?: boolean;
}

/**
 * Opens `stored` under `options.aad` only. A stale key, or (with `adoptPlaintext`) a plain value,
 * yields a `refreshed` envelope under the canonical AAD. An envelope-shaped value that fails authentication is never read as plaintext.
 */
export const reveal = (
  encryption: Encryption.EncryptionShape,
  options: RevealOptions,
  stored: string,
): Effect.Effect<Revealed, Encryption.DecryptionFailed | KeyProvider.UnknownKeyId> => {
  const seal = (plaintext: Redacted.Redacted<string>) => encryption.encrypt(plaintext, options.aad);
  if (options.adoptPlaintext === true && !Encryption.looksLikeEnvelope(stored)) {
    const plaintext = Redacted.make(stored);
    return seal(plaintext).pipe(
      Effect.map((sealed): Revealed => ({
        plaintext,
        refreshed: Option.some(sealed),
      })),
    );
  }
  return encryption.decrypt(stored, options.aad).pipe(
    Effect.flatMap((decrypted) =>
      Option.isNone(decrypted.staleKid)
        ? Effect.succeed<Revealed>({
            plaintext: decrypted.plaintext,
            refreshed: Option.none(),
          })
        : seal(decrypted.plaintext).pipe(
            Effect.map((sealed): Revealed => ({
              plaintext: decrypted.plaintext,
              refreshed: Option.some(sealed),
            })),
          ),
    ),
  );
};

// ---- the codec ------------------------------------------------------------------------

/**
 * One codec per column per records layer. `seal` for writes; `sealed` wraps a stored value for a
 * record. `open`: the canonical AAD only; decode via the column schema
 * (`Malformed`); on a stale key, re-seal under the canonical AAD by `swap`.
 */
export const codec = <A>(declared: Column<A>, swap: Swap) =>
  Effect.gen(function* () {
    const encryption = yield* Encryption.Encryption;
    const config = yield* yield* Tenant.inForce(SealedColumnConfigScoped);
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

// ---- the sanctioned call-site treatments of Unreadable (defined beside `Sealed` in @awthaq/ports) ----

/** Fail closed: a defect naming the column (never the value). For a value the operation cannot proceed without. */
export const orDie = SealedPort.orDie;

/** Degrade: `None` plus one warning (ids only). For one optional value or one row of a list. */
export const option = SealedPort.option;

// ---- maintenance ----------------------------------------------------------------------

export interface SweepReport {
  readonly scanned: number;
  readonly resealed: number;
  /** Values that did not open (tampered, wrong key). Never touched. */
  readonly unreadable: number;
}

/**
 * Batch re-seal (ADR-EA-019 decision 3 left a batch out of scope; retiring a kid is its
 * caller). Keyset-pages `table` by `key`, opens every value, re-seals the
 * stale ones by compare-and-swap. An operator job, never run by a request.
 */
export const sweep = (declared: Sweepable, options?: { readonly batch?: number }) =>
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

/** One column's name and what its sweep found. */
export interface ColumnSweep extends SweepReport {
  readonly table: string;
  readonly column: string;
}

/**
 * Sweeps every column in turn (an operator's whole-deployment pass) and logs one Info summary per
 * column: `scanned`, `resealed`, `unreadable`, ids only. Answers a report per column, in
 * order.
 */
export const sweepAll = (
  columns: ReadonlyArray<Sweepable>,
  options?: { readonly batch?: number },
) =>
  Effect.forEach(columns, (declared) =>
    sweep(declared, options).pipe(
      Effect.map((report): ColumnSweep => ({
        table: declared.table,
        column: declared.column,
        ...report,
      })),
      Effect.tap((report) =>
        Effect.logInfo("awthaq: sealed column swept").pipe(
          Effect.annotateLogs({
            table: report.table,
            column: report.column,
            scanned: report.scanned,
            resealed: report.resealed,
            unreadable: report.unreadable,
          }),
        ),
      ),
    ),
  );

/** Every sealed column a composition writes, as its persistence bundle declares them (`Persistence.sql`). */
export class Deployed extends Context.Service<
  Deployed,
  { readonly columns: ReadonlyArray<Sweepable> }
>()("awthaq/sql/SealedColumn/Deployed") {}

const uniqueColumns = (columns: ReadonlyArray<Sweepable>) => {
  const seen = new Set<string>();
  return columns.filter((declared) => {
    const name = `${declared.table}.${declared.column}`;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
};

/**
 * The operator's whole-deployment pass after a key rotation: the bundle's columns, plus `also`
 * (plugin columns), deduplicated by `table.column`. Never run inside `TenantScope.withTenant`: row-level
 * security would hide rows from the sweep.
 */
export const sweepDeployed = (options?: {
  readonly batch?: number;
  readonly also?: ReadonlyArray<Sweepable>;
}) =>
  Effect.flatMap(Deployed, ({ columns }) =>
    sweepAll(uniqueColumns([...columns, ...(options?.also ?? [])]), options),
  );

/**
 * `codec` over the SQL `Swap` of the same column (`sqlSwap`): what a store adapter builds once per
 * sealed column at layer construction. Requires `SqlClient` and `Encryption`.
 */
export const sqlCodec = (declared: Column<string>) =>
  Effect.flatMap(sqlSwap(declared), (swap) => codec(declared, swap));
