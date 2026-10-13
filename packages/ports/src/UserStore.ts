// @awthaq/ports — UserStore
//
// Plan 02 (ADR-EA-041): the store port under `Users`. `Users` (core) owns every domain rule: the
// identity union, the lower-casing of an email, the verified-flag transitions and what each may
// change (BEH-EA-041/042), the uniqueness errors, the id and the clock, the announcements
// (`AfterUserAttributesChanged`), the limit of a page and the validation of declared fields. This
// port owns only persistence, and every primitive is atomic by contract, on every adapter
// (`StoreContract.users`).
//
// A user's identity columns (`email`, `emailVerified`, `phone`, `phoneVerified`) change only through
// `casIdentity`, a compare-and-swap against the values the caller read: a concurrent change is
// reported (`Stale`), never overwritten, so a transition and its announcement happen exactly once.
// A user and its declared fields (ADR-EA-035: columns of the same row) are removed together, and a
// field write returns its own post-state, so neither can orphan the other.
//
// The `Ref` adapter here is single-process and test-grade (TRBS-005). Production composes the SQL
// adapter (`@awthaq/sql` `UserStoreSql`) through `Persistence.sql()`.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { E164, UserId } from "./Ids.ts";
import type { StoreUnavailable } from "./Store.ts";
import * as Tenant from "./Tenant.ts";

/** A user as the store keeps it: the identity flattened into its columns, so both uniqueness rules stay real constraints. */
export interface StoredUser {
  readonly id: UserId;
  /** Always lower-cased by the domain; unique among the users that have one. */
  readonly email: Option.Option<string>;
  readonly emailVerified: boolean;
  /** Unique among the users that have one. */
  readonly phone: Option.Option<E164>;
  readonly phoneVerified: boolean;
  readonly name: string;
  readonly image: Option.Option<string>;
  /** The adapter seals it at rest where it encrypts (CSG-006). */
  readonly metadata: Option.Option<string>;
  readonly status: "active" | "suspended";
  readonly statusReason: Option.Option<string>;
  readonly suspendedUntil: Option.Option<DateTime.Utc>;
  /** Stamped by the adapter from the ambient tenant (BEH-EA-231, attribution only: DRS-005). */
  readonly tenantId: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

/** What `insertOrHolder` writes; the store adds the tenant. */
export type NewUser = Omit<StoredUser, "tenantId">;

/** What a profile write does to an optional column. */
export type Change<A> =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Set"; readonly value: A }
  | { readonly _tag: "Clear" };

/** The identity columns a `casIdentity` compares and writes. */
export interface IdentityColumns {
  readonly email: Option.Option<string>;
  readonly emailVerified: boolean;
  readonly phone: Option.Option<E164>;
  readonly phoneVerified: boolean;
}

/** SAM-004: a plugin-declared user-field column and how its scalar is stored. */
export interface UserFieldColumn {
  readonly name: string;
  readonly kind: "text" | "real" | "boolean";
}

/** SAM-004: what a user-field column holds. */
export type UserFieldScalar = string | number | boolean;

/** The declared-field columns that hold a value, by column name (an unset column is absent). */
export type FieldValues = Readonly<Record<string, UserFieldScalar>>;

/** BEH-EA-036: the keyset position of a listing. */
export interface UserCursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

export type InsertOutcome =
  | { readonly _tag: "Inserted"; readonly user: StoredUser }
  | { readonly _tag: "Held"; readonly holder: StoredUser };

export type CasOutcome =
  | { readonly _tag: "Updated"; readonly user: StoredUser }
  | { readonly _tag: "Stale"; readonly current: StoredUser }
  | { readonly _tag: "Taken" }
  | { readonly _tag: "Missing" };

export interface UserStoreShape {
  /**
   * ATOMIC per identity key (the lower-cased email; the E.164 phone): `Inserted`, or `Held` with the
   * user that already holds the key. A user with neither is never `Held`. MUST NOT abort an enclosing
   * transaction (SQL: `INSERT ... ON CONFLICT DO NOTHING RETURNING *`, then the holder read; a holder
   * that vanished in between retries the insert, a bounded number of times, and is never a defect).
   * Stamps the ambient tenant. Idempotent on `row.id`.
   */
  readonly insertOrHolder: (row: NewUser) => Effect.Effect<InsertOutcome, StoreUnavailable>;
  readonly get: (id: UserId) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>;
  /** `lowercased` is the stored form: the domain folds before it asks. */
  readonly getByEmail: (
    lowercased: string,
  ) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>;
  readonly getByPhone: (phone: E164) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>;
  /** ONE statement: `name`, the optional columns as `image`/`metadata` say, and `updatedAt = at`. `None` when the user is absent. Touches no other column. */
  readonly updateProfile: (input: {
    readonly id: UserId;
    readonly name: string;
    readonly image: Change<string>;
    readonly metadata: Change<string>;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>;
  /**
   * COMPARE-AND-SWAP on the four identity columns, and `updatedAt = at`. `Updated` when they still
   * equal `expected`; `Stale` with the user as it is now when they moved; `Taken` when `next` collides
   * with another user's email or phone (SQL: the statement runs in its own savepoint, so a Postgres
   * unique violation does not abort the caller's transaction); `Missing` when the user is absent.
   * Of any number of racing identical swaps exactly one is `Updated`.
   */
  readonly casIdentity: (input: {
    readonly id: UserId;
    readonly expected: IdentityColumns;
    readonly next: IdentityColumns;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<CasOutcome, StoreUnavailable>;
  /** ONE statement: the status, its reason and expiry, and `updatedAt = at`. `None` when the user is absent. */
  readonly setStatus: (input: {
    readonly id: UserId;
    readonly status: "active" | "suspended";
    readonly reason: Option.Option<string>;
    readonly until: Option.Option<DateTime.Utc>;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>;
  /** ATOMIC: removes the user AND its declared field values. `true` iff a row was removed. */
  readonly delete: (id: UserId) => Effect.Effect<boolean, StoreUnavailable>;
  /**
   * Ascending `(createdAt, id)`, strictly after `after` when given, at most `limit` items, and `next`
   * (the position of the last item) only when more follow. `limit` is a positive integer: the
   * domain validates it.
   */
  readonly listPage: (input: {
    readonly after: Option.Option<UserCursor>;
    readonly limit: number;
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<StoredUser>; readonly next: Option.Option<UserCursor> },
    StoreUnavailable
  >;
  /** `None` = the user is absent; an unset column is absent from the record. */
  readonly readFields: (
    id: UserId,
    columns: ReadonlyArray<UserFieldColumn>,
  ) => Effect.Effect<Option.Option<FieldValues>, StoreUnavailable>;
  /**
   * ATOMIC write and post-state: sets the given columns (`null` clears), sets `updatedAt = at`, and
   * answers the `returning` columns as they are after the write (SQL: one `UPDATE ... RETURNING`).
   * `None` when the user is absent, and then nothing is written, so a user deleted mid-call never
   * has orphaned fields.
   */
  readonly writeFields: (input: {
    readonly id: UserId;
    readonly values: Readonly<Record<string, UserFieldScalar | null>>;
    readonly returning: ReadonlyArray<UserFieldColumn>;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<Option.Option<FieldValues>, StoreUnavailable>;
}

export class UserStore extends Context.Service<UserStore, UserStoreShape>()(
  "awthaq/ports/UserStore",
) {}

// ---- the pure contract helpers every adapter and the domain share ---------------------------

/** `(createdAt, id)` ascending, the order `listPage` answers in. */
export const byCreation = (a: StoredUser, b: StoredUser): number =>
  DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The identity columns of a stored user. */
export const identityOf = (user: StoredUser): IdentityColumns => ({
  email: user.email,
  emailVerified: user.emailVerified,
  phone: user.phone,
  phoneVerified: user.phoneVerified,
});

/** Whether two sets of identity columns are the same. */
export const sameIdentity = (a: IdentityColumns, b: IdentityColumns): boolean =>
  Option.getOrNull(a.email) === Option.getOrNull(b.email) &&
  a.emailVerified === b.emailVerified &&
  Option.getOrNull(a.phone) === Option.getOrNull(b.phone) &&
  a.phoneVerified === b.phoneVerified;

// ---- the Ref adapter ------------------------------------------------------------------------

/** One state for users and their declared fields, so a delete removes both in one step. */
interface State {
  readonly byId: HashMap.HashMap<UserId, StoredUser>;
  readonly byEmail: HashMap.HashMap<string, UserId>;
  readonly byPhone: HashMap.HashMap<string, UserId>;
  readonly fields: HashMap.HashMap<UserId, FieldValues>;
}

const emptyState: State = {
  byId: HashMap.empty(),
  byEmail: HashMap.empty(),
  byPhone: HashMap.empty(),
  fields: HashMap.empty(),
};

const index = (s: State, user: StoredUser): State => ({
  ...s,
  byId: HashMap.set(s.byId, user.id, user),
  byEmail: Option.match(user.email, {
    onNone: () => s.byEmail,
    onSome: (email) => HashMap.set(s.byEmail, email, user.id),
  }),
  byPhone: Option.match(user.phone, {
    onNone: () => s.byPhone,
    onSome: (phone) => HashMap.set(s.byPhone, phone, user.id),
  }),
});

const unindex = (s: State, user: StoredUser): State => ({
  ...s,
  byId: HashMap.remove(s.byId, user.id),
  byEmail: Option.match(user.email, {
    onNone: () => s.byEmail,
    onSome: (email) => HashMap.remove(s.byEmail, email),
  }),
  byPhone: Option.match(user.phone, {
    onNone: () => s.byPhone,
    onSome: (phone) => HashMap.remove(s.byPhone, phone),
  }),
});

/** The user already holding `user`'s email or phone, if any (never for a user with neither). */
const holderOf = (
  s: State,
  email: Option.Option<string>,
  phone: Option.Option<E164>,
): Option.Option<StoredUser> => {
  const byEmail = Option.flatMap(email, (value) => HashMap.get(s.byEmail, value));
  const id = Option.isSome(byEmail)
    ? byEmail
    : Option.flatMap(phone, (value) => HashMap.get(s.byPhone, value));
  return Option.flatMap(id, (userId) => HashMap.get(s.byId, userId));
};

const pick = (held: FieldValues, columns: ReadonlyArray<UserFieldColumn>): FieldValues => {
  const picked: Record<string, UserFieldScalar> = {};
  for (const column of columns) {
    const value = held[column.name];
    if (value !== undefined) picked[column.name] = value;
  }
  return picked;
};

/**
 * Single-process, test-grade (TRBS-005). Each primitive is one `Ref.modify`, so every one is atomic,
 * and the users and their fields share one `Ref`.
 */
export const layerMemory = Layer.effect(
  UserStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);

    const insertOrHolder: UserStoreShape["insertOrHolder"] = (row) =>
      Effect.flatMap(Tenant.resolve(Option.none()), (tenantId) => {
        const user: StoredUser = { ...row, tenantId };
        return Ref.modify(state, (s): readonly [InsertOutcome, State] => {
          const holder = holderOf(s, user.email, user.phone);
          return Option.isSome(holder)
            ? [{ _tag: "Held", holder: holder.value }, s]
            : [{ _tag: "Inserted", user }, index(s, user)];
        });
      });

    const get: UserStoreShape["get"] = (id) =>
      Effect.map(Ref.get(state), (s) => HashMap.get(s.byId, id));

    const getByEmail: UserStoreShape["getByEmail"] = (lowercased) =>
      Effect.map(Ref.get(state), (s) => holderOf(s, Option.some(lowercased), Option.none()));

    const getByPhone: UserStoreShape["getByPhone"] = (phone) =>
      Effect.map(Ref.get(state), (s) => holderOf(s, Option.none(), Option.some(phone)));

    /** Rewrites one user atomically; `None` for an absent one. */
    const modifyUser =
      (id: UserId, change: (user: StoredUser) => StoredUser) =>
      (s: State): readonly [Option.Option<StoredUser>, State] => {
        const existing = HashMap.get(s.byId, id);
        if (Option.isNone(existing)) return [Option.none(), s];
        const updated = change(existing.value);
        return [Option.some(updated), { ...s, byId: HashMap.set(s.byId, id, updated) }];
      };

    const updateProfile: UserStoreShape["updateProfile"] = (input) =>
      Ref.modify(
        state,
        modifyUser(input.id, (user) => ({
          ...user,
          name: input.name,
          image: applyChange(user.image, input.image),
          metadata: applyChange(user.metadata, input.metadata),
          updatedAt: input.at,
        })),
      );

    const casIdentity: UserStoreShape["casIdentity"] = (input) =>
      Ref.modify(state, (s): readonly [CasOutcome, State] => {
        const existing = HashMap.get(s.byId, input.id);
        if (Option.isNone(existing)) return [{ _tag: "Missing" }, s];
        if (!sameIdentity(identityOf(existing.value), input.expected)) {
          return [{ _tag: "Stale", current: existing.value }, s];
        }
        const holder = holderOf(s, input.next.email, input.next.phone);
        if (Option.isSome(holder) && holder.value.id !== input.id) return [{ _tag: "Taken" }, s];
        const user: StoredUser = {
          ...existing.value,
          ...input.next,
          updatedAt: input.at,
        };
        return [{ _tag: "Updated", user }, index(unindex(s, existing.value), user)];
      });

    const setStatus: UserStoreShape["setStatus"] = (input) =>
      Ref.modify(
        state,
        modifyUser(input.id, (user) => ({
          ...user,
          status: input.status,
          statusReason: input.reason,
          suspendedUntil: input.until,
          updatedAt: input.at,
        })),
      );

    const remove: UserStoreShape["delete"] = (id) =>
      Ref.modify(state, (s): readonly [boolean, State] => {
        const existing = HashMap.get(s.byId, id);
        if (Option.isNone(existing)) return [false, s];
        return [true, { ...unindex(s, existing.value), fields: HashMap.remove(s.fields, id) }];
      });

    const listPage: UserStoreShape["listPage"] = ({ after, limit }) =>
      Effect.map(Ref.get(state), (s) => {
        const following = Array.from(HashMap.values(s.byId))
          .sort(byCreation)
          .filter(
            (user) =>
              Option.isNone(after) ||
              DateTime.toEpochMillis(user.createdAt) >
                DateTime.toEpochMillis(after.value.createdAt) ||
              (DateTime.toEpochMillis(user.createdAt) ===
                DateTime.toEpochMillis(after.value.createdAt) &&
                user.id > after.value.id),
          );
        const items = following.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          next:
            following.length > limit && last !== undefined
              ? Option.some({ createdAt: last.createdAt, id: last.id })
              : Option.none(),
        };
      });

    const readFields: UserStoreShape["readFields"] = (id, columns) =>
      Effect.map(Ref.get(state), (s) =>
        Option.map(HashMap.get(s.byId, id), () =>
          pick(
            Option.getOrElse(HashMap.get(s.fields, id), () => ({})),
            columns,
          ),
        ),
      );

    const writeFields: UserStoreShape["writeFields"] = (input) =>
      Ref.modify(state, (s): readonly [Option.Option<FieldValues>, State] => {
        const existing = HashMap.get(s.byId, input.id);
        if (Option.isNone(existing)) return [Option.none(), s];
        const merged: Record<string, UserFieldScalar> = {
          ...Option.getOrElse(HashMap.get(s.fields, input.id), () => ({})),
        };
        for (const [name, value] of Object.entries(input.values)) {
          if (value === null) delete merged[name];
          else merged[name] = value;
        }
        return [
          Option.some(pick(merged, input.returning)),
          {
            ...s,
            byId: HashMap.set(s.byId, input.id, { ...existing.value, updatedAt: input.at }),
            fields: HashMap.set(s.fields, input.id, merged),
          },
        ];
      });

    return UserStore.of({
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

const applyChange = <A>(current: Option.Option<A>, change: Change<A>): Option.Option<A> => {
  switch (change._tag) {
    case "Keep":
      return current;
    case "Set":
      return Option.some(change.value);
    case "Clear":
      return Option.none();
  }
};
