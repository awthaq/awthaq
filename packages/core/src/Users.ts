// @awthaq/core — Users
//
// spec/behaviors/06-domain-users-accounts.md, BEH-EA-041, BEH-EA-042.
// Plan 02 (ADR-EA-041): written once, over `@awthaq/ports`' `UserStore` (a `Ref` adapter there, a SQL
// adapter over `@awthaq/sql`'s repository, BEH-EA-033-036). The service owns the rules (the identity
// union, the folding of an email, the verified-flag transitions, the uniqueness errors, the id and
// the clock, the announcements); the store owns persistence and the atomicity of each primitive.

import { Defects, type Ids, UserStore } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import { now } from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { relabel, storeUnavailable, StoreUnavailable } from "./Errors.ts";
import * as Hooks from "./Hooks.ts";
import type { ErasureClearance } from "./internal/erasureClearance.ts";
import type * as Phone from "./Phone.ts";
import * as UserFields from "./UserFields.ts";

/** BEH-EA-033: the id every `Account`/`Session` foreign-keys to. INV-EA-018: an identifier, never a capability — UUIDv7, time-ordered and partially predictable, so nothing may act on it without a credential's proof. */
// MA-008: the brand is declared once, in `@awthaq/ports` (`Ids`); this keeps only a nominal constructor.
export type UserId = Ids.UserId;
export const UserId = Brand.nominal<UserId>();

/** FAMS-002: a user with an email address — BEH-EA-041/042 exactly as before (lower-cased, unique, monotone-verified, never client-settable). */
export interface EmailIdentity {
  readonly _tag: "Email";
  /** BEH-EA-041: always the lower-cased form of whatever email was given. */
  readonly email: string;
  readonly emailVerified: boolean;
}

/** FAMS-002/SOS-008: the same treatment for a phone number, stored as E.164. */
export interface PhoneIdentity {
  readonly _tag: "Phone";
  readonly phone: Phone.E164;
  readonly phoneVerified: boolean;
}

/**
 * FAMS-002: a persisted account with neither email nor phone (Firebase
 * `signInAnonymously`, an OAuth profile that supplied no email). Distinct from
 * `Api.ts`'s `AnonymousPrincipal`, which is the wire marker for a caller with
 * *no* user row at all. Upgradeable in place through `Users.promoteIdentity`.
 */
export interface AnonymousIdentity {
  readonly _tag: "Anonymous";
}

/**
 * FAMS-002/SAM-003 (wayfinder ticket 09): the identity a user is known by. A
 * union rather than nullable fields, so "both null" and "phoneVerified without
 * a phone" are not representable; the SQL layer stores it flattened
 * (`email`/`phone` columns) so both uniqueness rules stay real constraints.
 */
export type UserIdentity = EmailIdentity | PhoneIdentity | AnonymousIdentity;

/** What `create`/`promoteIdentity` accept: verified flags are never input (BEH-EA-042). */
export type IdentityInput =
  | { readonly _tag: "Email"; readonly email: string }
  | { readonly _tag: "Phone"; readonly phone: Phone.E164 }
  | { readonly _tag: "Anonymous" };

/** What an Anonymous user can be promoted to. */
export type PromotedIdentity = Exclude<IdentityInput, { readonly _tag: "Anonymous" }>;

/** SCP-001: `suspended` is reversible and never a deletion (BEH-EA-046). */
export type UserStatus = "active" | "suspended";

export interface UserRecord {
  readonly id: UserId;
  readonly identity: UserIdentity;
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
  /** BAM-009/NAM-009: an avatar URL, client-writable like `name`. */
  readonly image: Option.Option<string>;
  /**
   * DRS-001 (ADR-EA-018): the tenant in context when this user was created —
   * an opaque key, `None` for a single-tenant deployment. Attribution only: the
   * users table is the global identity directory (DRS-005), so it never
   * narrows sign-in lookups.
   */
  readonly tenantId: Option.Option<string>;
  /** SCP-001: written only by `setStatus`; consulted by `assertCanSignIn`. */
  readonly status: UserStatus;
  /** SCP-001/BAM-005: the operator's note for a suspension; never sent to the suspended user. */
  readonly statusReason: Option.Option<string>;
  /** BAM-005: a timed suspension lapses by itself (`assertCanSignIn` compares against now); `None` means until reactivated. */
  readonly suspendedUntil: Option.Option<DateTime.Utc>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

/** FAMS-002: the user's email, if their identity is an email one. */
export const emailOf = (user: UserRecord): Option.Option<string> =>
  user.identity._tag === "Email" ? Option.some(user.identity.email) : Option.none();

/** FAMS-002: `{ email }` for an email-identity user, `{}` otherwise — for hook inputs whose `email` is optional. */
export const emailField = (user: UserRecord): { readonly email?: string } => {
  const email = emailOf(user);
  return Option.isSome(email) ? { email: email.value } : {};
};

/** FAMS-002: the user's E.164 phone, if their identity is a phone one. */
export const phoneOf = (user: UserRecord): Option.Option<Phone.E164> =>
  user.identity._tag === "Phone" ? Option.some(user.identity.phone) : Option.none();

/** FAMS-002: a human-readable account label — email, else phone, else the display name. For places that must show *some* handle (a WebAuthn `user.name`), never for lookups. */
export const accountLabel = (user: UserRecord): string => {
  switch (user.identity._tag) {
    case "Email":
      return user.identity.email;
    case "Phone":
      return user.identity.phone;
    case "Anonymous":
      return user.name;
  }
};

/** BEH-EA-042: `false` for any identity that has no email to verify. */
export const isEmailVerified = (user: UserRecord): boolean =>
  user.identity._tag === "Email" && user.identity.emailVerified;

/** FAMS-002: `false` for any identity that has no phone to verify. */
export const isPhoneVerified = (user: UserRecord): boolean =>
  user.identity._tag === "Phone" && user.identity.phoneVerified;

/**
 * BAM-005/SCP-001: whether the suspension is in force at `now` — a `suspended`
 * user whose `suspendedUntil` has passed is treated as active without any
 * write (no sweeper needed; `setStatus("active")` clears the stale marker).
 */
export const isSuspendedAt = (user: UserRecord, at: DateTime.Utc): boolean =>
  user.status === "suspended" &&
  Option.match(user.suspendedUntil, {
    onNone: () => true,
    onSome: (until) => DateTime.isGreaterThan(until, at),
  });

export class EmailAlreadyExists extends Data.TaggedError("Users/EmailAlreadyExists")<{
  readonly message: string;
  readonly email: string;
}> {}

/** FAMS-002: the phone counterpart of `EmailAlreadyExists`; reachable only for a `Phone` identity. */
export class PhoneAlreadyExists extends Data.TaggedError("Users/PhoneAlreadyExists")<{
  readonly message: string;
  readonly phone: string;
}> {}

export class UserNotFound extends Data.TaggedError("UserNotFound")<{
  readonly message: string;
  readonly id: UserId;
}> {}

/** FAMS-002: an identity operation aimed at a user whose identity kind cannot take it (verifying the email of a phone user, promoting a user that already has an identity). */
export class IdentityMismatch extends Data.TaggedError("IdentityMismatch")<{
  readonly message: string;
  readonly id: UserId;
  /** The identity kind the operation needed. */
  readonly expected: UserIdentity["_tag"];
  readonly actual: UserIdentity["_tag"];
}> {}

/**
 * SCP-001/BAM-005: the one refusal every sign-in-completing flow surfaces
 * (`assertCanSignIn`). `403`, like `EmailNotVerified`: the credential was right,
 * the account's state forbids proceeding. Carries nothing — the suspension's
 * reason is an operator note, and callers check only after the credential
 * proof, so a suspended target is never revealed to an unproven caller.
 */
export class UserSuspended extends Schema.TaggedError<UserSuspended>()(
  "UserSuspended",
  {},
  { httpApiStatus: 403 },
) {}

/**
 * SCP-001/BAM-005: THE sign-in gate (tickets 09/19: one gate, not one per
 * plugin). A plain call, deliberately not a hook point — a tap could be left
 * out of a composition and silently un-gate a flow. Every flow that turns a
 * proven credential into a session (password, passkey, oauth) calls it with the
 * `UserRecord` it already holds, *after* the credential check and *before*
 * `Sessions.issue`. It is not inside `Users.findById`, so an admin can still
 * resolve and reactivate a suspended user; admin impersonation deliberately does
 * not consult it (an operator investigating a suspended account is not that
 * account signing in).
 */
export const assertCanSignIn = (user: UserRecord): Effect.Effect<void, UserSuspended> =>
  Effect.flatMap(now, (at) =>
    isSuspendedAt(user, at) ? Effect.fail(new UserSuspended()) : Effect.void,
  );

export interface CreateInput {
  readonly identity: IdentityInput;
  readonly name: string;
  readonly metadata?: string;
  readonly image?: string;
}

/**
 * BEH-EA-041/042: no operation below accepts `emailVerified`/`phoneVerified`
 * as input — `create` always starts them `false` (supplier-authority default),
 * and `verifyEmail`/`verifyPhone` are the only transitions, one-directional and
 * idempotent (`changeEmail` alone lowers `emailVerified`, since a new address
 * is unproven). `updateProfile`'s input has no identity or status field, so
 * there is no generic write path a plugin-level caller could use to change
 * either. SCP-001: `setStatus` is the only writer of `status`.
 *
 * ADR-EA-038: a sign-up never calls `create` directly; it goes through `SignUp`, which runs `BeforeSignUp`
 * and owns the transaction and the announcements. `assertCanSignIn` is called by `SignIn` for every flow.
 */
export interface UsersShape {
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<UserRecord, EmailAlreadyExists | PhoneAlreadyExists | StoreUnavailable>;
  /**
   * SCP-003: idempotent create — an existing user holding the same email/phone
   * is returned with `created: false` instead of failing, so an IdP retry or a
   * re-run import converges. `Anonymous` never conflicts. Atomic in both
   * layers (a concurrent pair yields exactly one `created: true`).
   */
  readonly createOrGet: (
    input: CreateInput,
  ) => Effect.Effect<{ readonly user: UserRecord; readonly created: boolean }, StoreUnavailable>;
  readonly findById: (id: UserId) => Effect.Effect<UserRecord, UserNotFound | StoreUnavailable>;
  readonly findByEmail: (
    email: string,
  ) => Effect.Effect<Option.Option<UserRecord>, StoreUnavailable>;
  /** FAMS-002: takes only the branded `E164` — see `Phone.normalizePhone`. */
  readonly findByPhone: (
    phone: Phone.E164,
  ) => Effect.Effect<Option.Option<UserRecord>, StoreUnavailable>;
  /** AOMS-002: `metadata` left `undefined` leaves it untouched; `null` clears it. BAM-009: `image` likewise. */
  readonly updateProfile: (
    id: UserId,
    input: {
      readonly name: string;
      readonly metadata?: string | null | undefined;
      readonly image?: string | null | undefined;
    },
  ) => Effect.Effect<UserRecord, UserNotFound | StoreUnavailable>;
  readonly verifyEmail: (
    id: UserId,
  ) => Effect.Effect<UserRecord, UserNotFound | IdentityMismatch | StoreUnavailable>;
  /** FAMS-002: `phoneVerified`'s only writer; monotone and idempotent like `verifyEmail`. */
  readonly verifyPhone: (
    id: UserId,
  ) => Effect.Effect<UserRecord, UserNotFound | IdentityMismatch | StoreUnavailable>;
  /**
   * FAMS-002: Anonymous -> Email/Phone in place — same `UserId`, so every
   * `Account`/`Session` row follows (Firebase `linkWithCredential`). The new
   * identity starts unverified. Fails `IdentityMismatch` for a user that
   * already has an identity, and with the respective `*AlreadyExists` when the
   * address is taken.
   */
  readonly promoteIdentity: (
    id: UserId,
    identity: PromotedIdentity,
  ) => Effect.Effect<
    UserRecord,
    UserNotFound | IdentityMismatch | EmailAlreadyExists | PhoneAlreadyExists | StoreUnavailable
  >;
  /**
   * BAM-009: replaces the email of an Email-identity user and resets
   * `emailVerified` to `false` (BEH-EA-042's one permitted lowering). A
   * *primitive*: it does not prove the caller owns the new address — the
   * verified flow (mail a token to the new address, then call this and
   * `verifyEmail`) belongs to the caller. Changing to the current address is a
   * no-op.
   */
  readonly changeEmail: (
    id: UserId,
    email: string,
  ) => Effect.Effect<
    UserRecord,
    UserNotFound | IdentityMismatch | EmailAlreadyExists | StoreUnavailable
  >;
  /**
   * SCP-001/BAM-005: suspend or reactivate. The only writer of `status`; it
   * leaves `Accounts`/`Sessions` alone (BEH-EA-046 discipline) — a suspending
   * caller composes `Sessions.revokeAll(id, reason)` itself. `reason`/`until`
   * describe a suspension and are cleared when reactivating.
   */
  readonly setStatus: (
    id: UserId,
    status: UserStatus,
    options?: {
      readonly reason?: string | undefined;
      readonly until?: DateTime.Utc | undefined;
    },
  ) => Effect.Effect<UserRecord, UserNotFound | StoreUnavailable>;
  /**
   * BEH-EA-046: creates a user and runs `complete` with it. If `complete` fails, dies or is
   * interrupted, the user is abandoned: its row and declared fields are removed, no veto runs and
   * nothing is announced, because nobody outside this call has been told the user exists. This is
   * how a multi-step provisioning (SCIM `POST /Users`: create, link, add to the organization)
   * leaves nothing behind. It cannot remove any user it did not just create; a committed user is
   * deleted only by `Erasure.AccountErasure`.
   */
  readonly createWith: <A, E, R>(
    input: CreateInput,
    complete: (user: UserRecord) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    { readonly user: UserRecord; readonly value: A },
    E | EmailAlreadyExists | PhoneAlreadyExists | StoreUnavailable,
    R
  >;
  /**
   * BAM-005/BEH-EA-036: the admin surface's user listing — keyset-paginated on
   * `(createdAt, id)`, oldest first, opaque cursor in / `nextCursor` out, never an
   * offset, never more than `limit + 1` rows read (`limit` defaults to 50).
   */
  readonly list: (input?: {
    readonly cursor?: UserCursor | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<UsersPage, StoreUnavailable>;
  /**
   * SAM-004 (BEH-EA-040): the plugin-declared fields (`UserFields`) this user holds a value for, keyed
   * `<plugin id>_<field>`, as their columns store them (encoded scalars); an unset field is absent. `keys`
   * narrows the read (default: every field of the composition's `UserFieldRegistry`). A key nobody declared
   * is `UnknownUserField`. Prefer `typedFields`, which decodes.
   */
  readonly getFields: (
    id: UserId,
    keys?: ReadonlyArray<string>,
  ) => Effect.Effect<
    UserFields.Values,
    UserNotFound | UserFields.UnknownUserField | StoreUnavailable
  >;
  /**
   * SAM-004/BEH-EA-048: writes declared fields (`null` clears one) and resolves to the user's fields after
   * the write. The write is validated as a whole before anything is stored: every key declared, every value
   * accepted by its field's schema, and — for `source: "client"` (the HTTP profile path) — every field
   * `clientWritable` (the default), else `UserFieldNotWritable`. The default `source: "server"` is trusted
   * code (a billing webhook writing a plan tier) and may write any declared field. Announces the changed
   * keys on `Hooks.AfterUserAttributesChanged`, so a policy reading them is refreshed (AAPS-005).
   */
  readonly setFields: (
    id: UserId,
    patch: UserFields.Patch,
    options?: { readonly source?: UserFields.Source },
  ) => Effect.Effect<
    UserFields.Values,
    | UserNotFound
    | UserFields.UnknownUserField
    | UserFields.UserFieldNotWritable
    | UserFields.InvalidUserFieldValue
    | StoreUnavailable
  >;
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

/**
 * ADR-EA-031: the user row's store primitive. Removes the row and its declared fields only: no
 * veto, no cascade, no event (`Erasure.AccountErasure` owns those). The clearance can only be
 * minted by `AccountErasure` after the `BeforeUserDelete` veto passed, so nothing else can call
 * this. Both `Users` layers provide it from the same build, so the row store is shared.
 */
export interface UserRemovalShape {
  readonly remove: (
    clearance: ErasureClearance,
  ) => Effect.Effect<void, UserNotFound | StoreUnavailable>;
}

export class UserRemoval extends Context.Service<UserRemoval, UserRemovalShape>()(
  "awthaq/core/UserRemoval",
) {}

/** SAM-004: the held values among `keys` (an unset field is absent). */
const pickFields = (held: UserFields.Values, keys: ReadonlyArray<string>): UserFields.Values => {
  const picked: Record<string, UserFields.Scalar> = {};
  for (const key of keys) {
    const value = held[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
};

/** BEH-EA-041: the lower-cased form is the stored (and compared) form. */
const normalizePromoted = (identity: PromotedIdentity): PromotedIdentity =>
  identity._tag === "Email" ? { _tag: "Email", email: identity.email.toLowerCase() } : identity;

const normalizeIdentity = (identity: IdentityInput): IdentityInput =>
  identity._tag === "Anonymous" ? identity : normalizePromoted(identity);

const emailExists = (email: string) =>
  new EmailAlreadyExists({ message: "awthaq: email already exists", email });

const alreadyExists = (identity: PromotedIdentity): EmailAlreadyExists | PhoneAlreadyExists =>
  identity._tag === "Email"
    ? emailExists(identity.email)
    : new PhoneAlreadyExists({
        message: "awthaq: phone already exists",
        phone: identity.phone,
      });

// No uniqueness rule applies to an Anonymous user, so no layer reports a conflict for one.
const identityAlreadyExists = (
  identity: IdentityInput,
): Effect.Effect<never, EmailAlreadyExists | PhoneAlreadyExists> =>
  identity._tag === "Anonymous"
    ? Defects.invariantViolation(
        "AnonymousIdentityConflict",
        "awthaq: an Anonymous identity cannot conflict",
      )
    : Effect.fail(alreadyExists(identity));

const userNotFound = (id: UserId) => new UserNotFound({ message: "awthaq: no such user", id });

const identityMismatch = (
  id: UserId,
  expected: UserIdentity["_tag"],
  actual: UserIdentity["_tag"],
) =>
  new IdentityMismatch({
    message: `awthaq: user has a ${actual} identity, not ${expected}`,
    id,
    expected,
    actual,
  });

/** SCP-001: what `setStatus` stores — a reactivation clears any suspension note and expiry. */
const statusFields = (
  status: UserStatus,
  options:
    | { readonly reason?: string | undefined; readonly until?: DateTime.Utc | undefined }
    | undefined,
) =>
  status === "suspended"
    ? {
        statusReason: Option.fromNullishOr(options?.reason),
        suspendedUntil: Option.fromNullishOr(options?.until),
      }
    : { statusReason: Option.none<string>(), suspendedUntil: Option.none<DateTime.Utc>() };

/**
 * AAPS-005: fires `Hooks.AfterUserAttributesChanged` (an observe point) when a
 * policy-readable attribute really changed. Read through `Effect.serviceOption`
 * so it adds nothing to the layer's requirements — a composition that does
 * not provide the point simply announces nothing.
 */
const attributesChangedAnnouncer = Effect.gen(function* () {
  const hook = yield* Effect.serviceOption(Hooks.AfterUserAttributesChanged);
  return (userId: UserId, attributes: ReadonlyArray<string>): Effect.Effect<void> =>
    Option.isSome(hook) ? hook.value.run({ userId, attributes }) : Effect.void;
});

/** The identity kind of a stored user's columns. */
const identityTagOf = (user: UserStore.StoredUser): UserIdentity["_tag"] =>
  Option.isSome(user.email) ? "Email" : Option.isSome(user.phone) ? "Phone" : "Anonymous";

/**
 * FAMS-002: folds the flattened `email`/`phone` columns into the identity union
 * — the one place that reads them. A row with both set is not a state any
 * writer here produces (the union says a user has one identity), so it dies
 * with a defect rather than picking a side silently.
 */
const toIdentity = (user: UserStore.StoredUser): Effect.Effect<UserIdentity> => {
  if (Option.isSome(user.email) && Option.isSome(user.phone)) {
    return Defects.invariantViolation(
      "UserIdentityAmbiguous",
      "awthaq: a user row has both an email and a phone",
    );
  }
  if (Option.isSome(user.email)) {
    return Effect.succeed({
      _tag: "Email",
      email: user.email.value,
      emailVerified: user.emailVerified,
    });
  }
  if (Option.isSome(user.phone)) {
    return Effect.succeed({
      _tag: "Phone",
      phone: user.phone.value,
      phoneVerified: user.phoneVerified,
    });
  }
  return Effect.succeed({ _tag: "Anonymous" });
};

const toUserRecord = (user: UserStore.StoredUser): Effect.Effect<UserRecord> =>
  Effect.map(toIdentity(user), (identity) => ({
    id: UserId(user.id),
    identity,
    name: user.name,
    metadata: user.metadata,
    image: user.image,
    tenantId: user.tenantId,
    status: user.status,
    statusReason: user.statusReason,
    suspendedUntil: user.suspendedUntil,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }));

const toUserRecordOption = (
  user: Option.Option<UserStore.StoredUser>,
): Effect.Effect<Option.Option<UserRecord>> =>
  Option.match(user, {
    onNone: () => Effect.succeedNone,
    onSome: (found) => Effect.map(toUserRecord(found), Option.some),
  });

/** What an identity operation decided to do to the row it just read. */
type Plan<Conflict> =
  | { readonly _tag: "Unchanged" }
  | {
      readonly _tag: "Change";
      readonly next: UserStore.IdentityColumns;
      /** Fails with the domain's own error when the new email or phone belongs to someone else. */
      readonly taken: Effect.Effect<never, Conflict>;
    };

/** How often an identity operation re-reads and retries after losing a compare-and-swap. */
const SWAP_ATTEMPTS = 3;

/** BEH-EA-036: a page is at least one row and at most this many. */
const MAX_LIST_LIMIT = 200;

const listLimit = (limit: number | undefined): number =>
  limit === undefined || !Number.isFinite(limit)
    ? DEFAULT_LIST_LIMIT
    : Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);

/** A profile column as the store takes it: `undefined` keeps, `null` clears. */
const profileChange = (value: string | null | undefined): UserStore.Change<string> =>
  value === undefined
    ? { _tag: "Keep" }
    : value === null
      ? { _tag: "Clear" }
      : { _tag: "Set", value };

/**
 * Written once over `UserStore` (ADR-EA-041). Needs the store and `Crypto` (the id); the clock is
 * read once per operation and handed to the store.
 *
 * BEH-EA-046: deleting a user is `Erasure.AccountErasure`'s job; this layer also provides the row
 * store (`UserRemoval`) it calls with a clearance.
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* UserStore.UserStore;
    const crypto = yield* Crypto.Crypto;
    const announce = yield* attributesChangedAnnouncer;
    // SAM-004: the composition's declared fields; their columns exist because `Auth.make`'s generated migrations added them.
    const registry = yield* UserFields.UserFieldRegistry;

    /** The stored user, or `UserNotFound`. */
    const getStored = (id: UserId, operation: string) =>
      store.get(id).pipe(
        relabel(operation),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(userNotFound(id)),
            onSome: Effect.succeed,
          }),
        ),
      );

    const findById: UsersShape["findById"] = (id) =>
      getStored(id, "Users.findById").pipe(Effect.flatMap(toUserRecord));

    const findByEmail: UsersShape["findByEmail"] = (email) =>
      store
        .getByEmail(email.toLowerCase())
        .pipe(relabel("Users.findByEmail"), Effect.flatMap(toUserRecordOption));

    const findByPhone: UsersShape["findByPhone"] = (phone) =>
      store
        .getByPhone(phone)
        .pipe(relabel("Users.findByPhone"), Effect.flatMap(toUserRecordOption));

    /** The row `create` and `createOrGet` hand the store: the domain mints the id and reads the clock. */
    const newUser = Effect.fnUntraced(function* (input: CreateInput, operation: string) {
      const identity = normalizeIdentity(input.identity);
      const id = UserId(
        yield* crypto.randomUUIDv7.pipe(
          Effect.catchTag("PlatformError", storeUnavailable(operation)),
        ),
      );
      const at = yield* now;
      const row: UserStore.NewUser = {
        id,
        email: identity._tag === "Email" ? Option.some(identity.email) : Option.none(),
        emailVerified: false,
        phone: identity._tag === "Phone" ? Option.some(identity.phone) : Option.none(),
        phoneVerified: false,
        name: input.name,
        image: Option.fromNullishOr(input.image),
        metadata: Option.fromNullishOr(input.metadata),
        status: "active",
        statusReason: Option.none(),
        suspendedUntil: Option.none(),
        createdAt: at,
        updatedAt: at,
      };
      return { identity, row };
    });

    const create: UsersShape["create"] = Effect.fnUntraced(function* (input) {
      const { identity, row } = yield* newUser(input, "Users.create");
      const outcome = yield* store.insertOrHolder(row);
      return outcome._tag === "Inserted"
        ? yield* toUserRecord(outcome.user)
        : yield* identityAlreadyExists(identity);
    }, relabel("Users.create"));

    // SCP-003: the store decides "insert or return the holder" in one atomic primitive, so a
    // concurrent pair cannot both insert.
    const createOrGet: UsersShape["createOrGet"] = Effect.fnUntraced(function* (input) {
      const { row } = yield* newUser(input, "Users.createOrGet");
      const outcome = yield* store.insertOrHolder(row);
      return outcome._tag === "Inserted"
        ? { user: yield* toUserRecord(outcome.user), created: true }
        : { user: yield* toUserRecord(outcome.holder), created: false };
    }, relabel("Users.createOrGet"));

    // GC-004: one targeted statement, so a row deleted between the caller's read and this write is
    // `UserNotFound`, never a defect, and no other column is rewritten from a stale read.
    const updateProfile: UsersShape["updateProfile"] = Effect.fnUntraced(function* (id, input) {
      const at = yield* now;
      const row = yield* store.updateProfile({
        id,
        name: input.name,
        image: profileChange(input.image),
        metadata: profileChange(input.metadata),
        at,
      });
      if (Option.isNone(row)) return yield* userNotFound(id);
      yield* announce(id, ["name"]);
      return yield* toUserRecord(row.value);
    }, relabel("Users.updateProfile"));

    /**
     * An identity transition (BEH-EA-041/042): read the user, decide what to change (`plan`), and apply it
     * as a compare-and-swap against what was read. A concurrent change is `Stale`: the user is re-read and
     * the decision made again (at most `SWAP_ATTEMPTS` times), so a transition and its announcement
     * happen exactly once. Resolves to the user as it is, the user as it was read, and whether it changed.
     */
    const swap = <E, Conflict>(
      operation: string,
      id: UserId,
      plan: (current: UserStore.StoredUser) => Effect.Effect<Plan<Conflict>, E>,
    ) =>
      Effect.gen(function* () {
        let current = yield* getStored(id, operation);
        for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt++) {
          const decided = yield* plan(current);
          if (decided._tag === "Unchanged") {
            return { user: current, before: current, changed: false };
          }
          const at = yield* now;
          const outcome = yield* store
            .casIdentity({ id, expected: UserStore.identityOf(current), next: decided.next, at })
            .pipe(relabel(operation));
          switch (outcome._tag) {
            case "Updated":
              return { user: outcome.user, before: current, changed: true };
            case "Stale":
              current = outcome.current;
              break;
            case "Taken":
              return yield* decided.taken;
            case "Missing":
              return yield* userNotFound(id);
          }
        }
        return yield* new StoreUnavailable({ operation });
      });

    const verifyEmail: UsersShape["verifyEmail"] = Effect.fnUntraced(function* (id) {
      const done = yield* swap("Users.verifyEmail", id, (current) =>
        Option.isNone(current.email)
          ? Effect.fail(identityMismatch(id, "Email", identityTagOf(current)))
          : Effect.succeed<Plan<never>>(
              current.emailVerified
                ? { _tag: "Unchanged" }
                : {
                    _tag: "Change",
                    next: { ...UserStore.identityOf(current), emailVerified: true },
                    taken: Effect.never,
                  },
            ),
      );
      // AAPS-005: announced exactly once, by the call that made the change.
      if (done.changed) yield* announce(id, ["emailVerified"]);
      return yield* toUserRecord(done.user);
    });

    const verifyPhone: UsersShape["verifyPhone"] = Effect.fnUntraced(function* (id) {
      const done = yield* swap("Users.verifyPhone", id, (current) =>
        Option.isNone(current.phone)
          ? Effect.fail(identityMismatch(id, "Phone", identityTagOf(current)))
          : Effect.succeed<Plan<never>>(
              current.phoneVerified
                ? { _tag: "Unchanged" }
                : {
                    _tag: "Change",
                    next: { ...UserStore.identityOf(current), phoneVerified: true },
                    taken: Effect.never,
                  },
            ),
      );
      return yield* toUserRecord(done.user);
    });

    const promoteIdentity: UsersShape["promoteIdentity"] = Effect.fnUntraced(
      function* (id, requested) {
        const wanted = normalizePromoted(requested);
        const done = yield* swap("Users.promoteIdentity", id, (current) =>
          identityTagOf(current) !== "Anonymous"
            ? Effect.fail(identityMismatch(id, "Anonymous", identityTagOf(current)))
            : Effect.succeed<Plan<EmailAlreadyExists | PhoneAlreadyExists>>({
                _tag: "Change",
                next: {
                  email: wanted._tag === "Email" ? Option.some(wanted.email) : Option.none(),
                  emailVerified: false,
                  phone: wanted._tag === "Phone" ? Option.some(wanted.phone) : Option.none(),
                  phoneVerified: false,
                },
                taken: Effect.fail(alreadyExists(wanted)),
              }),
        );
        return yield* toUserRecord(done.user);
      },
    );

    const changeEmail: UsersShape["changeEmail"] = Effect.fnUntraced(function* (id, requested) {
      const email = requested.toLowerCase();
      const done = yield* swap("Users.changeEmail", id, (current) =>
        Option.isNone(current.email)
          ? Effect.fail(identityMismatch(id, "Email", identityTagOf(current)))
          : Effect.succeed<Plan<EmailAlreadyExists>>(
              current.email.value === email
                ? { _tag: "Unchanged" }
                : {
                    _tag: "Change",
                    next: {
                      ...UserStore.identityOf(current),
                      email: Option.some(email),
                      emailVerified: false,
                    },
                    taken: Effect.fail(emailExists(email)),
                  },
            ),
      );
      // BEH-EA-042's one permitted lowering: announced only when the address really was verified.
      if (done.changed && done.before.emailVerified) yield* announce(id, ["emailVerified"]);
      return yield* toUserRecord(done.user);
    });

    const setStatus: UsersShape["setStatus"] = Effect.fnUntraced(function* (id, status, options) {
      const fields = statusFields(status, options);
      const at = yield* now;
      const row = yield* store.setStatus({
        id,
        status,
        reason: fields.statusReason,
        until: fields.suspendedUntil,
        at,
      });
      if (Option.isNone(row)) return yield* userNotFound(id);
      yield* announce(id, ["status"]);
      return yield* toUserRecord(row.value);
    }, relabel("Users.setStatus"));

    /** The row and its declared fields, atomically. The only deleter, shared by `remove` and `createWith`. */
    const removeRow = Effect.fnUntraced(function* (id: UserId) {
      const removed = yield* store.delete(id);
      if (!removed) return yield* userNotFound(id);
    }, relabel("UserRemoval.remove"));

    const createWith: UsersShape["createWith"] = (input, complete) =>
      Effect.gen(function* () {
        const user = yield* create(input);
        const value = yield* complete(user).pipe(
          Effect.onError(() => removeRow(user.id).pipe(Effect.ignoreCause({ log: true }))),
        );
        return { user, value };
      });

    const list: UsersShape["list"] = (input) =>
      store
        .listPage({ after: Option.fromNullishOr(input?.cursor), limit: listLimit(input?.limit) })
        .pipe(
          relabel("Users.list"),
          Effect.flatMap((page) =>
            Effect.map(Effect.forEach(page.items, toUserRecord), (items) => ({
              items,
              nextCursor: page.next,
            })),
          ),
        );

    /** The declared fields among `descriptors` the page holds, keyed by field key. */
    const byKey = (
      descriptors: ReadonlyArray<UserFields.Descriptor>,
      held: UserStore.FieldValues,
    ): UserFields.Values =>
      pickFields(
        Object.fromEntries(
          descriptors.flatMap((descriptor) => {
            const value = held[descriptor.column];
            return value === undefined ? [] : [[descriptor.key, value]];
          }),
        ),
        descriptors.map((descriptor) => descriptor.key),
      );

    const columnsOf = (descriptors: ReadonlyArray<UserFields.Descriptor>) =>
      descriptors.map((descriptor) => ({ name: descriptor.column, kind: descriptor.kind }));

    // U-4: every pure check runs before any I/O, so the answer to an unknown field, a refused write or an
    // invalid value does not depend on whether the user exists.
    const getFields: UsersShape["getFields"] = Effect.fnUntraced(function* (id, keys) {
      const wanted = yield* UserFields.resolve(registry, keys);
      const held = yield* store.readFields(id, columnsOf(wanted)).pipe(relabel("Users.getFields"));
      if (Option.isNone(held)) return yield* userNotFound(id);
      return byKey(wanted, held.value);
    });

    const setFields: UsersShape["setFields"] = Effect.fnUntraced(function* (id, patch, options) {
      const checked = yield* UserFields.check(registry, patch, options?.source ?? "server");
      const every = [...registry.values()];
      const at = yield* now;
      const after =
        checked.length === 0
          ? yield* store.readFields(id, columnsOf(every)).pipe(relabel("Users.setFields"))
          : yield* store
              .writeFields({
                id,
                values: Object.fromEntries(
                  checked.map(([descriptor, value]): [string, UserFields.Scalar | null] => [
                    descriptor.column,
                    value,
                  ]),
                ),
                returning: columnsOf(every),
                at,
              })
              .pipe(relabel("Users.setFields"));
      if (Option.isNone(after)) return yield* userNotFound(id);
      if (checked.length > 0) {
        yield* announce(
          id,
          checked.map(([descriptor]) => descriptor.key),
        );
      }
      return byKey(every, after.value);
    });

    const users: UsersShape = {
      create,
      createOrGet,
      findById,
      findByEmail,
      findByPhone,
      updateProfile,
      verifyEmail,
      verifyPhone,
      promoteIdentity,
      changeEmail,
      setStatus,
      createWith,
      list,
      getFields,
      setFields,
    };
    const removal: UserRemovalShape = { remove: (clearance) => removeRow(clearance.userId) };
    return Context.make(Users, users).pipe(Context.add(UserRemoval, removal));
  }),
);

/**
 * SAM-004: typed access to declared user fields. Pass the record of declarations — a composition's
 * `auth.userFields` (keys `<plugin id>_<field>`) or one plugin's own — and read and write exactly those
 * fields with their decoded types: `get` decodes what `getFields` returns (a stored value that no longer
 * decodes is a defect, the schema drifted from the data), `set` encodes the patch (`null` clears a field)
 * before `setFields` validates and gates it. `source` defaults to `"server"`.
 *
 * ```ts
 * const billing = Users.typedFields(auth.userFields);
 * yield* billing.set(userId, { billing_plan: "pro" });           // typed, server-trusted
 * const { billing_plan } = yield* billing.get(userId);            // "free" | "pro" | undefined
 * ```
 */
export const typedFields = <const F extends UserFields.Declarations>(declarations: F) => {
  const partial = Schema.Struct(declarations).mapFields(Struct.map(Schema.optionalKey));
  const decode = Schema.decodeUnknownEffect(partial);
  const encode = Schema.encodeUnknownEffect(partial);
  const keys = Object.keys(declarations);
  return {
    get: Effect.fnUntraced(function* (id: UserId) {
      const users = yield* Users;
      const values = yield* users.getFields(id, keys);
      return yield* decode(values).pipe(Effect.orDie);
    }),
    set: Effect.fnUntraced(function* (
      id: UserId,
      patch: { readonly [K in keyof F]?: F[K]["Type"] | null },
      options?: { readonly source?: UserFields.Source },
    ) {
      const users = yield* Users;
      const cleared: Record<string, null> = {};
      const written: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) cleared[key] = null;
        else if (value !== undefined) written[key] = value;
      }
      const encoded = yield* encode(written).pipe(Effect.orDie);
      const values = yield* users.setFields(id, { ...encoded, ...cleared }, options);
      return yield* decode(pickFields(values, keys)).pipe(Effect.orDie);
    }),
  };
};
