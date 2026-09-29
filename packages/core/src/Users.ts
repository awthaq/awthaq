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
import * as DateTime from "effect/DateTime";
import { now } from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as HookPoint from "./HookPoint.ts";
import * as Hooks from "./Hooks.ts";

/**
 * JH-001/PERS-001 (`packages/organization/src/OrganizationHooks.ts`'s own
 * `veto` helper — the same translation, one-point version): BEH-EA-090
 * requires a veto abort to reach the caller as a typed `HookAborted`, not
 * the bare `HookAbort` a tap itself fails with.
 */
const beforeUserDeleteVeto = <A>(
  effect: Effect.Effect<A, HookPoint.HookAbort>,
): Effect.Effect<A, HookPoint.HookAborted> =>
  effect.pipe(
    Effect.catchTag(
      "HookAbort",
      (abort) =>
        new HookPoint.HookAborted({
          point: "auth.user.beforeDelete",
          code: abort.code,
          message: abort.message,
        }),
    ),
  );

/** BEH-EA-033: the id every `Account`/`Session` foreign-keys to. INV-EA-018: an identifier, never a capability — UUIDv7, time-ordered and partially predictable, so nothing may act on it without a credential's proof. */
// MA-008: the brand is declared once, in `@awthaq/sql`; this keeps only a nominal constructor.
export type UserId = SqlModels.UserId;
export const UserId = Brand.nominal<UserId>();

export interface UserRecord {
  readonly id: UserId;
  /** BEH-EA-041: always the lower-cased form of whatever email was given. */
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  /**
   * AOMS-002: free-form, opaque per-user metadata (e.g. a JSON-encoded
   * string) — mirrors `@awthaq/organization`'s own
   * `OrganizationRecord.metadata`. This service never parses or
   * interprets it; an IdP migration (Auth0's `user_metadata`/
   * `app_metadata`) or an application-level claims-enrichment hook is
   * exactly the kind of caller that reads/writes it.
   */
  readonly metadata: Option.Option<string>;
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
    readonly metadata?: string;
  }) => Effect.Effect<UserRecord, EmailAlreadyExists | PlatformError.PlatformError>;
  readonly findById: (id: UserId) => Effect.Effect<UserRecord, UserNotFound>;
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<UserRecord>>;
  /** AOMS-002: `metadata` left `undefined` leaves it untouched; `null` clears it. */
  readonly updateProfile: (
    id: UserId,
    input: { readonly name: string; readonly metadata?: string | null },
  ) => Effect.Effect<UserRecord, UserNotFound>;
  readonly verifyEmail: (id: UserId) => Effect.Effect<UserRecord, UserNotFound>;
  /**
   * AOMS-006/CSG-002 (.issues/high): consults `Hooks.BeforeUserDelete`
   * (BEH-EA-095's own worked example — an Invite-purge veto) after the
   * existence check, before the row is actually removed; a tap's abort
   * surfaces as `HookPoint.HookAborted`, never a bare defect.
   */
  readonly delete: (id: UserId) => Effect.Effect<void, UserNotFound | HookPoint.HookAborted>;
  /**
   * BAM-005/BEH-EA-036: the admin surface's user listing — keyset-paginated on
   * `(createdAt, id)`, oldest first, opaque cursor in / `nextCursor` out, never an
   * offset, never more than `limit + 1` rows read (`limit` defaults to 50).
   */
  readonly list: (input?: {
    readonly cursor?: UserCursor | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<UsersPage>;
}

/** BAM-005/BEH-EA-036: the keyset position of `Users.list`. */
export interface UserCursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

export interface UsersPage {
  readonly items: ReadonlyArray<UserRecord>;
  /** `None` on the last page. */
  readonly nextCursor: Option.Option<UserCursor>;
}

const DEFAULT_LIST_LIMIT = 50;

export class Users extends Context.Service<Users, UsersShape>()("awthaq/core/Users") {}

interface State {
  readonly byId: HashMap.HashMap<UserId, UserRecord>;
  readonly byEmail: HashMap.HashMap<string, UserId>;
}

/**
 * AAPS-005: fires `Hooks.AfterUserAttributesChanged` (an observe point) when a
 * policy-readable attribute really changed. Read through `Effect.serviceOption`
 * so it adds nothing to either layer's requirements — a composition that does
 * not provide the point simply announces nothing.
 */
const attributesChangedAnnouncer = Effect.gen(function* () {
  const hook = yield* Effect.serviceOption(Hooks.AfterUserAttributesChanged);
  return (userId: UserId, attributes: ReadonlyArray<string>): Effect.Effect<void> =>
    Option.isSome(hook) ? hook.value.run({ userId, attributes }) : Effect.void;
});

const emptyState: State = { byId: HashMap.empty(), byEmail: HashMap.empty() };

/**
 * TRBS-005: single-process, test-grade storage — see `Sessions.layerMemory`. Use `layerSql` for any multi-instance deployment.
 *
 * BEH-EA-046: dropping a user's own row is this Layer's whole job — cascading to `Accounts`/`Sessions` is each of those services' own responsibility, triggered by the caller that also calls `Users.delete`, not by this module reaching into them.
 */
export const layerMemory: Layer.Layer<Users, never, Crypto.Crypto | Hooks.BeforeUserDelete> =
  Layer.effect(
    Users,
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const crypto = yield* Crypto.Crypto;
      const beforeDelete = yield* Hooks.BeforeUserDelete;
      const announce = yield* attributesChangedAnnouncer;

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
          metadata: Option.fromNullishOr(input.metadata),
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
          const updated: UserRecord = {
            ...existing.value,
            name: input.name,
            metadata:
              input.metadata === undefined
                ? existing.value.metadata
                : Option.fromNullishOr(input.metadata),
          };
          return [
            Result.succeed(updated),
            { ...s, byId: HashMap.set(s.byId, id, updated) },
          ] as const;
        }).pipe(
          Effect.flatMap(Effect.fromResult),
          Effect.tap((record) => announce(record.id, ["name"])),
        );

      const verifyEmail: UsersShape["verifyEmail"] = (id) =>
        Ref.modify(
          state,
          (s): readonly [Result.Result<readonly [UserRecord, boolean], UserNotFound>, State] => {
            const existing = HashMap.get(s.byId, id);
            if (Option.isNone(existing)) {
              return [
                Result.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
                s,
              ] as const;
            }
            if (existing.value.emailVerified) {
              return [Result.succeed([existing.value, false] as const), s] as const;
            }
            const updated: UserRecord = { ...existing.value, emailVerified: true };
            return [
              Result.succeed([updated, true] as const),
              { ...s, byId: HashMap.set(s.byId, id, updated) },
            ] as const;
          },
        ).pipe(
          Effect.flatMap(Effect.fromResult),
          Effect.tap(([record, changed]) =>
            changed ? announce(record.id, ["emailVerified"]) : Effect.void,
          ),
          Effect.map(([record]) => record),
        );

      // AOMS-006/CSG-002: `Hooks.BeforeUserDelete` runs between the
      // existence read and the actual removal — ticket 03's own accepted
      // trade-off, splitting what used to be one atomic `Ref.modify` into
      // read-then-hook-then-update. Nothing else in this in-memory,
      // test-only layer observes a concurrent mutation in that gap (a
      // single-threaded Effect fiber has no true concurrent writer unless a
      // tap itself yields to one).
      const delete_: UsersShape["delete"] = (id) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s.byId, id)));
          if (Option.isNone(existing)) {
            return yield* Effect.fail(
              new UserNotFound({ message: `awthaq: no such user: ${id}`, id }),
            );
          }
          yield* beforeUserDeleteVeto(beforeDelete.run({ id, email: existing.value.email }));
          yield* Ref.update(state, (s) => ({
            byId: HashMap.remove(s.byId, id),
            byEmail: HashMap.remove(s.byEmail, existing.value.email),
          }));
        });

      const list: UsersShape["list"] = (input) =>
        Ref.get(state).pipe(
          Effect.map((s) => {
            const limit = input?.limit ?? DEFAULT_LIST_LIMIT;
            const cursor = input?.cursor;
            const after = Array.from(HashMap.values(s.byId))
              .sort((a, b) => {
                const byTime =
                  DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt);
                return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
              })
              .filter(
                (user) =>
                  cursor === undefined ||
                  DateTime.toEpochMillis(user.createdAt) >
                    DateTime.toEpochMillis(cursor.createdAt) ||
                  (DateTime.toEpochMillis(user.createdAt) ===
                    DateTime.toEpochMillis(cursor.createdAt) &&
                    user.id > cursor.id),
              );
            const items = after.slice(0, limit);
            const last = items.at(-1);
            return {
              items,
              nextCursor:
                after.length > limit && last !== undefined
                  ? Option.some({ createdAt: last.createdAt, id: last.id })
                  : Option.none(),
            };
          }),
        );

      return { create, findById, findByEmail, updateProfile, verifyEmail, delete: delete_, list };
    }),
  );

const toUserRecord = (row: SqlModels.User): UserRecord => ({
  id: UserId(row.id),
  email: row.email,
  emailVerified: row.emailVerified,
  name: row.name,
  metadata: Option.fromNullOr(row.metadata),
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
export const layerSql: Layer.Layer<
  Users,
  never,
  SqlRepositories.UsersRepository | Hooks.BeforeUserDelete
> = Layer.effect(
  Users,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.UsersRepository;
    const beforeDelete = yield* Hooks.BeforeUserDelete;
    const announce = yield* attributesChangedAnnouncer;

    const create: UsersShape["create"] = Effect.fnUntraced(function* (input) {
      const email = input.email.toLowerCase();
      const insert = yield* repo.models.User.insert
        .makeEffect({ email, name: input.name, metadata: input.metadata ?? null })
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
      repo
        .findByEmail(email.toLowerCase())
        .pipe(Effect.map(Option.map(toUserRecord)), Effect.orDie);

    const updateProfile: UsersShape["updateProfile"] = Effect.fnUntraced(function* (id, input) {
      const existing = yield* findById(id);
      const nextMetadata =
        input.metadata === undefined ? Option.getOrNull(existing.metadata) : input.metadata;
      const update = yield* repo.models.User.update
        .makeEffect({ id, email: existing.email, name: input.name, metadata: nextMetadata })
        .pipe(Effect.orDie);
      const row = yield* repo.update(update).pipe(Effect.orDie);
      yield* announce(id, ["name"]);
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
      yield* announce(id, ["emailVerified"]);
      return toUserRecord(row);
    });

    const delete_: UsersShape["delete"] = Effect.fnUntraced(function* (id) {
      const found = yield* findById(id);
      yield* beforeUserDeleteVeto(beforeDelete.run({ id, email: found.email }));
      yield* repo.delete(id).pipe(Effect.orDie);
    });

    const list: UsersShape["list"] = (input) =>
      repo.listPage(input?.cursor, input?.limit).pipe(
        Effect.map((page) => ({
          items: page.items.map(toUserRecord),
          nextCursor: page.nextCursor,
        })),
        Effect.orDie,
      );

    return { create, findById, findByEmail, updateProfile, verifyEmail, delete: delete_, list };
  }),
);
