// @effect-auth/sql — Models
//
// spec/behaviors/05-persistence-stratum.md, BEH-EA-033/034.
//
// `User`/`Account`/`Session`/`VerificationToken` as `Model.Class` entities —
// one field declaration each is the source of truth, from which the
// database (`select`/`insert`/`update`) and JSON (`json`/`jsonCreate`/
// `jsonUpdate`) variants are all derived. This package sits below
// `@effect-auth/core` (spec/overview.md's stratum ordering), so these ids
// are declared as ordinary branded schemas here, not imported from core's
// own `UserId`/`SessionId`/`AccountId`/`VerificationTokenId` — the two are
// structurally compatible (a `Brand<Keys>`'s uniqueness comes from the
// literal string key, not a runtime symbol), and it is core's eventual
// SQL-backed `Layer` that bridges between the two, the same way it already
// bridges from an in-memory `Ref` today.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Model } from "effect/unstable/schema";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const VerificationTokenId = Schema.String.pipe(Schema.brand("VerificationTokenId"));
export type VerificationTokenId = typeof VerificationTokenId.Type;

/**
 * BEH-EA-041/042: `email` is compared case-insensitively unique by the
 * calling domain service (which lower-cases before every read and write);
 * `emailVerified` is excluded from the generic `update`/`jsonUpdate`
 * variants so a repository's ordinary `update` call cannot flip it —
 * only a dedicated operation (BEH-EA-042) may.
 */
export class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert(UserId),
  email: Schema.String,
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
  name: Schema.String,
  createdAt: Model.DateTimeInsert,
  updatedAt: Model.DateTimeUpdate,
}) {}

/**
 * BEH-EA-043/044/125: `(providerId, subject, issuer)` identifies at most one
 * row; `providerId = "password"` with `subject` equal to the owning `User`'s
 * own id and `issuer = ""` is the reserved password-credential shape
 * (`PASSWORD_PROVIDER_ID` in `@effect-auth/core`'s `Accounts.ts`).
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
export class Account extends Model.Class<Account>("Account")({
  id: Model.UuidV7Insert(AccountId),
  userId: UserId.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  providerId: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  subject: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  // BEH-EA-125/INV-EA-015 (`@effect-auth/oauth`): the third component of the
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
  createdAt: Model.DateTimeInsert,
  updatedAt: Model.DateTimeUpdate,
}) {}

/**
 * BEH-EA-049/050: only `SHA-256(secret)` is ever persisted — `secretHash`
 * itself is `Model.Sensitive` on top of that, so a leaked JSON variant
 * cannot even disclose the hash. BEH-EA-051/052: `absoluteExpiresAt` is
 * fixed at issue (excluded from `update`); `lastActiveAt`/`idleExpiresAt`
 * are the only columns the idle-refresh touch (BEH-EA-052) may write.
 */
export class Session extends Model.Class<Session>("Session")({
  id: Model.UuidV7Insert(SessionId),
  userId: UserId.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  // `Model.Sensitive` alone omits every JSON variant but keeps `update`; a
  // hash that is also immutable once issued needs both, so it is built
  // directly as a bare `select`/`insert`-only field (no `update`, no JSON
  // variant of any kind) rather than composed from `Sensitive`.
  secretHash: Model.Field({ select: Schema.String, insert: Schema.String }),
  ipAddress: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  userAgent: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  absoluteExpiresAt: Schema.DateTimeUtcFromString.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  idleExpiresAt: Model.DateTimeUpdate,
  createdAt: Model.DateTimeInsert,
  lastActiveAt: Model.DateTimeUpdate,
  // BEH-EA-209: the caller's own identity, immutable once issued — no
  // `update`/`jsonUpdate` variant, the same insert-only shape `secretHash`/
  // `absoluteExpiresAt` already have. Two plain nullable columns rather than
  // one JSON column: this table's own choice, not one this field's shape
  // forces on any other persistence layer.
  actingAsType: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  actingAsId: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
}) {}

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
 * BEH-EA-122 (`@effect-auth/oauth`): `payload` round-trips the opaque
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
 * out). This only covers "no payload was passed" — an *explicit*
 * `payload: null` is indistinguishable from omission once round-tripped
 * through this column (both decode back to `undefined`), whereas
 * `layerMemory` stores and returns whatever was passed verbatim, `null`
 * included. No current caller ever passes an explicit `null` (only a real
 * object or nothing at all), so this asymmetry is latent, not reachable
 * today — flagged here rather than silently relied upon.
 */
export class VerificationToken extends Model.Class<VerificationToken>("VerificationToken")({
  id: Model.UuidV7Insert(VerificationTokenId),
  identifier: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  valueHash: Model.Field({ select: Schema.String, insert: Schema.String }),
  expiresAt: Schema.DateTimeUtcFromString.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Model.DateTimeInsert,
  payload: Model.Field({
    select: Schema.fromJsonString(Schema.Unknown),
    insert: Schema.fromJsonString(Schema.Unknown).pipe(
      Schema.withConstructorDefault(Effect.succeed(null)),
    ),
  }),
}) {}

/**
 * BEH-EA-063/`spec/decisions/016-verification-sql-claiming.md` (ADR-EA-016):
 * a wholly separate concept from a `VerificationToken` — "first caller to
 * claim this identifier while unexpired wins," never a token a caller
 * presents back. `identifier` is this table's own primary key (a plain,
 * non-partial `UNIQUE`/`PRIMARY KEY` column): at most one live reservation
 * per identifier, ever. Claiming is one atomic conditional upsert
 * (`Repositories.ts`'s `VerificationReservationsRepository.claim`), not a
 * generic `insert`/`update` pair — this model exists only to give that
 * upsert's `RETURNING` row a schema to decode against.
 */
export class VerificationReservation extends Model.Class<VerificationReservation>(
  "VerificationReservation",
)({
  identifier: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}
