// @awthaq/sql — UserStoreSql
//
// Plan 02 / plan 16 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `UserStore`. It owns every
// statement over `users` (moved verbatim from the former `Repositories.ts`: `SqlModel.makeRepository`
// CRUD and `SqlSchema` queries), the unique indexes on `lower(email)` and `phone`, the opt-in sealing
// of `metadata` (CSG-006), the declared-field columns (ADR-EA-035), the tenant stamp
// (`Tenant.resolve`, BEH-EA-231) and the failure classification. Plan 17: `metadata` crosses the
// port as a `Sealed` cell (opened, and lazily re-sealed, by `Users`); what an insert wrote is handed
// back as written.
//
// Two layers: `layer` stores `metadata` as given; `layerSealedPii` (CSG-006, opt-in) seals it at rest
// through `Encryption` (AAD `users:<id>:metadata`, the declared `CoreSealedColumns.usersMetadata`).
// Existing plaintext rows stay readable and are sealed on their next read
// (`SealedColumnConfig.resealOnRead`), write, or `SealedColumn.sweepDeployed`. `email` and `name`
// stay plaintext: email is the lookup and uniqueness key.
//
// - `insertOrHolder`: `INSERT ... ON CONFLICT DO NOTHING RETURNING *`, then the holder's read. A
//   holder deleted between the two statements retries the insert (a bounded number of times), and is
//   never a defect (U-8). It never aborts an enclosing Postgres transaction (U-7).
// - `casIdentity`: one `UPDATE ... WHERE <the four identity columns still equal what the caller
//   read> RETURNING *`, in its own savepoint, so a unique violation on the new email or phone is
//   `Taken` and does not abort the caller's transaction. `Stale` and `Missing` are told apart by a
//   read after a zero-row update.
// - `delete` and `writeFields` are single statements over one row, so a user and its declared
//   fields are never separated (U-5, U-6).
// - Retried on a transient failure: only the idempotent primitives (`updateProfile`, `setStatus`,
//   `delete`, `writeFields`: each writes a fixed value). `insertOrHolder` and `casIdentity` are not:
//   repeating either after a success whose answer was lost would change it.
// - Span names are the statements' (`Users.*`, EOTS-008); attributes are ids only.

import { Defects, type Encryption, Sealed, SqlTransaction, Tenant, UserStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Model from "effect/unstable/schema/Model";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlModel from "effect/unstable/sql/SqlModel";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as CoreSealedColumns from "./CoreSealedColumns.ts";
import { type ColumnCodec, sealCell, sealedCell } from "./internal/Cells.ts";
import { traced } from "./internal/traced.ts";
import { makeModels, resolveDialect, UserId, type User } from "./Models.ts";
import * as SealedColumn from "./SealedColumn.ts";
import * as SqlStore from "./SqlStore.ts";
import { isUniqueViolation, StoreUnavailable } from "./StoreFailure.ts";

/** How many times a user insert is retried when the holder it lost to vanished before it could be read. */
const INSERT_ATTEMPTS = 3;

/** A row as the port carries it. `metadata` is the stored cell, unopened (CSG-006). */
const toStored = (
  row: User,
  metadata: Option.Option<Sealed.Sealed<string>>,
): UserStore.StoredUser => ({
  id: row.id,
  email: Option.fromNullOr(row.email),
  emailVerified: row.emailVerified,
  phone: Option.fromNullOr(row.phone),
  phoneVerified: row.phoneVerified,
  name: row.name,
  image: Option.fromNullOr(row.image),
  metadata,
  status: row.status,
  statusReason: Option.fromNullOr(row.statusReason),
  suspendedUntil: Option.fromNullOr(row.suspendedUntil),
  tenantId: Option.fromNullOr(row.tenantId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** A profile write's `Change` as the statement takes it: `undefined` keeps, `null` clears. */
const change = <A>(value: UserStore.Change<A>): A | null | undefined => {
  switch (value._tag) {
    case "Keep":
      return undefined;
    case "Set":
      return value.value;
    case "Clear":
      return null;
  }
};

/**
 * SAM-004: a declared-field cell as its column kind says it should look: `null` is unset, a boolean
 * is a boolean on both dialects (SQLite hands back 0/1), and anything else that does not match the
 * declared kind is a corrupt column, a defect a retry cannot fix.
 */
const userFieldScalar = (
  column: UserStore.UserFieldColumn,
  raw: unknown,
): Effect.Effect<UserStore.UserFieldScalar | null> => {
  if (raw === null || raw === undefined) return Effect.succeed(null);
  switch (column.kind) {
    case "text":
      if (typeof raw === "string") return Effect.succeed(raw);
      break;
    case "real":
      if (typeof raw === "number") return Effect.succeed(raw);
      break;
    case "boolean":
      if (typeof raw === "boolean") return Effect.succeed(raw);
      if (raw === 0 || raw === 1) return Effect.succeed(raw === 1);
      break;
  }
  return Defects.invariantViolation(
    "UserFieldColumnMismatch",
    `awthaq: users column "${column.name}" holds a ${typeof raw}, not a ${column.kind}`,
  );
};

/** The declared-field columns that hold a value, by column name (an unset column is absent). */
const presentFields = (
  entries: ReadonlyArray<readonly [string, UserStore.UserFieldScalar | null]>,
): UserStore.FieldValues =>
  Object.fromEntries(entries.flatMap(([name, value]) => (value === null ? [] : [[name, value]])));

const missing: UserStore.CasOutcome = { _tag: "Missing" };
const taken: UserStore.CasOutcome = { _tag: "Taken" };

const make = (codec: Option.Option<ColumnCodec>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* resolveDialect(sql);
    const models = makeModels(dialect);
    const crud = yield* SqlModel.makeRepository(models.User, {
      tableName: "users",
      spanPrefix: "Users",
      idColumn: "id",
    });
    const { write, read, once } = SqlStore.make(sql);

    // CSG-006: `users.metadata` is the one free-form personal-data column. Without a codec these are
    // no-ops; with one it is sealed on write and the stored cell is handed out as a `Sealed` (opened,
    // and lazily re-sealed, where the domain needs the value).
    const concealMetadata = (id: string, metadata: string | null) => sealCell(codec, id, metadata);
    const stored = (row: User) => toStored(row, sealedCell(codec, row.id, row.metadata));
    const storedOption = (row: Option.Option<User>) => Option.map(row, stored);

    /** `crud.findById` raises `NoSuchElementError` for an absent row; the adapter wants an `Option`. */
    const findByIdOption = (id: UserId) =>
      crud.findById(id).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NoSuchElementError", () => Effect.succeed(Option.none<User>())),
      );

    // ESR-003: JS `toLowerCase()` is the only fold — the bound parameter is
    // normalized here (and stored values already are, by `Users.ts`), while
    // the column side keeps `lower(email)` so `users_email_unique`'s
    // expression index still serves the lookup. SQLite's own `lower()` folds
    // ASCII only, so folding the *parameter* in SQL would miss non-ASCII.
    const findByEmailQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: models.User,
      execute: (email) => sql`SELECT * FROM users WHERE lower(email) = ${email.toLowerCase()}`,
    });

    // FAMS-002: `phone` is compared as stored (callers normalize to E.164 first).
    const findByPhoneQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: models.User,
      execute: (phone) => sql`SELECT * FROM users WHERE phone = ${phone}`,
    });

    // SCP-003: `INSERT ... ON CONFLICT DO NOTHING RETURNING *` — no row when any unique index
    // (email, phone) already holds the value. Unlike an insert + catching `UniqueViolation`, this does
    // not abort an enclosing Postgres transaction, so an idempotent import can keep going after a
    // duplicate.
    const insertIfAbsentQuery = SqlSchema.findAll({
      Request: models.User.insert,
      Result: models.User,
      execute: (request) =>
        sql`INSERT INTO users ${sql.insert(request)} ON CONFLICT DO NOTHING RETURNING *`,
    });

    // BAM-005/BEH-EA-036: keyset page over every user, oldest first. Reads `limit + 1` rows: the
    // extra one only proves a next page exists, so an exactly-full final page never invents a cursor.
    const usersPage = SqlSchema.findAll({
      Request: Schema.Struct({
        cursorCreatedAt: models.wire.nullableDateTime,
        cursorId: Schema.NullOr(Schema.String),
        limit: Schema.Int,
      }),
      Result: models.User,
      execute: (request) =>
        request.cursorCreatedAt === null || request.cursorId === null
          ? sql`SELECT * FROM users ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit + 1}`
          : sql`SELECT * FROM users
                  WHERE "createdAt" > ${request.cursorCreatedAt}
                     OR ("createdAt" = ${request.cursorCreatedAt} AND id > ${request.cursorId})
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit + 1}`,
    });

    // GC-004: one `UPDATE ... RETURNING *` on `name`, and on `metadata`/`image` when given (`null`
    // clears, `undefined` leaves the column), so a row deleted since the caller last read it is
    // `None` — not the defect the generic `update` reports it as — and no other column is rewritten
    // from a stale read. The flags bind through the dialect's boolean codec like `verified` below,
    // and `metadata` is sealed (with a codec) only when it is set.
    const updateProfileQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: UserId,
        name: Schema.String,
        setMetadata: models.wire.boolean,
        metadata: Schema.NullOr(Schema.String),
        setImage: models.wire.boolean,
        image: Schema.NullOr(Schema.String),
        updatedAt: models.wire.dateTime,
      }),
      Result: models.User,
      execute: (r) =>
        sql`UPDATE users SET name = ${r.name}, metadata = CASE WHEN ${r.setMetadata} THEN ${r.metadata} ELSE metadata END, image = CASE WHEN ${r.setImage} THEN ${r.image} ELSE image END, "updatedAt" = ${r.updatedAt} WHERE id = ${r.id} RETURNING *`,
    });

    // SCP-001: `status`, its reason and expiry have no other writer.
    const setStatusQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: UserId,
        status: Schema.Literals(["active", "suspended"]),
        reason: Schema.NullOr(Schema.String),
        until: models.wire.nullableDateTime,
        updatedAt: models.wire.dateTime,
      }),
      Result: models.User,
      execute: (r) =>
        sql`UPDATE users SET status = ${r.status}, "statusReason" = ${r.reason}, "suspendedUntil" = ${r.until}, "updatedAt" = ${r.updatedAt} WHERE id = ${r.id} RETURNING *`,
    });

    // `DELETE ... RETURNING id`, so the caller learns whether a row was removed (the declared fields
    // are columns of the same row, so they go with it).
    const deleteReturningQuery = SqlSchema.findAll({
      Request: UserId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (id) => sql`DELETE FROM users WHERE id = ${id} RETURNING id`,
    });

    // The compare-and-swap behind every identity transition. One `UPDATE ... WHERE id = ? AND <the
    // four identity columns still equal what the caller read> RETURNING *`: no row when the user is
    // absent or one of them moved (the caller re-reads to tell which). A unique violation on the new
    // email or phone surfaces as `SqlError`; the primitive wraps the statement in its own savepoint.
    const casIdentityQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: UserId,
        expectedEmail: Schema.NullOr(Schema.String),
        expectedEmailVerified: models.wire.boolean,
        expectedPhone: Schema.NullOr(Schema.String),
        expectedPhoneVerified: models.wire.boolean,
        email: Schema.NullOr(Schema.String),
        emailVerified: models.wire.boolean,
        phone: Schema.NullOr(Schema.String),
        phoneVerified: models.wire.boolean,
        updatedAt: models.wire.dateTime,
      }),
      Result: models.User,
      // `IS NOT DISTINCT FROM` is Postgres' null-safe equality; SQLite spells it `IS`.
      execute: (r) =>
        dialect === "pg"
          ? sql`UPDATE users SET email = ${r.email}, "emailVerified" = ${r.emailVerified}, phone = ${r.phone}, "phoneVerified" = ${r.phoneVerified}, "updatedAt" = ${r.updatedAt}
                WHERE id = ${r.id} AND email IS NOT DISTINCT FROM ${r.expectedEmail} AND "emailVerified" = ${r.expectedEmailVerified}
                  AND phone IS NOT DISTINCT FROM ${r.expectedPhone} AND "phoneVerified" = ${r.expectedPhoneVerified} RETURNING *`
          : sql`UPDATE users SET email = ${r.email}, "emailVerified" = ${r.emailVerified}, phone = ${r.phone}, "phoneVerified" = ${r.phoneVerified}, "updatedAt" = ${r.updatedAt}
                WHERE id = ${r.id} AND email IS ${r.expectedEmail} AND "emailVerified" = ${r.expectedEmailVerified}
                  AND phone IS ${r.expectedPhone} AND "phoneVerified" = ${r.expectedPhoneVerified} RETURNING *`,
    });

    // SAM-004 (BEH-EA-040): the plugin-declared columns are outside the model (they exist only when
    // a composition declares them), so they are read and written with plain statements over
    // identifiers the registry supplied. Column names come from the composition's own registry,
    // never from a request, and are always quoted identifiers. Booleans come back as booleans on
    // both dialects (SQLite stores 0/1).
    const readFields = (id: UserId, columns: ReadonlyArray<UserStore.UserFieldColumn>) =>
      columns.length === 0
        ? Effect.map(
            findByIdOption(id),
            Option.map((): UserStore.FieldValues => ({})),
          )
        : sql`SELECT ${sql.csv(columns.map((column) => sql`${sql(column.name)}`))} FROM users WHERE id = ${id}`.pipe(
            Effect.flatMap((rows) => {
              const [row] = rows;
              if (row === undefined) return Effect.succeed(Option.none<UserStore.FieldValues>());
              return Effect.forEach(columns, (column) =>
                userFieldScalar(column, row[column.name]).pipe(
                  Effect.map((value): readonly [string, UserStore.UserFieldScalar | null] => [
                    column.name,
                    value,
                  ]),
                ),
              ).pipe(Effect.map((entries) => Option.some(presentFields(entries))));
            }),
            traced("Users.readFields", { id }),
          );

    // The same write as the generic update, plus `updatedAt`, answering the `returning` columns as
    // they are after the write from the one `UPDATE ... RETURNING` (no row when there is no such
    // user, and then nothing was written).
    const encodeDateTime = Schema.encodeSync(models.wire.dateTime);
    const writeFields = (input: {
      readonly id: UserId;
      readonly values: Readonly<Record<string, UserStore.UserFieldScalar | null>>;
      readonly returning: ReadonlyArray<UserStore.UserFieldColumn>;
      readonly at: Parameters<typeof encodeDateTime>[0];
    }) => {
      const values = Object.fromEntries([
        ...Object.entries(input.values).map(([name, value]) => [
          name,
          dialect === "sqlite" && typeof value === "boolean" ? (value ? 1 : 0) : value,
        ]),
        ["updatedAt", encodeDateTime(input.at)],
      ]);
      const returning =
        input.returning.length === 0
          ? sql`id`
          : sql.csv(input.returning.map((column) => sql`${sql(column.name)}`));
      return sql`UPDATE users SET ${sql.update(values)} WHERE id = ${input.id} RETURNING ${returning}`.pipe(
        Effect.flatMap((rows) => {
          const [row] = rows;
          if (row === undefined) return Effect.succeed(Option.none<UserStore.FieldValues>());
          return Effect.forEach(input.returning, (column) =>
            userFieldScalar(column, row[column.name]).pipe(
              Effect.map((value): readonly [string, UserStore.UserFieldScalar | null] => [
                column.name,
                value,
              ]),
            ),
          ).pipe(Effect.map((entries) => Option.some(presentFields(entries))));
        }),
        traced("Users.writeFieldsReturning", { id: input.id }),
      );
    };

    return UserStore.UserStore.of({
      insertOrHolder: (row) =>
        Effect.gen(function* () {
          const tenantId = yield* Tenant.resolve(Option.none());
          const metadata = yield* concealMetadata(row.id, Option.getOrNull(row.metadata));
          const insert = yield* models.User.insert
            .makeEffect({
              id: row.id,
              email: Option.getOrNull(row.email),
              phone: Option.getOrNull(row.phone),
              name: row.name,
              metadata,
              image: Option.getOrNull(row.image),
              tenantId: Option.getOrNull(tenantId),
              status: row.status,
              statusReason: Option.getOrNull(row.statusReason),
              suspendedUntil: Option.getOrNull(row.suspendedUntil),
              createdAt: Model.Override(row.createdAt),
              updatedAt: Model.Override(row.updatedAt),
            })
            .pipe(Effect.orDie);
          for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
            const [inserted] = yield* insertIfAbsentQuery(insert).pipe(
              traced("Users.insertIfAbsent"),
            );
            if (inserted !== undefined) {
              const outcome: UserStore.InsertOutcome = {
                _tag: "Inserted",
                // What was just written is handed back as written, never reopened (and never decrypted).
                user: toStored(inserted, Option.map(row.metadata, Sealed.plain)),
              };
              return outcome;
            }
            const holder = Option.isSome(row.email)
              ? yield* findByEmailQuery(row.email.value).pipe(traced("Users.findByEmail"))
              : Option.isSome(row.phone)
                ? yield* findByPhoneQuery(row.phone.value).pipe(traced("Users.findByPhone"))
                : Option.none<User>();
            if (Option.isSome(holder)) {
              const outcome: UserStore.InsertOutcome = {
                _tag: "Held",
                holder: stored(holder.value),
              };
              return outcome;
            }
            // The holder was deleted between the two statements: the key is free again, so try again.
          }
          return yield* Effect.fail(
            new StoreUnavailable({ operation: "UserStore.insertOrHolder" }),
          );
        }).pipe(once("UserStore.insertOrHolder")),

      get: (id) => findByIdOption(id).pipe(Effect.map(storedOption), read("UserStore.get")),

      getByEmail: (lowercased) =>
        findByEmailQuery(lowercased).pipe(
          traced("Users.findByEmail"),
          Effect.map(storedOption),
          read("UserStore.getByEmail"),
        ),

      getByPhone: (phone) =>
        findByPhoneQuery(phone).pipe(
          traced("Users.findByPhone"),
          Effect.map(storedOption),
          read("UserStore.getByPhone"),
        ),

      updateProfile: (input) =>
        Effect.gen(function* () {
          const metadata = change(input.metadata);
          const sealed = metadata === undefined ? null : yield* concealMetadata(input.id, metadata);
          const image = change(input.image);
          return yield* updateProfileQuery({
            id: input.id,
            name: input.name,
            setMetadata: metadata !== undefined,
            metadata: sealed,
            setImage: image !== undefined,
            image: image ?? null,
            updatedAt: input.at,
          });
        }).pipe(
          traced("Users.updateProfile", { id: input.id }),
          Effect.map(storedOption),
          write("UserStore.updateProfile"),
        ),

      casIdentity: (input) =>
        SqlTransaction.transactional(sql)(
          casIdentityQuery({
            id: input.id,
            expectedEmail: Option.getOrNull(input.expected.email),
            expectedEmailVerified: input.expected.emailVerified,
            expectedPhone: Option.getOrNull(input.expected.phone),
            expectedPhoneVerified: input.expected.phoneVerified,
            email: Option.getOrNull(input.next.email),
            emailVerified: input.next.emailVerified,
            phone: Option.getOrNull(input.next.phone),
            phoneVerified: input.next.phoneVerified,
            updatedAt: input.at,
          }).pipe(traced("Users.casIdentity", { id: input.id })),
        ).pipe(
          Effect.flatMap((applied) =>
            Option.isSome(applied)
              ? Effect.succeed<UserStore.CasOutcome>({
                  _tag: "Updated",
                  user: stored(applied.value),
                })
              : // Zero rows: the user is gone, or one of the four columns moved since the caller read.
                findByIdOption(input.id).pipe(
                  Effect.map((current): UserStore.CasOutcome =>
                    Option.isSome(current)
                      ? { _tag: "Stale", current: stored(current.value) }
                      : missing,
                  ),
                ),
          ),
          // The savepoint rolled back, so the caller's transaction is still usable.
          Effect.catchIf(isUniqueViolation, () => Effect.succeed(taken)),
          once("UserStore.casIdentity"),
        ),

      setStatus: (input) =>
        setStatusQuery({
          id: input.id,
          status: input.status,
          reason: Option.getOrNull(input.reason),
          until: Option.getOrNull(input.until),
          updatedAt: input.at,
        }).pipe(
          traced("Users.setStatus", { id: input.id }),
          Effect.map(storedOption),
          write("UserStore.setStatus"),
        ),

      delete: (id) =>
        deleteReturningQuery(id).pipe(
          Effect.map((rows) => rows.length > 0),
          traced("Users.deleteReturning", { id }),
          write("UserStore.delete"),
        ),

      listPage: ({ after, limit }) =>
        usersPage({
          cursorCreatedAt: Option.match(after, { onNone: () => null, onSome: (c) => c.createdAt }),
          cursorId: Option.match(after, { onNone: () => null, onSome: (c) => c.id }),
          limit,
        }).pipe(
          traced("Users.listPage"),
          Effect.map((rows) => {
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            return {
              items: items.map(stored),
              next:
                rows.length > limit && last !== undefined
                  ? Option.some({ createdAt: last.createdAt, id: last.id })
                  : Option.none(),
            };
          }),
          read("UserStore.listPage"),
        ),

      readFields: (id, columns) => readFields(id, columns).pipe(read("UserStore.readFields")),

      writeFields: (input) =>
        writeFields({
          id: input.id,
          values: input.values,
          returning: input.returning,
          at: input.at,
        }).pipe(write("UserStore.writeFields")),
    });
  });

/** What the sealing variant requires: the one client, and the `Encryption` the metadata is sealed with. */
export type SealedRequires = SqlClient.SqlClient | Encryption.Encryption;

/** `metadata` stored as given. Requires `SqlClient`. */
export const layer = Layer.effect(UserStore.UserStore, make(Option.none()));

/** CSG-006 (opt-in): `metadata` sealed at rest (AAD `users:<id>:metadata`). Requires `SqlClient | Encryption`. */
export const layerSealedPii = Layer.effect(
  UserStore.UserStore,
  Effect.flatMap(SealedColumn.sqlCodec(CoreSealedColumns.usersMetadata), (codec) =>
    make(Option.some(codec)),
  ),
);
