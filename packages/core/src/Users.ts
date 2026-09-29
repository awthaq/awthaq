// @awthaq/core — Users
//
// spec/behaviors/06-domain-users-accounts.md, BEH-EA-041, BEH-EA-042.
// Two `Layer`s over the same `UsersShape`: `layerMemory` (a `Ref`) and
// `layerSql` (`@awthaq/sql`'s `Model.Class`/repository, BEH-EA-033–036)
// — neither changes this service's public interface, the same deferral
// `Migrations.ts` documents for the persistence stratum generally.

import { Defects } from "@awthaq/ports";
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
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { orStoreUnavailable, storeUnavailable, type StoreUnavailable } from "./Errors.ts";
import * as HookPoint from "./HookPoint.ts";
import * as Hooks from "./Hooks.ts";
import type * as Phone from "./Phone.ts";
import * as Tenant from "./Tenant.ts";
import * as UserFields from "./UserFields.ts";

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
   * AOMS-006/CSG-002 (.issues/high): consults `Hooks.BeforeUserDelete`
   * (BEH-EA-095's own worked example — an Invite-purge veto) after the
   * existence check, before the row is actually removed; a tap's abort
   * surfaces as `HookPoint.HookAborted`, never a bare defect.
   */
  readonly delete: (
    id: UserId,
  ) => Effect.Effect<void, UserNotFound | HookPoint.HookAborted | StoreUnavailable>;
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

/** `Hooks.BeforeUserDelete`'s payload: an Anonymous/Phone user has no email to report. */
const deleteHookInput = (record: UserRecord) =>
  Option.match(emailOf(record), {
    onNone: () => ({ id: record.id }),
    onSome: (email) => ({ id: record.id, email }),
  });

interface State {
  readonly byId: HashMap.HashMap<UserId, UserRecord>;
  readonly byEmail: HashMap.HashMap<string, UserId>;
  readonly byPhone: HashMap.HashMap<string, UserId>;
}

const indexRecord = (s: State, record: UserRecord): State => {
  const byId = HashMap.set(s.byId, record.id, record);
  switch (record.identity._tag) {
    case "Email":
      return { ...s, byId, byEmail: HashMap.set(s.byEmail, record.identity.email, record.id) };
    case "Phone":
      return { ...s, byId, byPhone: HashMap.set(s.byPhone, record.identity.phone, record.id) };
    case "Anonymous":
      return { ...s, byId };
  }
};

const unindexRecord = (s: State, record: UserRecord): State => {
  const byId = HashMap.remove(s.byId, record.id);
  switch (record.identity._tag) {
    case "Email":
      return { ...s, byId, byEmail: HashMap.remove(s.byEmail, record.identity.email) };
    case "Phone":
      return { ...s, byId, byPhone: HashMap.remove(s.byPhone, record.identity.phone) };
    case "Anonymous":
      return { ...s, byId };
  }
};

/** The user already holding `identity`'s uniqueness key, if any (never for Anonymous). */
const holderOf = (s: State, identity: IdentityInput): Option.Option<UserRecord> => {
  const id =
    identity._tag === "Email"
      ? HashMap.get(s.byEmail, identity.email)
      : identity._tag === "Phone"
        ? HashMap.get(s.byPhone, identity.phone)
        : Option.none<UserId>();
  return Option.flatMap(id, (userId) => HashMap.get(s.byId, userId));
};

const emptyState: State = {
  byId: HashMap.empty(),
  byEmail: HashMap.empty(),
  byPhone: HashMap.empty(),
};

const identityFromInput = (identity: IdentityInput): UserIdentity => {
  switch (identity._tag) {
    case "Email":
      return { _tag: "Email", email: identity.email, emailVerified: false };
    case "Phone":
      return { _tag: "Phone", phone: identity.phone, phoneVerified: false };
    case "Anonymous":
      return { _tag: "Anonymous" };
  }
};

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
      // SAM-004: the declared fields, beside (not inside) the user record.
      const registry = yield* UserFields.UserFieldRegistry;
      const heldFields = yield* Ref.make(HashMap.empty<UserId, UserFields.Values>());

      const findById: UsersShape["findById"] = (id) =>
        Ref.get(state).pipe(
          Effect.flatMap((s) =>
            Option.match(HashMap.get(s.byId, id), {
              onNone: () => Effect.fail(userNotFound(id)),
              onSome: Effect.succeed,
            }),
          ),
        );

      const findByEmail: UsersShape["findByEmail"] = (email) =>
        Ref.get(state).pipe(
          Effect.map((s) => holderOf(s, { _tag: "Email", email: email.toLowerCase() })),
        );

      const findByPhone: UsersShape["findByPhone"] = (phone) =>
        Ref.get(state).pipe(Effect.map((s) => holderOf(s, { _tag: "Phone", phone })));

      // SCP-003: one `Ref.modify` decides "insert or return the holder", so a
      // concurrent pair cannot both insert. `Result.fail` carries the holder.
      const insertOrHolder = Effect.fnUntraced(function* (input: CreateInput) {
        const identity = normalizeIdentity(input.identity);
        const id = UserId(
          yield* crypto.randomUUIDv7.pipe(
            Effect.catchTag("PlatformError", storeUnavailable("Users.create")),
          ),
        );
        const timestamp = yield* now;
        const tenantId = yield* Tenant.TenantContext;
        const record: UserRecord = {
          id,
          identity: identityFromInput(identity),
          name: input.name,
          metadata: Option.fromNullishOr(input.metadata),
          image: Option.fromNullishOr(input.image),
          tenantId,
          status: "active",
          statusReason: Option.none(),
          suspendedUntil: Option.none(),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const outcome = yield* Ref.modify(
          state,
          (s): readonly [Result.Result<UserRecord, UserRecord>, State] => {
            const holder = holderOf(s, identity);
            return Option.isSome(holder)
              ? ([Result.fail(holder.value), s] as const)
              : ([Result.succeed(record), indexRecord(s, record)] as const);
          },
        );
        return { identity, outcome };
      });

      const create: UsersShape["create"] = Effect.fnUntraced(function* (input) {
        const { identity, outcome } = yield* insertOrHolder(input);
        return yield* Result.match(outcome, {
          onFailure: () => identityAlreadyExists(identity),
          onSuccess: Effect.succeed,
        });
      });

      const createOrGet: UsersShape["createOrGet"] = Effect.fnUntraced(function* (input) {
        const { outcome } = yield* insertOrHolder(input);
        return Result.match(outcome, {
          onFailure: (user) => ({ user, created: false }),
          onSuccess: (user) => ({ user, created: true }),
        });
      });

      /** One atomic read-check-write over a single user; `step` decides, `Ref.modify` applies. */
      const transition = <E>(
        id: UserId,
        step: (
          existing: UserRecord,
          s: State,
        ) => Result.Result<
          { readonly next: State; readonly record: UserRecord; readonly changed: boolean },
          E
        >,
      ): Effect.Effect<readonly [UserRecord, boolean], UserNotFound | E> =>
        Ref.modify(
          state,
          (
            s,
          ): readonly [Result.Result<readonly [UserRecord, boolean], UserNotFound | E>, State] => {
            const existing = HashMap.get(s.byId, id);
            if (Option.isNone(existing)) return [Result.fail(userNotFound(id)), s] as const;
            return Result.match(step(existing.value, s), {
              onFailure: (error) => [Result.fail(error), s] as const,
              onSuccess: ({ next, record, changed }) =>
                [Result.succeed([record, changed] as const), next] as const,
            });
          },
        ).pipe(Effect.flatMap(Effect.fromResult));

      /** Rewrites the stored record, leaving both unique indexes untouched. */
      const replaceRecord = (s: State, record: UserRecord): State => ({
        ...s,
        byId: HashMap.set(s.byId, record.id, record),
      });

      const updateProfile: UsersShape["updateProfile"] = (id, input) =>
        transition(id, (existing, s) => {
          const updated: UserRecord = {
            ...existing,
            name: input.name,
            metadata:
              input.metadata === undefined
                ? existing.metadata
                : Option.fromNullishOr(input.metadata),
            image: input.image === undefined ? existing.image : Option.fromNullishOr(input.image),
          };
          return Result.succeed({
            next: replaceRecord(s, updated),
            record: updated,
            changed: true,
          });
        }).pipe(
          Effect.tap(([record]) => announce(record.id, ["name"])),
          Effect.map(([record]) => record),
        );

      const verifyEmail: UsersShape["verifyEmail"] = (id) =>
        transition(id, (existing, s) => {
          const identity = existing.identity;
          if (identity._tag !== "Email") {
            return Result.fail(identityMismatch(id, "Email", identity._tag));
          }
          if (identity.emailVerified) {
            return Result.succeed({ next: s, record: existing, changed: false });
          }
          const updated: UserRecord = {
            ...existing,
            identity: { ...identity, emailVerified: true },
          };
          return Result.succeed({
            next: replaceRecord(s, updated),
            record: updated,
            changed: true,
          });
        }).pipe(
          Effect.tap(([record, changed]) =>
            changed ? announce(record.id, ["emailVerified"]) : Effect.void,
          ),
          Effect.map(([record]) => record),
        );

      const verifyPhone: UsersShape["verifyPhone"] = (id) =>
        transition(id, (existing, s) => {
          const identity = existing.identity;
          if (identity._tag !== "Phone") {
            return Result.fail(identityMismatch(id, "Phone", identity._tag));
          }
          if (identity.phoneVerified) {
            return Result.succeed({ next: s, record: existing, changed: false });
          }
          const updated: UserRecord = {
            ...existing,
            identity: { ...identity, phoneVerified: true },
          };
          return Result.succeed({
            next: replaceRecord(s, updated),
            record: updated,
            changed: true,
          });
        }).pipe(Effect.map(([record]) => record));

      const promoteIdentity: UsersShape["promoteIdentity"] = (id, requested) => {
        const wanted = normalizePromoted(requested);
        return transition<IdentityMismatch | EmailAlreadyExists | PhoneAlreadyExists>(
          id,
          (existing, s) => {
            if (existing.identity._tag !== "Anonymous") {
              return Result.fail(identityMismatch(id, "Anonymous", existing.identity._tag));
            }
            if (Option.isSome(holderOf(s, wanted))) return Result.fail(alreadyExists(wanted));
            const updated: UserRecord = { ...existing, identity: identityFromInput(wanted) };
            return Result.succeed({
              next: indexRecord(s, updated),
              record: updated,
              changed: true,
            });
          },
        ).pipe(Effect.map(([record]) => record));
      };

      const changeEmail: UsersShape["changeEmail"] = (id, requested) => {
        const email = requested.toLowerCase();
        return transition<IdentityMismatch | EmailAlreadyExists>(id, (existing, s) => {
          const identity = existing.identity;
          if (identity._tag !== "Email") {
            return Result.fail(identityMismatch(id, "Email", identity._tag));
          }
          if (identity.email === email) {
            return Result.succeed({ next: s, record: existing, changed: false });
          }
          if (HashMap.has(s.byEmail, email)) {
            return Result.fail(emailExists(email));
          }
          const updated: UserRecord = {
            ...existing,
            identity: { _tag: "Email", email, emailVerified: false },
          };
          return Result.succeed({
            next: indexRecord(unindexRecord(s, existing), updated),
            record: updated,
            changed: identity.emailVerified,
          });
        }).pipe(
          Effect.tap(([record, lowered]) =>
            lowered ? announce(record.id, ["emailVerified"]) : Effect.void,
          ),
          Effect.map(([record]) => record),
        );
      };

      const setStatus: UsersShape["setStatus"] = (id, status, options) =>
        transition(id, (existing, s) => {
          const updated: UserRecord = { ...existing, status, ...statusFields(status, options) };
          return Result.succeed({
            next: replaceRecord(s, updated),
            record: updated,
            changed: true,
          });
        }).pipe(
          Effect.tap(([record]) => announce(record.id, ["status"])),
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
          const existing = yield* findById(id);
          yield* beforeUserDeleteVeto(beforeDelete.run(deleteHookInput(existing)));
          yield* Ref.update(state, (s) => unindexRecord(s, existing));
          yield* Ref.update(heldFields, HashMap.remove(id));
        });

      const getFields: UsersShape["getFields"] = Effect.fnUntraced(function* (id, keys) {
        yield* findById(id);
        const wanted = yield* UserFields.resolve(registry, keys);
        const held = yield* Ref.get(heldFields).pipe(
          Effect.map((all) => Option.getOrElse(HashMap.get(all, id), () => ({}))),
        );
        return pickFields(
          held,
          wanted.map((descriptor) => descriptor.key),
        );
      });

      const setFields: UsersShape["setFields"] = Effect.fnUntraced(function* (id, patch, options) {
        yield* findById(id);
        const checked = yield* UserFields.check(registry, patch, options?.source ?? "server");
        const next = yield* Ref.modify(
          heldFields,
          (all): readonly [UserFields.Values, HashMap.HashMap<UserId, UserFields.Values>] => {
            const merged: Record<string, UserFields.Scalar> = {
              ...Option.getOrElse(HashMap.get(all, id), () => ({})),
            };
            for (const [descriptor, value] of checked) {
              if (value === null) delete merged[descriptor.key];
              else merged[descriptor.key] = value;
            }
            return [merged, HashMap.set(all, id, merged)];
          },
        );
        if (checked.length > 0) {
          yield* announce(
            id,
            checked.map(([descriptor]) => descriptor.key),
          );
        }
        return pickFields(next, [...registry.keys()]);
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

      return {
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
        delete: delete_,
        list,
        getFields,
        setFields,
      };
    }),
  );

/**
 * FAMS-002: folds the flattened `email`/`phone` columns into the identity union
 * — the one place that reads them. A row with both set is not a state any
 * writer here produces (the union says a user has one identity), so it dies
 * with a defect rather than picking a side silently.
 */
const toIdentity = (row: SqlModels.User): Effect.Effect<UserIdentity> => {
  if (row.email !== null && row.phone !== null) {
    return Defects.invariantViolation(
      "UserIdentityAmbiguous",
      "awthaq: a user row has both an email and a phone",
    );
  }
  if (row.email !== null) {
    return Effect.succeed({ _tag: "Email", email: row.email, emailVerified: row.emailVerified });
  }
  if (row.phone !== null) {
    return Effect.succeed({ _tag: "Phone", phone: row.phone, phoneVerified: row.phoneVerified });
  }
  return Effect.succeed({ _tag: "Anonymous" });
};

const toUserRecord = (row: SqlModels.User): Effect.Effect<UserRecord> =>
  Effect.map(toIdentity(row), (identity) => ({
    id: UserId(row.id),
    identity,
    name: row.name,
    metadata: Option.fromNullOr(row.metadata),
    image: Option.fromNullOr(row.image),
    tenantId: Option.fromNullOr(row.tenantId),
    status: row.status,
    statusReason: Option.fromNullOr(row.statusReason),
    suspendedUntil: Option.fromNullOr(row.suspendedUntil),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

const toUserRecordOption = (
  row: Option.Option<SqlModels.User>,
): Effect.Effect<Option.Option<UserRecord>> =>
  Option.match(row, {
    onNone: () => Effect.succeedNone,
    onSome: (found) => Effect.map(toUserRecord(found), Option.some),
  });

/**
 * BEH-EA-041's uniqueness is a real database constraint here (a `UNIQUE`
 * index on `lower(email)`, declared by whichever schema/migration creates
 * the `users` table) rather than `layerMemory`'s in-process `HashMap`
 * check — a duplicate `create` surfaces as `SqlError`'s `UniqueViolation`
 * reason, mapped to `EmailAlreadyExists`; every other repository failure
 * (a schema mismatch, a dropped connection) is a genuine defect, not a
 * domain error this service's callers are meant to recover from, so it is
 * left to `die`. FAMS-002: the same holds for the partial `users_phone_unique`
 * index and `PhoneAlreadyExists`.
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
    // SAM-004: the composition's declared fields; their columns exist because `Auth.make`'s generated migrations added them.
    const registry = yield* UserFields.UserFieldRegistry;

    /** The declared fields of `descriptors` that `id` holds a value for, or `UserNotFound`. */
    const readDeclared = (
      operation: string,
      id: UserId,
      descriptors: ReadonlyArray<UserFields.Descriptor>,
    ) =>
      repo
        .readFields(
          id,
          descriptors.map((descriptor) => ({ name: descriptor.column, kind: descriptor.kind })),
        )
        .pipe(
          orStoreUnavailable(operation),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(userNotFound(id)),
              onSome: (byColumn) =>
                Effect.succeed(
                  pickFields(
                    Object.fromEntries(
                      descriptors.flatMap((descriptor) => {
                        const value = byColumn[descriptor.column];
                        return value === undefined ? [] : [[descriptor.key, value]];
                      }),
                    ),
                    descriptors.map((descriptor) => descriptor.key),
                  ),
                ),
            }),
          ),
        );

    const buildInsert = (input: CreateInput, identity: IdentityInput) =>
      repo.models.User.insert
        .makeEffect({
          email: identity._tag === "Email" ? identity.email : null,
          phone: identity._tag === "Phone" ? identity.phone : null,
          name: input.name,
          metadata: input.metadata ?? null,
          image: input.image ?? null,
        })
        .pipe(Effect.orDie);

    /** A `UniqueViolation` is the domain conflict for `identity`; any other `SqlError` is an outage (`StoreUnavailable`). */
    const conflictOrUnavailable = (operation: string, identity: IdentityInput) =>
      Effect.fnUntraced(function* (error: SqlError) {
        if (error.reason._tag === "UniqueViolation") return yield* identityAlreadyExists(identity);
        return yield* storeUnavailable(operation)(error);
      });

    const emailConflictOrUnavailable = (operation: string, email: string) =>
      Effect.fnUntraced(function* (error: SqlError) {
        if (error.reason._tag === "UniqueViolation") return yield* Effect.fail(emailExists(email));
        return yield* storeUnavailable(operation)(error);
      });

    const create: UsersShape["create"] = Effect.fnUntraced(function* (input) {
      const identity = normalizeIdentity(input.identity);
      const insert = yield* buildInsert(input, identity);
      const row = yield* repo
        .insert(insert)
        .pipe(
          Effect.catchTag("SqlError", conflictOrUnavailable("Users.create", identity)),
          Effect.catchTag("SchemaError", Effect.die),
        );
      return yield* toUserRecord(row);
    });

    const findById: UsersShape["findById"] = (id) =>
      repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () => Effect.fail(userNotFound(id)),
          SchemaError: Effect.die,
          SqlError: storeUnavailable("Users.findById"),
        }),
        Effect.flatMap(toUserRecord),
      );

    const findByEmail: UsersShape["findByEmail"] = (email) =>
      repo
        .findByEmail(email.toLowerCase())
        .pipe(orStoreUnavailable("Users.findByEmail"), Effect.flatMap(toUserRecordOption));

    const findByPhone: UsersShape["findByPhone"] = (phone) =>
      repo
        .findByPhone(phone)
        .pipe(orStoreUnavailable("Users.findByPhone"), Effect.flatMap(toUserRecordOption));

    // SCP-003: `INSERT ... ON CONFLICT DO NOTHING` (not catch-the-violation):
    // a Postgres unique violation would abort an enclosing transaction, and an
    // import runs one per user.
    const createOrGet: UsersShape["createOrGet"] = Effect.fnUntraced(function* (input) {
      const identity = normalizeIdentity(input.identity);
      const insert = yield* buildInsert(input, identity);
      const inserted = yield* repo
        .insertIfAbsent(insert)
        .pipe(orStoreUnavailable("Users.createOrGet"));
      if (Option.isSome(inserted)) {
        return { user: yield* toUserRecord(inserted.value), created: true };
      }
      const holder =
        identity._tag === "Email"
          ? yield* findByEmail(identity.email)
          : identity._tag === "Phone"
            ? yield* findByPhone(identity.phone)
            : Option.none<UserRecord>();
      // `None` here means the holder vanished between the two statements, or an
      // Anonymous insert hit a primary-key collision — neither is a domain state.
      return yield* Option.match(holder, {
        onNone: () =>
          Defects.invariantViolation(
            "CreateOrGetRowVanished",
            "awthaq: createOrGet found no row after a conflict",
          ),
        onSome: (user) => Effect.succeed({ user, created: false }),
      });
    });

    // GC-004: one targeted statement, so a row deleted between the caller's read and this write is
    // `UserNotFound` — what `layerMemory` answers — not a defect, and no other column is rewritten
    // from a stale read.
    const updateProfile: UsersShape["updateProfile"] = Effect.fnUntraced(function* (id, input) {
      const row = yield* repo
        .updateProfile({ id, name: input.name, metadata: input.metadata, image: input.image })
        .pipe(orStoreUnavailable("Users.updateProfile"));
      if (Option.isNone(row)) return yield* Effect.fail(userNotFound(id));
      yield* announce(id, ["name"]);
      return yield* toUserRecord(row.value);
    });

    // `emailVerified` is excluded from the generic `update`/`jsonUpdate`
    // variants (BEH-EA-042) — flipping it goes through the repository's own
    // dedicated `verifyEmail` operation, which is the only write that can
    // touch that column at all.
    const verifyEmail: UsersShape["verifyEmail"] = Effect.fnUntraced(function* (id) {
      const existing = yield* findById(id);
      if (existing.identity._tag !== "Email") {
        return yield* Effect.fail(identityMismatch(id, "Email", existing.identity._tag));
      }
      if (existing.identity.emailVerified) return existing;
      const row = yield* repo.verifyEmail(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () => Effect.fail(userNotFound(id)),
          SchemaError: Effect.die,
          SqlError: storeUnavailable("Users.verifyEmail"),
        }),
      );
      yield* announce(id, ["emailVerified"]);
      return yield* toUserRecord(row);
    });

    const verifyPhone: UsersShape["verifyPhone"] = Effect.fnUntraced(function* (id) {
      const existing = yield* findById(id);
      if (existing.identity._tag !== "Phone") {
        return yield* Effect.fail(identityMismatch(id, "Phone", existing.identity._tag));
      }
      if (existing.identity.phoneVerified) return existing;
      const row = yield* repo.verifyPhone(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () => Effect.fail(userNotFound(id)),
          SchemaError: Effect.die,
          SqlError: storeUnavailable("Users.verifyPhone"),
        }),
      );
      return yield* toUserRecord(row);
    });

    const promoteIdentity: UsersShape["promoteIdentity"] = Effect.fnUntraced(
      function* (id, requested) {
        const wanted = normalizePromoted(requested);
        const existing = yield* findById(id);
        if (existing.identity._tag !== "Anonymous") {
          return yield* Effect.fail(identityMismatch(id, "Anonymous", existing.identity._tag));
        }
        const promoted = yield* repo
          .promoteIdentity(id, wanted)
          .pipe(
            Effect.catchTag("SqlError", conflictOrUnavailable("Users.promoteIdentity", wanted)),
            Effect.catchTag("SchemaError", Effect.die),
          );
        if (Option.isNone(promoted)) {
          // Lost a race: another promotion landed between the read and the guarded UPDATE.
          const current = yield* findById(id);
          return yield* Effect.fail(identityMismatch(id, "Anonymous", current.identity._tag));
        }
        return yield* toUserRecord(promoted.value);
      },
    );

    const changeEmail: UsersShape["changeEmail"] = Effect.fnUntraced(function* (id, requested) {
      const email = requested.toLowerCase();
      const existing = yield* findById(id);
      const identity = existing.identity;
      if (identity._tag !== "Email") {
        return yield* Effect.fail(identityMismatch(id, "Email", identity._tag));
      }
      if (identity.email === email) return existing;
      const changed = yield* repo
        .changeEmail(id, email)
        .pipe(
          Effect.catchTag("SqlError", emailConflictOrUnavailable("Users.changeEmail", email)),
          Effect.catchTag("SchemaError", Effect.die),
        );
      if (Option.isNone(changed)) {
        const current = yield* findById(id);
        return yield* Effect.fail(identityMismatch(id, "Email", current.identity._tag));
      }
      if (identity.emailVerified) yield* announce(id, ["emailVerified"]);
      return yield* toUserRecord(changed.value);
    });

    const setStatus: UsersShape["setStatus"] = Effect.fnUntraced(function* (id, status, options) {
      const fields = statusFields(status, options);
      const row = yield* repo
        .setStatus(id, {
          status,
          reason: Option.getOrNull(fields.statusReason),
          until: Option.getOrNull(fields.suspendedUntil),
        })
        .pipe(
          Effect.catchTags({
            NoSuchElementError: () => Effect.fail(userNotFound(id)),
            SchemaError: Effect.die,
            SqlError: storeUnavailable("Users.setStatus"),
          }),
        );
      yield* announce(id, ["status"]);
      return yield* toUserRecord(row);
    });

    const delete_: UsersShape["delete"] = Effect.fnUntraced(function* (id) {
      const found = yield* findById(id);
      yield* beforeUserDeleteVeto(beforeDelete.run(deleteHookInput(found)));
      yield* repo.delete(id).pipe(orStoreUnavailable("Users.delete"));
    });

    const list: UsersShape["list"] = (input) =>
      repo.listPage(input?.cursor, input?.limit).pipe(
        orStoreUnavailable("Users.list"),
        Effect.flatMap((page) =>
          Effect.map(Effect.forEach(page.items, toUserRecord), (items) => ({
            items,
            nextCursor: page.nextCursor,
          })),
        ),
      );

    const getFields: UsersShape["getFields"] = Effect.fnUntraced(function* (id, keys) {
      const wanted = yield* UserFields.resolve(registry, keys);
      return yield* readDeclared("Users.getFields", id, wanted);
    });

    const setFields: UsersShape["setFields"] = Effect.fnUntraced(function* (id, patch, options) {
      const checked = yield* UserFields.check(registry, patch, options?.source ?? "server");
      if (checked.length > 0) {
        const written = yield* repo
          .writeFields(
            id,
            Object.fromEntries(
              checked.map(([descriptor, value]): [string, UserFields.Scalar | null] => [
                descriptor.column,
                value,
              ]),
            ),
          )
          .pipe(orStoreUnavailable("Users.setFields"));
        if (!written) return yield* Effect.fail(userNotFound(id));
        yield* announce(
          id,
          checked.map(([descriptor]) => descriptor.key),
        );
      }
      return yield* readDeclared("Users.setFields", id, [...registry.values()]);
    });

    return {
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
      delete: delete_,
      list,
      getFields,
      setFields,
    };
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
