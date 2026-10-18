// @awthaq/sql — UserStoreSql
//
// Plan 02 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `UserStore`, over `UsersRepository` (so
// the unique indexes on `lower(email)` and `phone`, the sealed `metadata` column (CSG-006) and the
// declared-field columns (ADR-EA-035) are unchanged). Plan 17: `metadata` crosses the port as a
// `Sealed` cell (opened, and lazily re-sealed, by `Users`); what an insert wrote is handed back as written.
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

import { Sealed, SqlTransaction, UserStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Model from "effect/unstable/schema/Model";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { User } from "./Models.ts";
import { UsersRepository } from "./Repositories.ts";
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

const columnsOf = (identity: UserStore.IdentityColumns) => ({
  email: Option.getOrNull(identity.email),
  emailVerified: identity.emailVerified,
  phone: Option.getOrNull(identity.phone),
  phoneVerified: identity.phoneVerified,
});

/** A profile write's `Change` as the repository takes it: `undefined` keeps, `null` clears. */
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

const missing: UserStore.CasOutcome = { _tag: "Missing" };
const taken: UserStore.CasOutcome = { _tag: "Taken" };

/** The SQL adapter. Requires the users repository and the client its savepoints run on. */
export const layer = Layer.effect(
  UserStore.UserStore,
  Effect.gen(function* () {
    const repo = yield* UsersRepository;
    const sql = yield* SqlClient.SqlClient;
    const { write, read, once } = SqlStore.make(sql);

    const stored = (row: User) => toStored(row, repo.metadataOf(row));
    const storedOption = (row: Option.Option<User>) => Option.map(row, stored);

    const insertOrHolder: UserStore.UserStoreShape["insertOrHolder"] = (row) =>
      Effect.gen(function* () {
        const insert = yield* repo.models.User.insert
          .makeEffect({
            id: row.id,
            email: Option.getOrNull(row.email),
            phone: Option.getOrNull(row.phone),
            name: row.name,
            metadata: Option.getOrNull(row.metadata),
            image: Option.getOrNull(row.image),
            status: row.status,
            statusReason: Option.getOrNull(row.statusReason),
            suspendedUntil: Option.getOrNull(row.suspendedUntil),
            createdAt: Model.Override(row.createdAt),
            updatedAt: Model.Override(row.updatedAt),
          })
          .pipe(Effect.orDie);
        for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
          const inserted = yield* repo.insertIfAbsent(insert);
          if (Option.isSome(inserted)) {
            const outcome: UserStore.InsertOutcome = {
              _tag: "Inserted",
              // What was just written is handed back as written, never reopened (and never decrypted).
              user: toStored(inserted.value, Option.map(row.metadata, Sealed.plain)),
            };
            return outcome;
          }
          const holder = Option.isSome(row.email)
            ? yield* repo.findByEmail(row.email.value)
            : Option.isSome(row.phone)
              ? yield* repo.findByPhone(row.phone.value)
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
        return yield* Effect.fail(new StoreUnavailable({ operation: "UserStore.insertOrHolder" }));
      }).pipe(once("UserStore.insertOrHolder"));

    const get: UserStore.UserStoreShape["get"] = (id) =>
      repo.findById(id).pipe(
        Effect.map((row) => Option.some(stored(row))),
        Effect.catchTag("NoSuchElementError", () =>
          Effect.succeed(Option.none<UserStore.StoredUser>()),
        ),
        read("UserStore.get"),
      );

    const getByEmail: UserStore.UserStoreShape["getByEmail"] = (lowercased) =>
      repo.findByEmail(lowercased).pipe(Effect.map(storedOption), read("UserStore.getByEmail"));

    const getByPhone: UserStore.UserStoreShape["getByPhone"] = (phone) =>
      repo.findByPhone(phone).pipe(Effect.map(storedOption), read("UserStore.getByPhone"));

    const updateProfile: UserStore.UserStoreShape["updateProfile"] = (input) =>
      repo
        .updateProfile({
          id: input.id,
          name: input.name,
          metadata: change(input.metadata),
          image: change(input.image),
          updatedAt: input.at,
        })
        .pipe(Effect.map(storedOption), write("UserStore.updateProfile"));

    const casIdentity: UserStore.UserStoreShape["casIdentity"] = (input) =>
      SqlTransaction.transactional(sql)(
        repo.casIdentity({
          id: input.id,
          expected: columnsOf(input.expected),
          next: columnsOf(input.next),
          updatedAt: input.at,
        }),
      ).pipe(
        Effect.flatMap((applied) =>
          Option.isSome(applied)
            ? Effect.succeed<UserStore.CasOutcome>({
                _tag: "Updated",
                user: stored(applied.value),
              })
            : // Zero rows: the user is gone, or one of the four columns moved since the caller read.
              repo.findById(input.id).pipe(
                Effect.map((current): UserStore.CasOutcome => ({
                  _tag: "Stale",
                  current: stored(current),
                })),
                Effect.catchTag("NoSuchElementError", () => Effect.succeed(missing)),
              ),
        ),
        // The savepoint rolled back, so the caller's transaction is still usable.
        Effect.catchIf(isUniqueViolation, () => Effect.succeed(taken)),
        once("UserStore.casIdentity"),
      );

    const setStatus: UserStore.UserStoreShape["setStatus"] = (input) =>
      repo
        .setStatus(input.id, {
          status: input.status,
          reason: Option.getOrNull(input.reason),
          until: Option.getOrNull(input.until),
          updatedAt: input.at,
        })
        .pipe(
          Effect.map((row) => Option.some(stored(row))),
          Effect.catchTag("NoSuchElementError", () =>
            Effect.succeed(Option.none<UserStore.StoredUser>()),
          ),
          write("UserStore.setStatus"),
        );

    const remove: UserStore.UserStoreShape["delete"] = (id) =>
      repo.deleteReturning(id).pipe(write("UserStore.delete"));

    const listPage: UserStore.UserStoreShape["listPage"] = ({ after, limit }) =>
      repo.listPage(Option.getOrUndefined(after), limit).pipe(
        Effect.map((page) => ({
          items: page.items.map(stored),
          next: page.nextCursor,
        })),
        read("UserStore.listPage"),
      );

    const readFields: UserStore.UserStoreShape["readFields"] = (id, columns) =>
      repo.readFields(id, columns).pipe(read("UserStore.readFields"));

    const writeFields: UserStore.UserStoreShape["writeFields"] = (input) =>
      repo
        .writeFieldsReturning({
          id: input.id,
          values: input.values,
          returning: input.returning,
          updatedAt: input.at,
        })
        .pipe(write("UserStore.writeFields"));

    return UserStore.UserStore.of({
      insertOrHolder,
      get,
      getByEmail,
      getByPhone,
      updateProfile,
      casIdentity,
      setStatus,
      delete: remove,
      listPage,
      readFields,
      writeFields,
    });
  }),
);
