// @awthaq/core — Users
//
// spec/behaviors/06-domain-users-accounts.md, BEH-EA-041, BEH-EA-042.
// Two `Layer`s over the same `UsersShape`: `layerMemory` (a `Ref`) and
// `layerSql` (`@awthaq/sql`'s `Model.Class`/repository, BEH-EA-033–036)
// — neither changes this service's public interface, the same deferral
// `Migrations.ts` documents for the persistence stratum generally.

import { Models as SqlModels, Repositories as SqlRepositories } from "@awthaq/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import { now } from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

/** BEH-EA-033: the id every `Account`/`Session` foreign-keys to. */
export type UserId = string & Brand.Brand<"UserId">;
export const UserId = Brand.nominal<UserId>();

export interface UserRecord {
  readonly id: UserId;
  /** BEH-EA-041: always the lower-cased form of whatever email was given. */
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export class EmailAlreadyExists extends Data.TaggedError("EmailAlreadyExists")<{
  readonly message: string;
  readonly email: string;
}> {}

export class UserNotFound extends Data.TaggedError("UserNotFound")<{
  readonly message: string;
  readonly id: UserId;
}> {}

/**
 * BEH-EA-041/042: no operation below accepts `emailVerified` as input —
 * `create` always starts it `false` (supplier-authority default), and
 * `verifyEmail` is the only transition, one-directional and idempotent.
 * `updateProfile`'s input type is `{ name }` alone, so there is no generic
 * write path a plugin-level caller could use to flip it back to `false`.
 */
export interface UsersShape {
  readonly create: (input: {
    readonly email: string;
    readonly name: string;
  }) => Effect.Effect<UserRecord, EmailAlreadyExists | PlatformError.PlatformError>;
  readonly findById: (id: UserId) => Effect.Effect<UserRecord, UserNotFound>;
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<UserRecord>>;
  readonly updateProfile: (
    id: UserId,
    input: { readonly name: string },
  ) => Effect.Effect<UserRecord, UserNotFound>;
  readonly verifyEmail: (id: UserId) => Effect.Effect<UserRecord, UserNotFound>;
  readonly delete: (id: UserId) => Effect.Effect<void, UserNotFound>;
}

export class Users extends Context.Service<Users, UsersShape>()("awthaq/core/Users") {}

interface State {
  readonly byId: HashMap.HashMap<UserId, UserRecord>;
  readonly byEmail: HashMap.HashMap<string, UserId>;
}

const emptyState: State = { byId: HashMap.empty(), byEmail: HashMap.empty() };

/** BEH-EA-046: dropping a user's own row is this Layer's whole job — cascading to `Accounts`/`Sessions` is each of those services' own responsibility, triggered by the caller that also calls `Users.delete`, not by this module reaching into them. */
export const layerMemory: Layer.Layer<Users, never, Crypto.Crypto> = Layer.effect(
  Users,
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const crypto = yield* Crypto.Crypto;

    const findById: UsersShape["findById"] = (id) =>
      Ref.get(state).pipe(
        Effect.flatMap((s) =>
          Option.match(HashMap.get(s.byId, id), {
            onNone: () =>
              Effect.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
            onSome: Effect.succeed,
          }),
        ),
      );

    const findByEmail: UsersShape["findByEmail"] = (email) =>
      Ref.get(state)
        .pipe(Effect.map((s) => HashMap.get(s.byEmail, email.toLowerCase())))
        .pipe(
          Effect.flatMap((userId) =>
            Option.match(userId, {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (id) => Ref.get(state).pipe(Effect.map((s) => HashMap.get(s.byId, id))),
            }),
          ),
        );

    const create: UsersShape["create"] = Effect.fnUntraced(function* (input) {
      const email = input.email.toLowerCase();
      const id = UserId(yield* crypto.randomUUIDv7);
      const timestamp = yield* now;
      const record: UserRecord = {
        id,
        email,
        emailVerified: false,
        name: input.name,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const outcome = yield* Ref.modify(
        state,
        (s): readonly [Result.Result<UserRecord, EmailAlreadyExists>, State] => {
          if (HashMap.has(s.byEmail, email)) {
            return [
              Result.fail(
                new EmailAlreadyExists({
                  message: `awthaq: email already exists: ${email}`,
                  email,
                }),
              ),
              s,
            ] as const;
          }
          return [
            Result.succeed(record),
            { byId: HashMap.set(s.byId, id, record), byEmail: HashMap.set(s.byEmail, email, id) },
          ] as const;
        },
      );
      return yield* Effect.fromResult(outcome);
    });

    const updateProfile: UsersShape["updateProfile"] = (id, input) =>
      Ref.modify(state, (s): readonly [Result.Result<UserRecord, UserNotFound>, State] => {
        const existing = HashMap.get(s.byId, id);
        if (Option.isNone(existing)) {
          return [
            Result.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
            s,
          ] as const;
        }
        const updated: UserRecord = { ...existing.value, name: input.name };
        return [Result.succeed(updated), { ...s, byId: HashMap.set(s.byId, id, updated) }] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    const verifyEmail: UsersShape["verifyEmail"] = (id) =>
      Ref.modify(state, (s): readonly [Result.Result<UserRecord, UserNotFound>, State] => {
        const existing = HashMap.get(s.byId, id);
        if (Option.isNone(existing)) {
          return [
            Result.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
            s,
          ] as const;
        }
        if (existing.value.emailVerified) {
          return [Result.succeed(existing.value), s] as const;
        }
        const updated: UserRecord = { ...existing.value, emailVerified: true };
        return [Result.succeed(updated), { ...s, byId: HashMap.set(s.byId, id, updated) }] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    const delete_: UsersShape["delete"] = (id) =>
      Ref.modify(state, (s): readonly [Result.Result<void, UserNotFound>, State] => {
        const existing = HashMap.get(s.byId, id);
        if (Option.isNone(existing)) {
          return [
            Result.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
            s,
          ] as const;
        }
        const ok: Result.Result<void, UserNotFound> = Result.succeed(undefined);
        return [
          ok,
          {
            byId: HashMap.remove(s.byId, id),
            byEmail: HashMap.remove(s.byEmail, existing.value.email),
          },
        ] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    return { create, findById, findByEmail, updateProfile, verifyEmail, delete: delete_ };
  }),
);

const toUserRecord = (row: SqlModels.User): UserRecord => ({
  id: UserId(row.id),
  email: row.email,
  emailVerified: row.emailVerified,
  name: row.name,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * BEH-EA-041's uniqueness is a real database constraint here (a `UNIQUE`
 * index on `lower(email)`, declared by whichever schema/migration creates
 * the `users` table) rather than `layerMemory`'s in-process `HashMap`
 * check — a duplicate `create` surfaces as `SqlError`'s `UniqueViolation`
 * reason, mapped to `EmailAlreadyExists`; every other repository failure
 * (a schema mismatch, a dropped connection) is a genuine defect, not a
 * domain error this service's callers are meant to recover from, so it is
 * left to `die`.
 */
export const layerSql: Layer.Layer<Users, never, SqlRepositories.UsersRepository> = Layer.effect(
  Users,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.UsersRepository;

    const create: UsersShape["create"] = Effect.fnUntraced(function* (input) {
      const email = input.email.toLowerCase();
      const insert = yield* SqlModels.User.insert
        .makeEffect({ email, name: input.name })
        .pipe(Effect.orDie);
      const row = yield* repo.insert(insert).pipe(
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(
                new EmailAlreadyExists({
                  message: `awthaq: email already exists: ${email}`,
                  email,
                }),
              )
            : Effect.die(error),
        ),
        Effect.catchTag("SchemaError", Effect.die),
      );
      return toUserRecord(row);
    });

    const findById: UsersShape["findById"] = (id) =>
      repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
        Effect.map(toUserRecord),
      );

    const findByEmail: UsersShape["findByEmail"] = (email) =>
      repo.findByEmail(email).pipe(Effect.map(Option.map(toUserRecord)), Effect.orDie);

    const updateProfile: UsersShape["updateProfile"] = Effect.fnUntraced(function* (id, input) {
      const existing = yield* findById(id);
      const update = yield* SqlModels.User.update
        .makeEffect({ id, email: existing.email, name: input.name })
        .pipe(Effect.orDie);
      const row = yield* repo.update(update).pipe(Effect.orDie);
      return toUserRecord(row);
    });

    // `emailVerified` is excluded from the generic `update`/`jsonUpdate`
    // variants (BEH-EA-042) — flipping it goes through the repository's own
    // dedicated `verifyEmail` operation, which is the only write that can
    // touch that column at all.
    const verifyEmail: UsersShape["verifyEmail"] = Effect.fnUntraced(function* (id) {
      const existing = yield* findById(id);
      if (existing.emailVerified) return existing;
      const row = yield* repo.verifyEmail(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
      );
      return toUserRecord(row);
    });

    const delete_: UsersShape["delete"] = Effect.fnUntraced(function* (id) {
      yield* findById(id);
      yield* repo.delete(id).pipe(Effect.orDie);
    });

    return { create, findById, findByEmail, updateProfile, verifyEmail, delete: delete_ };
  }),
);
