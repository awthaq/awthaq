// @awthaq/sql — Models
//
// spec/behaviors/05-persistence-stratum.md, BEH-EA-033/034.
//
// `User`/`Account`/`Session`/`VerificationToken` as `Model.Class` entities —
// one field declaration each is the source of truth, from which the
// database (`select`/`insert`/`update`) and JSON (`json`/`jsonCreate`/
// `jsonUpdate`) variants are all derived. The one exception is the
// per-dialect wire codec of the boolean/DateTime columns (TS-001,
// wayfinder ticket 29): `node:sqlite` binds and returns booleans as `0 | 1`
// and timestamps as ISO strings, while `@effect/sql-pg`'s binary protocol
// returns a JS `boolean`/`Date`, so `makeModels(dialect)` selects the
// database-variant codec of just those columns. Every JSON variant is
// byte-identical across dialects; nothing above the repository boundary can
// observe which dialect built a model.
//
// This package sits below `@awthaq/core` (spec/overview.md's stratum
// ordering) and owns the id brands (MA-008): core re-exports these types and
// keeps only a nominal constructor over each, so a key rename on either side
// breaks the bridge at compile time.

import { Defects } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Model from "effect/unstable/schema/Model";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const VerificationTokenId = Schema.String.pipe(Schema.brand("VerificationTokenId"));
export type VerificationTokenId = typeof VerificationTokenId.Type;

/**
 * SOS-008/FAMS-002: the stored shape of `users.phone` — E.164 (`+` and 2-15
 * digits, no leading zero after the `+`). Declared here for the same reason
 * `UserId` is: the model's `phone` column and core's `Phone` identity share one
 * brand, and `@awthaq/core`'s `Phone.ts` owns the normalizer that mints it.
 */
export const E164 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\+[1-9]\d{1,14}$/)),
  Schema.brand("E164"),
);
export type E164 = typeof E164.Type;

/** The SQL dialects this stratum implements (mysql is a named target, not yet wired — see `CoreMigrations.ts`). */
export type Dialect = "pg" | "sqlite";

// ---- per-dialect wire codecs (TS-001) --------------------------------------

// Built as plain functions over the dialect's DateTime codec (one call per
// dialect), so no assertion is needed to unify the two codec types. `json*`
// variants are always the ISO-string codec.
const dateTimeFields = <C extends Schema.Top>(codec: C) => ({
  /** Every variant, e.g. `VerificationReservation.expiresAt`. */
  dateTime: Model.Field({
    select: codec,
    insert: codec,
    update: codec,
    json: Schema.DateTimeUtcFromString,
    jsonCreate: Schema.DateTimeUtcFromString,
    jsonUpdate: Schema.DateTimeUtcFromString,
  }),
  /** Fixed at insert: no `update`/`jsonUpdate` variant. */
  dateTimeImmutable: Model.Field({
    select: codec,
    insert: codec,
    json: Schema.DateTimeUtcFromString,
    jsonCreate: Schema.DateTimeUtcFromString,
  }),
});

const nullableDateTimeFields = <C extends Schema.Top>(codec: C) => {
  const nullable = Schema.NullOr(codec);
  const json = Schema.NullOr(Schema.DateTimeUtcFromString);
  const jsonNullable = json.pipe(Schema.withConstructorDefault(Effect.succeed(null)));
  return {
    /** `NULL` until set; every variant. */
    nullableDateTime: Model.Field({
      select: nullable,
      insert: nullable,
      update: nullable,
      json,
      jsonCreate: json,
      jsonUpdate: json,
    }),
    /**
     * SCP-001: `NULL` unless set at insert or by a dedicated targeted write —
     * no `update`/`jsonUpdate` variant, so the generic `update` can never
     * clobber it (`users.suspendedUntil`).
     */
    nullableDateTimeInsertOnly: Model.Field({
      select: nullable,
      insert: nullable.pipe(Schema.withConstructorDefault(Effect.succeed(null))),
      json: jsonNullable,
      jsonCreate: jsonNullable,
    }),
    /**
     * As `nullableDateTime`, with a `null` constructor default in every
     * variant — exactly what the single plain schema this replaces gave the
     * pre-TS-001 model (including `update`, which the repository's own
     * writers never rely on: they always pass the whole group).
     */
    nullableDateTimeDefaultNull: Model.Field({
      select: nullable,
      insert: nullable.pipe(Schema.withConstructorDefault(Effect.succeed(null))),
      update: nullable.pipe(Schema.withConstructorDefault(Effect.succeed(null))),
      json: jsonNullable,
      jsonCreate: jsonNullable,
      jsonUpdate: jsonNullable,
    }),
  };
};

const sqliteFields = {
  // `node:sqlite` (and SQLite generally) has no boolean bind type, so this
  // needs `Schema.BooleanFromBit`'s `0 | 1` database encoding — the same
  // shape `Model.BooleanSqlite` provides, built by hand here because it
  // also needs excluding from `update`/`jsonUpdate` (BEH-EA-042).
  emailVerified: Model.Field({
    select: Schema.BooleanFromBit,
    insert: Schema.BooleanFromBit.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
    json: Schema.Boolean,
    jsonCreate: Schema.Boolean,
  }),
  // FAMS-002: `phoneVerified` mirrors `emailVerified` exactly (BEH-EA-042).
  phoneVerified: Model.Field({
    select: Schema.BooleanFromBit,
    insert: Schema.BooleanFromBit.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
    json: Schema.Boolean,
    jsonCreate: Schema.Boolean,
  }),
  dateTimeInsert: Model.DateTimeInsert,
  dateTimeUpdate: Model.DateTimeUpdate,
  ...dateTimeFields(Schema.DateTimeUtcFromString),
  ...nullableDateTimeFields(Schema.DateTimeUtcFromString),
  wireDateTime: Schema.DateTimeUtcFromString,
  wireNullableDateTime: Schema.NullOr(Schema.DateTimeUtcFromString),
  wireBoolean: Schema.BooleanFromBit,
};

const pgFields = {
  // `@effect/sql-pg` decodes OID 16 (bool) to a JS boolean and binds one
  // as-is; `BooleanFromBit` would reject every row.
  emailVerified: Model.Field({
    select: Schema.Boolean,
    insert: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
    json: Schema.Boolean,
    jsonCreate: Schema.Boolean,
  }),
  phoneVerified: Model.Field({
    select: Schema.Boolean,
    insert: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
    json: Schema.Boolean,
    jsonCreate: Schema.Boolean,
  }),
  dateTimeInsert: Model.DateTimeInsertFromDate,
  dateTimeUpdate: Model.DateTimeUpdateFromDate,
  ...dateTimeFields(Schema.DateTimeUtcFromDate),
  ...nullableDateTimeFields(Schema.DateTimeUtcFromDate),
  wireDateTime: Schema.DateTimeUtcFromDate,
  wireNullableDateTime: Schema.NullOr(Schema.DateTimeUtcFromDate),
  wireBoolean: Schema.Boolean,
};

/**
 * The per-dialect wire codecs, for record stores that declare their own
 * `SqlSchema` request/result structs rather than a `Model.Class`
 * (admin/jwt/organization/passkey/migrate-better-auth): `dateTime` is
 * `DateTimeUtcFromString` on SQLite and `DateTimeUtcFromDate` on Postgres,
 * `boolean` is `BooleanFromBit` / `Boolean`.
 */
export const dialectFields = (dialect: Dialect) =>
  dialect === "pg"
    ? {
        dateTime: pgFields.wireDateTime,
        nullableDateTime: pgFields.wireNullableDateTime,
        boolean: pgFields.wireBoolean,
      }
    : {
        dateTime: sqliteFields.wireDateTime,
        nullableDateTime: sqliteFields.wireNullableDateTime,
        boolean: sqliteFields.wireBoolean,
      };

export type DialectWire = ReturnType<typeof dialectFields>;

/**
 * Reads the ambient client's own dialect once, at layer construction.
 * `orElse` dies rather than guessing, mirroring `CoreMigrations.ts`.
 */
export const resolveDialect = (sql: SqlClient.SqlClient): Effect.Effect<Dialect> =>
  sql.onDialectOrElse({
    pg: () => Effect.succeed<Dialect>("pg"),
    sqlite: () => Effect.succeed<Dialect>("sqlite"),
    orElse: () => Defects.unsupportedDialect("models"),
  });

// ---- dialect-independent field declarations ---------------------------------
//
// `Model.Class` validates each field's variants at the declaration site, so
// the classes cannot be generic over the per-dialect fields; instead the
// dialect-independent fields of each entity are declared exactly once here and
// spread into the two per-dialect class declarations below, which add only the
// handful of boolean/DateTime columns whose wire codec differs.

/**
 * BEH-EA-041/042: `email` is compared case-insensitively unique by the
 * calling domain service (which lower-cases before every read and write);
 * `emailVerified` is excluded from the generic `update`/`jsonUpdate`
 * variants so a repository's ordinary `update` call cannot flip it —
 * only a dedicated operation (BEH-EA-042) may.
 *
 * FAMS-002/SAM-003 (wayfinder ticket 09): the domain layer's `UserIdentity`
 * union (Email | Phone | Anonymous) is stored flattened, so `users_email_unique`
 * and `users_phone_unique` stay real database constraints. Both columns are
 * nullable with a `null` constructor default (an Anonymous row sets neither),
 * and — like `emailVerified` — excluded from `update`/`jsonUpdate`: an identity
 * only changes through the repository's dedicated `promoteIdentity`/
 * `changeEmail`/`verify*` writes. SCP-001: `status` (and its reason/expiry) is
 * likewise write-gated to `setStatus`; no generic update field can touch it.
 */
const insertOnly = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Model.FieldExcept(["update", "jsonUpdate"]));

const userFields = {
  id: Model.UuidV7Insert(UserId),
  email: insertOnly(
    Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  ),
  phone: insertOnly(Schema.NullOr(E164).pipe(Schema.withConstructorDefault(Effect.succeed(null)))),
  name: Schema.String,
  // AOMS-002 (.issues/high): free-form per-user metadata this service
  // stores opaquely and never parses — the same
  // `organization_org.metadata` precedent `@awthaq/organization`'s own
  // `OrganizationRecords.ts` already uses. `NULL` means "none set"; a
  // constructor default (unlike `Account`'s always-explicit
  // `passwordHash`/`accessToken`/`refreshToken`) so every pre-existing
  // `User.insert` call site that predates this field keeps compiling
  // unchanged, matching `emailVerified`'s own default.
  metadata: Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  // BAM-009/NAM-009: an avatar URL. Client-writable like `name`, so it keeps
  // its `update` variant; `NULL` means none.
  image: Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  // SCP-001/BAM-005: ban and SCIM `active:false` are one state. The reason is
  // an operator note, never sent over the wire to the suspended user.
  status: insertOnly(
    Schema.Literals(["active", "suspended"]).pipe(
      Schema.withConstructorDefault(Effect.succeed("active")),
    ),
  ),
  statusReason: insertOnly(
    Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  ),
};

/**
 * BEH-EA-043/044/125: `(providerId, subject, issuer)` identifies at most one
 * row; `providerId = "password"` with `subject` equal to the owning `User`'s
 * own id and `issuer = ""` is the reserved password-credential shape
 * (`PASSWORD_PROVIDER_ID` in `@awthaq/core`'s `Accounts.ts`).
 * `providerId`/`subject`/`issuer`/`userId` are excluded from
 * `update`/`jsonUpdate` — this identity tuple is immutable once linked;
 * unlinking and relinking is a delete-then-insert, never an update.
 * BEH-EA-034: secret fields are `Model.Sensitive`, so none of them
 * can appear in any JSON variant regardless of what a handler returns.
 * BEH-EA-034's own illustration uses `Schema.Redacted` for a token field,
 * but `Schema.Redacted`'s *encoded* form is still a wrapped `Redacted`
 * value (only its display/inspection behavior changes) — not a bindable
 * SQL parameter, since neither `SqlClient`/`Statement` nor a driver like
 * `@effect/sql-sqlite-node` unwraps one. The database variant here is a
 * plain, nullable string; wrapping it back in `Redacted` is the
 * responsibility of whichever caller reads it out (core's eventual
 * SQL-backed `Layer`), the same boundary `Sessions.ts`/`Verification.ts`
 * already draw between their own stored plain strings and the `Redacted`
 * values they hand back to a caller.
 */
const accountFields = {
  id: Model.UuidV7Insert(AccountId),
  userId: UserId.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  providerId: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  subject: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  // BEH-EA-125/INV-EA-015 (`@awthaq/oauth`): the third component of the
  // real identity anchor, `(providerId, subject, issuer)` — `""` (not SQL
  // NULL) for a non-federated provider (`password`), specifically so the
  // real `UNIQUE(providerId, subject, issuer)` index enforces uniqueness
  // even among rows with no issuer at all; SQLite (like most SQL engines)
  // treats every NULL as distinct from every other NULL, so a nullable
  // column here would silently stop enforcing uniqueness for exactly the
  // providers most likely to only ever have one issuer-less row.
  issuer: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  passwordHash: Model.Sensitive(Schema.NullOr(Schema.String)),
  accessToken: Model.Sensitive(Schema.NullOr(Schema.String)),
  refreshToken: Model.Sensitive(Schema.NullOr(Schema.String)),
  // BAM-008: the provider's OIDC `id_token`, a bearer-grade credential like
  // the two above — sensitive, encrypted at rest. Constructor-defaulted to
  // `null` so a pre-existing insert/update call site keeps compiling; every
  // writer that rewrites a row from its old values (`updateCredentialHash`)
  // must pass it through explicitly, or the default would null it.
  idToken: Model.Sensitive(
    Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  ),
  // BE-002 (.issues/high): token *metadata*, not secrets themselves — no
  // `Model.Sensitive` (matching how `providerId`/`subject`/`issuer` already
  // sit unencrypted alongside `accessToken`/`refreshToken` on this same
  // row). Constructor-defaulted to `null` (`User.metadata`'s own
  // precedent) so a pre-existing insert/update call site that predates
  // OAuth token persistence keeps compiling unchanged; the real writers
  // (`@awthaq/core`'s `Accounts.ts` `link`/`updateProviderTokens`) always
  // pass every field of this group explicitly, never relying on the
  // default themselves. (`accessTokenExpiresAt`/`refreshTokenExpiresAt` are
  // per-dialect DateTime columns, added by each class.)
  scope: Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  tokenType: Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
};

/**
 * BEH-EA-049/050: only `SHA-256(secret)` is ever persisted — `secretHash`
 * itself is `Model.Sensitive` on top of that, so a leaked JSON variant
 * cannot even disclose the hash. BEH-EA-051/052: `absoluteExpiresAt` is
 * fixed at issue (excluded from `update`); `lastActiveAt`/`idleExpiresAt`/
 * `secretHash` are the columns the idle-refresh touch (BEH-EA-052,
 * upstream-hardening ticket 01's rotation) may write.
 */
const sessionFields = {
  id: Model.UuidV7Insert(SessionId),
  userId: UserId.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  // Ticket 01: rotation overwrites this on the same throttled touch write
  // that already refreshes `lastActiveAt`/`idleExpiresAt`, so — unlike
  // every other insert-only field on this table — it needs an `update`
  // variant. `Model.Sensitive` still omits it from every JSON variant.
  secretHash: Model.Sensitive(Schema.String),
  ipAddress: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  userAgent: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  // BEH-EA-209: the caller's own identity, immutable once issued — no
  // `update`/`jsonUpdate` variant, the same insert-only shape `secretHash`/
  // `absoluteExpiresAt` already have. Two plain nullable columns rather than
  // one JSON column: this table's own choice, not one this field's shape
  // forces on any other persistence layer.
  actingAsType: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  actingAsId: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  // RRS-003 — .scratch/resolve-ready-for-human-findings/issues/
  // 11-token-lifecycle-store.md: refresh-token reuse detection and token
  // families for the `supersedes` rotation path (see `Sessions.ts`'s own
  // header comment on `issue`/`verify` for the full mechanism). `familyId`
  // is set once, at insert — to this row's own `id` when it founds a
  // family (no `supersedes` given), or inherited from the superseded
  // row's own `familyId` otherwise — so it is always explicitly supplied
  // by `Sessions.ts`, never left to a constructor default.
  familyId: SessionId.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  /** Set at most once, when this row is superseded by a rotation — never on insert. */
  supersededBy: Schema.NullOr(SessionId),
  /**
   * THS-003/APS-007: RFC 8176 `amr` — which authentication methods proved
   * this session, as a JSON array of strings (dialect-neutral text; core
   * decodes and validates it). Written at insert; `Sessions.reauthenticate`
   * unions new methods in through its own targeted `UPDATE`, so — like
   * `actingAs` — it has no generic `update` variant.
   */
  amr: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("[]")),
    Model.FieldExcept(["update", "jsonUpdate"]),
  ),
};

/**
 * BEH-EA-057: `identifier` encodes the token's one purpose (e.g.
 * `verify-email:<userId>`); BEH-EA-060: `valueHash` is `Model.Sensitive`,
 * never the plaintext value. `consumedAt` is nullable and set exactly once
 * — BEH-EA-058's "marks consumed" is a write to this column, not a row
 * delete, so a replay (BEH-EA-059) can still be told apart from "never
 * existed" internally even though both answer the caller uniformly
 * (BEH-EA-064). Every field but `consumedAt` is excluded from
 * `update`/`jsonUpdate`: a verification token's identity and hash are
 * fixed at issue.
 *
 * BEH-EA-122 (`@awthaq/oauth`): `payload` round-trips the opaque
 * OAuth-flow state (`codeVerifier`/`nonce`/`callbackURL`/`link`) `issue`'s
 * caller attached — JSON-encoded at rest (`Schema.fromJsonString(Schema.Unknown)`)
 * since its shape is never this stratum's to know, and built as a bare
 * select/insert-only `Model.Field` (like `valueHash` above) rather than
 * `Model.Sensitive`: it needs the same "no update, no JSON variant, ever"
 * treatment `valueHash`'s own comment explains, for the same reason — flow
 * state can carry secrets a leaked JSON response must never disclose. A
 * missing payload is stored as the encoded literal `null`, decoded back to
 * `undefined` by the caller (`Verification.layerSql`'s own `toTokenView`),
 * matching `layerMemory`'s omitted-payload case (`undefined` in, `undefined`
 * out). An *explicit* `payload: null` is indistinguishable from omission once
 * round-tripped through this column, so `Verification.layerMemory` normalizes
 * it to `undefined` at `issue` too (ESS-010): both layers return the same
 * `payload` for omitted, `null` and object.
 */
const verificationTokenFields = {
  id: Model.UuidV7Insert(VerificationTokenId),
  identifier: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  /**
   * BCR-003 (.issues/high): nullable — not every token names a real user at
   * `issue` time (an OAuth sign-in flow's own state token, `@awthaq/oauth`'s
   * `OAuth.ts`, has none until the callback resolves one), unlike
   * `accounts.userId`/`sessions.userId`, which are always attached to a
   * concrete account. Set once, at insert, never updated — the identity a
   * token names does not change over its own lifetime.
   */
  userId: Schema.NullOr(UserId).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
    Model.FieldExcept(["update", "jsonUpdate"]),
  ),
  valueHash: Model.Field({ select: Schema.String, insert: Schema.String }),
  payload: Model.Field({
    select: Schema.fromJsonString(Schema.Unknown),
    insert: Schema.fromJsonString(Schema.Unknown).pipe(
      Schema.withConstructorDefault(Effect.succeed(null)),
    ),
  }),
};

/** One `auth_audit_log` row as the database returns it (`occurredAt` per-dialect, payload opaque JSON text). */
const auditLogRow = <C extends Schema.Top>(occurredAt: C) =>
  Schema.Struct({
    id: Schema.String,
    eventTag: Schema.String,
    actorUserId: Schema.NullOr(Schema.String),
    occurredAt,
    correlationId: Schema.NullOr(Schema.String),
    payload: Schema.fromJsonString(Schema.Unknown),
  });

// ---- per-dialect model sets -------------------------------------------------

// `VerificationReservation` (below, per dialect):
// BEH-EA-063/`spec/decisions/016-verification-sql-claiming.md` (ADR-EA-016):
// `VerificationReservation` is a wholly separate concept from a
// `VerificationToken` — "first caller to claim this identifier while
// unexpired wins," never a token a caller presents back. `identifier` is its
// own primary key (a plain, non-partial `UNIQUE`/`PRIMARY KEY` column): at
// most one live reservation per identifier, ever. Claiming is one atomic
// conditional upsert (`Repositories.ts`'s
// `VerificationReservationsRepository.claim`), not a generic
// `insert`/`update` pair — the model exists only to give that upsert's
// `RETURNING` row a schema to decode against.
const pgModels = () => {
  class User extends Model.Class<User>("User")({
    ...userFields,
    emailVerified: pgFields.emailVerified,
    phoneVerified: pgFields.phoneVerified,
    suspendedUntil: pgFields.nullableDateTimeInsertOnly,
    createdAt: pgFields.dateTimeInsert,
    updatedAt: pgFields.dateTimeUpdate,
  }) {}

  class Account extends Model.Class<Account>("Account")({
    ...accountFields,
    accessTokenExpiresAt: pgFields.nullableDateTimeDefaultNull,
    refreshTokenExpiresAt: pgFields.nullableDateTimeDefaultNull,
    createdAt: pgFields.dateTimeInsert,
    updatedAt: pgFields.dateTimeUpdate,
  }) {}

  class Session extends Model.Class<Session>("Session")({
    ...sessionFields,
    absoluteExpiresAt: pgFields.dateTimeImmutable,
    idleExpiresAt: pgFields.dateTimeUpdate,
    createdAt: pgFields.dateTimeInsert,
    // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
    // (AAPS-001/BPAS-001): "when this session last proved a credential" —
    // defaulted to now at insert (identical to `createdAt` at issue time),
    // and the one column `Sessions.reauthenticate` writes; needs the same
    // `update` variant `secretHash`/`lastActiveAt`/`idleExpiresAt` already
    // have, for the identical reason.
    authenticatedAt: pgFields.dateTimeUpdate,
    lastActiveAt: pgFields.dateTimeUpdate,
    /** Set at most once, alongside `supersededBy`. */
    supersededAt: pgFields.nullableDateTime,
    /** Set at most once — the first (and only ever recorded) time a tombstoned row is presented again. */
    reusedAt: pgFields.nullableDateTime,
  }) {}

  class VerificationToken extends Model.Class<VerificationToken>("VerificationToken")({
    ...verificationTokenFields,
    expiresAt: pgFields.dateTimeImmutable,
    consumedAt: pgFields.nullableDateTime,
    createdAt: pgFields.dateTimeInsert,
  }) {}

  class VerificationReservation extends Model.Class<VerificationReservation>(
    "VerificationReservation",
  )({
    identifier: Schema.String,
    expiresAt: pgFields.dateTime,
  }) {}

  return {
    User,
    Account,
    Session,
    VerificationToken,
    VerificationReservation,
    AuditLogRow: auditLogRow(pgFields.wireDateTime),
    wire: dialectFields("pg"),
  };
};

const sqliteModels = () => {
  class User extends Model.Class<User>("User")({
    ...userFields,
    emailVerified: sqliteFields.emailVerified,
    phoneVerified: sqliteFields.phoneVerified,
    suspendedUntil: sqliteFields.nullableDateTimeInsertOnly,
    createdAt: sqliteFields.dateTimeInsert,
    updatedAt: sqliteFields.dateTimeUpdate,
  }) {}

  class Account extends Model.Class<Account>("Account")({
    ...accountFields,
    accessTokenExpiresAt: sqliteFields.nullableDateTimeDefaultNull,
    refreshTokenExpiresAt: sqliteFields.nullableDateTimeDefaultNull,
    createdAt: sqliteFields.dateTimeInsert,
    updatedAt: sqliteFields.dateTimeUpdate,
  }) {}

  class Session extends Model.Class<Session>("Session")({
    ...sessionFields,
    absoluteExpiresAt: sqliteFields.dateTimeImmutable,
    idleExpiresAt: sqliteFields.dateTimeUpdate,
    createdAt: sqliteFields.dateTimeInsert,
    authenticatedAt: sqliteFields.dateTimeUpdate,
    lastActiveAt: sqliteFields.dateTimeUpdate,
    supersededAt: sqliteFields.nullableDateTime,
    reusedAt: sqliteFields.nullableDateTime,
  }) {}

  class VerificationToken extends Model.Class<VerificationToken>("VerificationToken")({
    ...verificationTokenFields,
    expiresAt: sqliteFields.dateTimeImmutable,
    consumedAt: sqliteFields.nullableDateTime,
    createdAt: sqliteFields.dateTimeInsert,
  }) {}

  class VerificationReservation extends Model.Class<VerificationReservation>(
    "VerificationReservation",
  )({
    identifier: Schema.String,
    expiresAt: sqliteFields.dateTime,
  }) {}

  return {
    User,
    Account,
    Session,
    VerificationToken,
    VerificationReservation,
    AuditLogRow: auditLogRow(sqliteFields.wireDateTime),
    wire: dialectFields("sqlite"),
  };
};

/**
 * TS-001: the four `Model.Class` entities (plus the reservation and audit-log
 * row schemas) with the database variants' boolean/DateTime codecs selected
 * for `dialect`. `Repositories.ts` resolves the dialect once per layer from
 * the ambient `SqlClient` (`resolveDialect`); the pg client's own codecs are
 * never overridden globally, because the ambient client is shared with the
 * host application's tables.
 */
export const makeModels = (dialect: Dialect) => (dialect === "pg" ? pgModels() : sqliteModels());

export type SqlModels = ReturnType<typeof makeModels>;

// The decoded `Type` side is identical across dialects (only `Encoded`
// differs), so these dialect-independent aliases are what callers name.
export type User = InstanceType<SqlModels["User"]>;
export type Account = InstanceType<SqlModels["Account"]>;
export type Session = InstanceType<SqlModels["Session"]>;
export type VerificationToken = InstanceType<SqlModels["VerificationToken"]>;
export type VerificationReservation = InstanceType<SqlModels["VerificationReservation"]>;

// Constructor-level input shapes (`insert`/`update` variants' decoded `Type`
// side), likewise identical across dialects.
export type UserInsert = SqlModels["User"]["insert"]["Type"];
export type UserUpdate = SqlModels["User"]["update"]["Type"];
export type AccountInsert = SqlModels["Account"]["insert"]["Type"];
export type AccountUpdate = SqlModels["Account"]["update"]["Type"];
export type SessionInsert = SqlModels["Session"]["insert"]["Type"];
export type SessionUpdate = SqlModels["Session"]["update"]["Type"];
export type VerificationTokenInsert = SqlModels["VerificationToken"]["insert"]["Type"];
export type VerificationTokenUpdate = SqlModels["VerificationToken"]["update"]["Type"];
