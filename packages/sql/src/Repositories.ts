// @awthaq/sql — Repositories
//
// spec/behaviors/05-persistence-stratum.md, BEH-EA-035/036.
//
// Each repository is a `Context.Service` built with `SqlModel.makeRepository`
// over the ambient `SqlClient` (BEH-EA-035) — none opens its own
// transaction; the calling domain service (in `@awthaq/core`'s
// eventual SQL-backed `Layer`) holds that boundary, the same way
// `Verification.consume` and its caller's own state change are meant to
// commit together (BEH-EA-058). Every paginated query takes an opaque
// `(createdAt, id)` cursor, never an offset (BEH-EA-036).

import { Encryption } from "@awthaq/ports";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlModel from "effect/unstable/sql/SqlModel";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Account,
  AccountId,
  Session,
  SessionId,
  User,
  UserId,
  VerificationReservation,
  VerificationToken,
  VerificationTokenId,
} from "./Models.ts";

/** BEH-EA-036: the one cursor shape every paginated repository query accepts. */
export interface Cursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

/** A page of rows plus the cursor to pass back in to fetch the next one, if any. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: Option.Option<Cursor>;
}

type RepositoryError = Schema.SchemaError | SqlError;

// ---- Users ------------------------------------------------------------

export interface UsersRepositoryShape {
  readonly insert: (input: typeof User.insert.Type) => Effect.Effect<User, RepositoryError>;
  readonly update: (input: typeof User.update.Type) => Effect.Effect<User, RepositoryError>;
  readonly findById: (
    id: UserId,
  ) => Effect.Effect<User, Cause.NoSuchElementError | RepositoryError>;
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>, RepositoryError>;
  /**
   * BEH-EA-042: `emailVerified` is excluded from `update`/`jsonUpdate` (see
   * `Models.ts`), so flipping it needs its own repository operation rather
   * than the generic `update`.
   */
  readonly verifyEmail: (
    id: UserId,
  ) => Effect.Effect<User, Cause.NoSuchElementError | RepositoryError>;
  readonly delete: (id: UserId) => Effect.Effect<void, RepositoryError>;
  /**
   * BAM-005/BEH-EA-036: keyset page over every user, oldest first —
   * `cursor` is opaque and derived from `(createdAt, id)`; at most `limit`
   * rows are returned (`nextCursor` present iff a full page came back and
   * more may follow).
   */
  readonly listPage: (
    cursor?: Cursor,
    limit?: number,
  ) => Effect.Effect<Page<User>, RepositoryError>;
}

export class UsersRepository extends Context.Service<UsersRepository, UsersRepositoryShape>()(
  "awthaq/sql/UsersRepository",
) {}

export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    UsersRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* SqlModel.makeRepository(User, {
        tableName: "users",
        spanPrefix: "Users",
        idColumn: "id",
      });

      const findByEmail = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: User,
        execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`,
      });

      const usersPage = SqlSchema.findAll({
        Request: Schema.Struct({
          cursorCreatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
          cursorId: Schema.NullOr(Schema.String),
          limit: Schema.Int,
        }),
        Result: User,
        execute: (request) =>
          request.cursorCreatedAt === null || request.cursorId === null
            ? sql`SELECT * FROM users ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit + 1}`
            : sql`SELECT * FROM users
                  WHERE "createdAt" > ${request.cursorCreatedAt}
                     OR ("createdAt" = ${request.cursorCreatedAt} AND id > ${request.cursorId})
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit + 1}`,
      });

      // Reads `limit + 1` rows: the extra one only proves a next page exists, so an
      // exactly-full final page never invents a cursor.
      const listPage: UsersRepositoryShape["listPage"] = (cursor, limit) => {
        const effectiveLimit = limit ?? DEFAULT_PAGE_SIZE;
        return usersPage({
          cursorCreatedAt: cursor?.createdAt ?? null,
          cursorId: cursor?.id ?? null,
          limit: effectiveLimit,
        }).pipe(
          Effect.map((rows): Page<User> => {
            const items = rows.slice(0, effectiveLimit);
            const last = items.at(-1);
            return {
              items,
              nextCursor:
                rows.length > effectiveLimit && last !== undefined
                  ? Option.some({ createdAt: last.createdAt, id: last.id })
                  : Option.none(),
            };
          }),
        );
      };

      const verifyEmail: UsersRepositoryShape["verifyEmail"] = Effect.fnUntraced(function* (id) {
        const encodedNow = yield* Schema.encodeEffect(Schema.DateTimeUtcFromString)(
          yield* DateTime.now,
        );
        // TS-002: `= 1` is verbatim SQL text, not a bind parameter Postgres's
        // driver could type as boolean — Postgres has no implicit
        // integer→boolean assignment cast (`emailVerified BOOLEAN` per
        // `CoreMigrations.ts`), while SQLite's own `emailVerified INTEGER`
        // needs exactly this literal. Same `sql.onDialectOrElse` branching
        // `CoreMigrations.ts` already uses for DDL, here for a DML literal.
        yield* sql.onDialectOrElse({
          pg: () =>
            sql`UPDATE users SET "emailVerified" = TRUE, "updatedAt" = ${encodedNow} WHERE id = ${id}`,
          sqlite: () =>
            sql`UPDATE users SET "emailVerified" = 1, "updatedAt" = ${encodedNow} WHERE id = ${id}`,
          orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for verifyEmail")),
        });
        return yield* repo.findById(id);
      });

      return {
        insert: repo.insert,
        update: repo.update,
        findById: repo.findById,
        delete: repo.delete,
        findByEmail,
        verifyEmail,
        listPage,
      };
    }),
  );

// ---- Accounts -----------------------------------------------------------

export interface AccountsRepositoryShape {
  readonly insert: (input: typeof Account.insert.Type) => Effect.Effect<Account, RepositoryError>;
  /**
   * BEH-EA-116 (`@awthaq/password`'s rehash-on-login): the generic write
   * path — `passwordHash`/`accessToken`/`refreshToken` are all
   * `Model.Sensitive` (included in `update`, not excluded), so a caller
   * updating one must pass the other two through unchanged.
   *
   * PPS-001: `aad` (the row's own `providerId`/`userId`, immutable and
   * excluded from `Account.update.Type` itself) is required from the
   * caller rather than re-derived via an internal `findById` — the only
   * caller (`@awthaq/core`'s `updateCredentialHash`) already has both from
   * its own prior read, so re-reading them here was a pure duplicate
   * round trip on the login hot path, not a genuine second source of
   * truth.
   */
  readonly update: (
    input: typeof Account.update.Type,
    aad: { readonly providerId: string; readonly userId: string },
  ) => Effect.Effect<Account, RepositoryError>;
  /**
   * Identity read (SMS-002): a token column that can no longer be decrypted
   * (retired key, tampered ciphertext) is degraded to `null` and logged
   * rather than killing the fiber, so one bad row never takes down sign-in
   * or a device list. Use `findTokensById` when the tokens themselves are
   * the point of the read.
   */
  readonly findById: (
    id: AccountId,
  ) => Effect.Effect<Account, Cause.NoSuchElementError | RepositoryError>;
  /**
   * SMS-002: the strict token read — an undecryptable column surfaces as the
   * typed `AccountTokenUndecryptable` so the caller can treat it as "re-consent
   * required" instead of a defect or a silent `null`.
   */
  readonly findTokensById: (
    id: AccountId,
  ) => Effect.Effect<
    Account,
    Cause.NoSuchElementError | RepositoryError | AccountTokenUndecryptable
  >;
  /**
   * SMS-002: writes only the password hash — never reads (so never decrypts)
   * the token columns, unlike the generic `update`, which forces the caller to
   * read and pass them through.
   */
  readonly updatePasswordHash: (
    id: AccountId,
    passwordHash: string,
  ) => Effect.Effect<Account, Cause.NoSuchElementError | RepositoryError>;
  /**
   * SMS-002: overwrites the whole provider-token group without decrypting the
   * previous value, so a row whose old ciphertext is unreadable heals on the
   * next OAuth sign-in.
   */
  readonly updateProviderTokens: (
    id: AccountId,
    aad: { readonly providerId: string; readonly userId: string },
    tokens: AccountTokenColumns,
  ) => Effect.Effect<Account, Cause.NoSuchElementError | RepositoryError>;
  readonly findByProviderSubject: (
    providerId: string,
    subject: string,
    issuer: string,
  ) => Effect.Effect<Option.Option<Account>, RepositoryError>;
  readonly listByUser: (userId: UserId) => Effect.Effect<ReadonlyArray<Account>, RepositoryError>;
  readonly delete: (id: AccountId) => Effect.Effect<void, RepositoryError>;
  /**
   * Shipping-gap map (.scratch/shipping-gaps), ticket 09/10: whole-user
   * deletion's own cascade — deliberately bypasses `unlink`'s last-account
   * refusal (BEH-EA-045), which exists to stop a user locking themselves
   * out of an *otherwise-still-existing* account, not to block deleting
   * the account entirely. Mirrors `SessionsRepositoryShape`'s own
   * `deleteAllForUserExcept` — a raw bulk statement, not `delete` called
   * once per row.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, SqlError>;
}

/** The provider-token columns written together by `updateProviderTokens` (plaintext; encrypted by the repository). */
export interface AccountTokenColumns {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly accessTokenExpiresAt: DateTime.Utc | null;
  readonly refreshTokenExpiresAt: DateTime.Utc | null;
  readonly scope: string | null;
  readonly tokenType: string | null;
}

type TokenField = "accessToken" | "refreshToken" | "idToken";

/**
 * SMS-002: a stored token ciphertext that `Encryption` could not open — the
 * key was retired from the keyset (`UnknownKeyId`) or the envelope failed
 * authentication (`DecryptionFailed`). Carries no ciphertext or plaintext.
 */
export class AccountTokenUndecryptable extends Data.TaggedError("AccountTokenUndecryptable")<{
  readonly accountId: string;
  readonly field: TokenField;
  readonly reason: "DecryptionFailed" | "UnknownKeyId";
}> {}

/**
 * SMS-002 / KRS-002: `reencryptOnRead` (default on) makes every read that
 * finds a token written under a retired key or the legacy v1 envelope
 * re-encrypt it under the current key and compare-and-swap it back, so a
 * retired key can eventually be dropped from the keyset. Best-effort: a
 * failed write is logged and the read still succeeds.
 */
export interface AccountsRepositoryConfig {
  readonly reencryptOnRead: boolean;
}

export const AccountsRepositoryConfig: Context.Reference<AccountsRepositoryConfig> =
  Context.Reference<AccountsRepositoryConfig>("awthaq/sql/AccountsRepositoryConfig", {
    defaultValue: () => ({ reencryptOnRead: true }),
  });

export class AccountsRepository extends Context.Service<
  AccountsRepository,
  AccountsRepositoryShape
>()("awthaq/sql/AccountsRepository") {}

/**
 * Shipping-gap map (.scratch/shipping-gaps), ticket 18: `accessToken`/
 * `refreshToken` are encrypted at rest via `@awthaq/ports`'
 * `Encryption`, transparently to every caller of this repository —
 * `AccountsRepositoryShape` itself is unchanged, still taking/returning
 * the same plain nullable strings `Model.Sensitive` already types them
 * as; only the bytes actually written to `accounts.accessToken`/
 * `accounts.refreshToken` differ. AAD binds each ciphertext to the
 * specific row *and* column it belongs to (`providerId:userId:field`),
 * per ticket 18's own requirement that ciphertext can't be silently
 * swapped between rows (or between the access- and refresh-token columns
 * of the very same row) undetected.
 */
const tokenAad = (providerId: string, userId: string, field: TokenField): string =>
  `${providerId}:${userId}:${field}`;

export const AccountsRepositoryLive: Layer.Layer<
  AccountsRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  AccountsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encryption = yield* Encryption.Encryption;
    const repo = yield* SqlModel.makeRepository(Account, {
      tableName: "accounts",
      spanPrefix: "Accounts",
      idColumn: "id",
    });

    const encryptToken = (
      providerId: string,
      userId: string,
      field: TokenField,
      value: string | null,
    ): Effect.Effect<string | null> =>
      value === null
        ? Effect.succeed(null)
        : encryption.encrypt(Redacted.make(value), tokenAad(providerId, userId, field));

    interface ColumnRead {
      readonly plaintext: string | null;
      readonly stored: string | null;
      /** The ciphertext re-encrypted under the current key when the stored one was stale (KRS-002). */
      readonly refreshed: Option.Option<string>;
    }

    const readColumn = (row: Account, field: TokenField) => {
      const stored = row[field];
      if (stored === null) {
        return Effect.succeed<ColumnRead>({ plaintext: null, stored, refreshed: Option.none() });
      }
      const aad = tokenAad(row.providerId, row.userId, field);
      return encryption.decrypt(stored, aad).pipe(
        Effect.flatMap((decrypted): Effect.Effect<ColumnRead> => {
          const plaintext = Redacted.value(decrypted.plaintext);
          return Option.isNone(decrypted.staleKid)
            ? Effect.succeed({ plaintext, stored, refreshed: Option.none() })
            : encryption
                .encrypt(decrypted.plaintext, aad)
                .pipe(
                  Effect.map((fresh) => ({ plaintext, stored, refreshed: Option.some(fresh) })),
                );
        }),
        Effect.catchTags({
          DecryptionFailed: () =>
            Effect.fail(
              new AccountTokenUndecryptable({
                accountId: row.id,
                field,
                reason: "DecryptionFailed",
              }),
            ),
          UnknownKeyId: () =>
            Effect.fail(
              new AccountTokenUndecryptable({ accountId: row.id, field, reason: "UnknownKeyId" }),
            ),
        }),
      );
    };

    // `degrade`: null just the unreadable column and log (never ciphertext).
    const readColumnDegraded = (row: Account, field: TokenField) =>
      readColumn(row, field).pipe(
        Effect.catchTag("AccountTokenUndecryptable", (error) =>
          Effect.logWarning("awthaq: account token is undecryptable; reading it as null").pipe(
            Effect.annotateLogs({
              accountId: error.accountId,
              field: error.field,
              reason: error.reason,
            }),
            Effect.as<ColumnRead>({
              plaintext: null,
              stored: row[field],
              refreshed: Option.none(),
            }),
          ),
        ),
      );

    const persistRefreshed = (row: Account, field: TokenField, old: string, fresh: string) =>
      (field === "accessToken"
        ? sql`UPDATE accounts SET "accessToken" = ${fresh} WHERE id = ${row.id} AND "accessToken" = ${old}`
        : field === "refreshToken"
          ? sql`UPDATE accounts SET "refreshToken" = ${fresh} WHERE id = ${row.id} AND "refreshToken" = ${old}`
          : sql`UPDATE accounts SET "idToken" = ${fresh} WHERE id = ${row.id} AND "idToken" = ${old}`
      ).pipe(
        Effect.asVoid,
        Effect.catchTag("SqlError", (error) =>
          Effect.logWarning("awthaq: lazy token re-encryption write failed").pipe(
            Effect.annotateLogs({ accountId: row.id, field, reason: error.message }),
          ),
        ),
      );

    const decryptRowWith = <E>(
      row: Account,
      read: (row: Account, field: TokenField) => Effect.Effect<ColumnRead, E>,
    ) =>
      Effect.gen(function* () {
        const config = yield* AccountsRepositoryConfig;
        const access = yield* read(row, "accessToken");
        const refresh = yield* read(row, "refreshToken");
        const idTok = yield* read(row, "idToken");
        if (config.reencryptOnRead) {
          if (Option.isSome(access.refreshed) && access.stored !== null) {
            yield* persistRefreshed(row, "accessToken", access.stored, access.refreshed.value);
          }
          if (Option.isSome(refresh.refreshed) && refresh.stored !== null) {
            yield* persistRefreshed(row, "refreshToken", refresh.stored, refresh.refreshed.value);
          }
          if (Option.isSome(idTok.refreshed) && idTok.stored !== null) {
            yield* persistRefreshed(row, "idToken", idTok.stored, idTok.refreshed.value);
          }
        }
        return Account.make({
          ...row,
          accessToken: access.plaintext,
          refreshToken: refresh.plaintext,
          idToken: idTok.plaintext,
        });
      });

    // Identity reads degrade; `findTokensById` is the one strict path.
    const decryptRow = (row: Account) => decryptRowWith(row, readColumnDegraded);
    const decryptRowStrict = (row: Account) => decryptRowWith(row, readColumn);

    const insert: AccountsRepositoryShape["insert"] = (input) =>
      Effect.gen(function* () {
        const accessToken = yield* encryptToken(
          input.providerId,
          input.userId,
          "accessToken",
          input.accessToken,
        );
        const refreshToken = yield* encryptToken(
          input.providerId,
          input.userId,
          "refreshToken",
          input.refreshToken,
        );
        const idToken = yield* encryptToken(
          input.providerId,
          input.userId,
          "idToken",
          input.idToken,
        );
        const row = yield* repo.insert({ ...input, accessToken, refreshToken, idToken });
        return yield* decryptRow(row);
      });

    const update: AccountsRepositoryShape["update"] = (input, aad) =>
      Effect.gen(function* () {
        const accessToken = yield* encryptToken(
          aad.providerId,
          aad.userId,
          "accessToken",
          input.accessToken,
        );
        const refreshToken = yield* encryptToken(
          aad.providerId,
          aad.userId,
          "refreshToken",
          input.refreshToken,
        );
        const idToken = yield* encryptToken(aad.providerId, aad.userId, "idToken", input.idToken);
        const row = yield* repo.update({ ...input, accessToken, refreshToken, idToken });
        return yield* decryptRow(row);
      });

    const findById: AccountsRepositoryShape["findById"] = (id) =>
      repo.findById(id).pipe(Effect.flatMap(decryptRow));

    const findTokensById: AccountsRepositoryShape["findTokensById"] = (id) =>
      repo.findById(id).pipe(Effect.flatMap(decryptRowStrict));

    // SMS-002: targeted writes — neither reads (or decrypts) the old token
    // columns, so an undecryptable row can still be repaired by a fresh write.
    const updatePasswordHashQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: AccountId,
        passwordHash: Schema.String,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: Account,
      execute: (request) => sql`
        UPDATE accounts
        SET "passwordHash" = ${request.passwordHash}, "updatedAt" = ${request.updatedAt}
        WHERE id = ${request.id}
        RETURNING *
      `,
    });

    const updatePasswordHash: AccountsRepositoryShape["updatePasswordHash"] = (id, passwordHash) =>
      DateTime.now.pipe(
        Effect.flatMap((updatedAt) => updatePasswordHashQuery({ id, passwordHash, updatedAt })),
        Effect.flatMap(decryptRow),
      );

    const updateProviderTokensQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: AccountId,
        accessToken: Schema.NullOr(Schema.String),
        refreshToken: Schema.NullOr(Schema.String),
        accessTokenExpiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
        refreshTokenExpiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
        scope: Schema.NullOr(Schema.String),
        tokenType: Schema.NullOr(Schema.String),
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: Account,
      execute: (request) => sql`
        UPDATE accounts
        SET "accessToken" = ${request.accessToken},
            "refreshToken" = ${request.refreshToken},
            "accessTokenExpiresAt" = ${request.accessTokenExpiresAt},
            "refreshTokenExpiresAt" = ${request.refreshTokenExpiresAt},
            scope = ${request.scope},
            "tokenType" = ${request.tokenType},
            "updatedAt" = ${request.updatedAt}
        WHERE id = ${request.id}
        RETURNING *
      `,
    });

    const updateProviderTokens: AccountsRepositoryShape["updateProviderTokens"] = (
      id,
      aad,
      tokens,
    ) =>
      Effect.gen(function* () {
        const accessToken = yield* encryptToken(
          aad.providerId,
          aad.userId,
          "accessToken",
          tokens.accessToken,
        );
        const refreshToken = yield* encryptToken(
          aad.providerId,
          aad.userId,
          "refreshToken",
          tokens.refreshToken,
        );
        const updatedAt = yield* DateTime.now;
        const row = yield* updateProviderTokensQuery({
          ...tokens,
          id,
          accessToken,
          refreshToken,
          updatedAt,
        });
        return yield* decryptRow(row);
      });

    const findByProviderSubject = SqlSchema.findOneOption({
      Request: Schema.Struct({
        providerId: Schema.String,
        subject: Schema.String,
        issuer: Schema.String,
      }),
      Result: Account,
      execute: (request) =>
        sql`SELECT * FROM accounts WHERE "providerId" = ${request.providerId} AND subject = ${request.subject} AND issuer = ${request.issuer}`,
    });

    const listByUser = SqlSchema.findAll({
      Request: UserId,
      Result: Account,
      execute: (userId) => sql`SELECT * FROM accounts WHERE "userId" = ${userId}`,
    });

    const deleteAllByUser: AccountsRepositoryShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM accounts WHERE "userId" = ${userId}`.pipe(Effect.asVoid);

    return {
      insert,
      update,
      findById,
      findTokensById,
      updatePasswordHash,
      updateProviderTokens,
      delete: repo.delete,
      findByProviderSubject: (providerId, subject, issuer) =>
        findByProviderSubject({ providerId, subject, issuer }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => decryptRow(row).pipe(Effect.map(Option.some)),
            }),
          ),
        ),
      listByUser: (userId) =>
        listByUser(userId).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decryptRow))),
      deleteAllByUser,
    };
  }),
);

// ---- Sessions -----------------------------------------------------------

const SessionCursorRequest = Schema.Struct({
  userId: UserId,
  cursorCreatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  cursorId: Schema.NullOr(Schema.String),
  limit: Schema.Int,
});

export interface SessionsRepositoryShape {
  readonly insert: (input: typeof Session.insert.Type) => Effect.Effect<Session, RepositoryError>;
  readonly update: (input: typeof Session.update.Type) => Effect.Effect<Session, RepositoryError>;
  readonly findById: (
    id: SessionId,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /** BEH-EA-036: `cursor` is opaque and derived from `(createdAt, id)`. */
  readonly listByUser: (
    userId: UserId,
    cursor?: Cursor,
    limit?: number,
  ) => Effect.Effect<Page<Session>, RepositoryError>;
  /**
   * Upstream-hardening map, ticket 01: the throttled touch/rotation
   * write's own compare-and-swap — `expectedSecretHash` must still match
   * the row's *current* `secretHash` for the update to apply. Two
   * concurrent requests racing the same throttled window would otherwise
   * both blindly overwrite `secretHash` via a plain `update`, leaving
   * whichever response lost the race holding a token that no longer
   * verifies. `None` means another request already won that race — not a
   * failure — so the caller reports no rotation of its own rather than
   * clobbering the winner's write.
   */
  readonly touch: (input: {
    readonly id: SessionId;
    readonly expectedSecretHash: string;
    readonly secretHash: string;
    readonly lastActiveAt: DateTime.Utc;
    readonly idleExpiresAt: DateTime.Utc;
  }) => Effect.Effect<Option.Option<Session>, RepositoryError>;
  readonly delete: (id: SessionId) => Effect.Effect<void, RepositoryError>;
  /** BEH-EA-054: bulk-revokes every session for `userId` except `keep`. */
  readonly deleteAllForUserExcept: (
    userId: UserId,
    keep: SessionId,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Upstream-hardening map, ticket 02: bulk-revokes every session for
   * `userId`, no exceptions — `revokeAll`'s own primitive, distinct from
   * `deleteAllForUserExcept`'s "all but one" shape.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, SqlError>;
  /**
   * RRS-003: tombstones the superseded row in a rotation — sets
   * `supersededBy`/`supersededAt`, never deletes it. Returns the
   * now-tombstoned row (its own `familyId` is what the new row inherits).
   */
  readonly tombstone: (input: {
    readonly id: SessionId;
    readonly supersededBy: SessionId;
    readonly supersededAt: DateTime.Utc;
  }) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /** RRS-003: marks a tombstoned row's own `reusedAt`, the first time it is presented again. */
  readonly markReused: (
    id: SessionId,
    reusedAt: DateTime.Utc,
  ) => Effect.Effect<void, RepositoryError>;
  /** RRS-003: bulk hard-deletes every still-live (non-tombstoned) row sharing `familyId` — a confirmed-compromised family has no further lineage worth preserving. */
  readonly revokeFamily: (familyId: SessionId) => Effect.Effect<void, SqlError>;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001/BPAS-001): the one column `Sessions.reauthenticate` writes —
   * a targeted `UPDATE`, mirroring `tombstone`'s own shape, not the
   * generic `update` (which would also require supplying every other
   * `update`-variant field this call has no business touching).
   */
  readonly reauthenticate: (
    id: SessionId,
    authenticatedAt: DateTime.Utc,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
}

export class SessionsRepository extends Context.Service<
  SessionsRepository,
  SessionsRepositoryShape
>()("awthaq/sql/SessionsRepository") {}

const DEFAULT_PAGE_SIZE = 50;

export const SessionsRepositoryLive: Layer.Layer<SessionsRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    SessionsRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* SqlModel.makeRepository(Session, {
        tableName: "sessions",
        spanPrefix: "Sessions",
        idColumn: "id",
      });

      // RRS-003: `"supersededAt" IS NULL` — load-bearing, not cosmetic. A
      // tombstoned row must never appear in a user's device list, and this
      // is also what makes `Sessions.verifyLive`/`Jwt.introspectLive`
      // correctly reject a reused/family-revoked session's JWT for free —
      // both call this same `list`.
      const page = SqlSchema.findAll({
        Request: SessionCursorRequest,
        Result: Session,
        execute: (request) =>
          request.cursorCreatedAt === null || request.cursorId === null
            ? sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
            : sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  AND ("createdAt" > ${request.cursorCreatedAt}
                       OR ("createdAt" = ${request.cursorCreatedAt} AND id > ${request.cursorId}))
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`,
      });

      const listByUser: SessionsRepositoryShape["listByUser"] = (userId, cursor, limit) =>
        page({
          userId,
          cursorCreatedAt: cursor?.createdAt ?? null,
          cursorId: cursor?.id ?? null,
          limit: limit ?? DEFAULT_PAGE_SIZE,
        }).pipe(
          Effect.map((items): Page<Session> => {
            const effectiveLimit = limit ?? DEFAULT_PAGE_SIZE;
            const last = items.at(-1);
            const nextCursor =
              items.length === effectiveLimit && last !== undefined
                ? Option.some({ createdAt: last.createdAt, id: last.id })
                : Option.none();
            return { items, nextCursor };
          }),
        );

      const touch = SqlSchema.findOneOption({
        Request: Schema.Struct({
          id: SessionId,
          expectedSecretHash: Schema.String,
          secretHash: Schema.String,
          lastActiveAt: Schema.DateTimeUtcFromString,
          idleExpiresAt: Schema.DateTimeUtcFromString,
        }),
        Result: Session,
        // Quoted column names: this table's Postgres DDL (`CoreMigrations.ts`)
        // declares `"secretHash"`/`"lastActiveAt"`/`"idleExpiresAt"` with
        // preserved mixed case, which only an equally-quoted reference
        // matches (Postgres folds an unquoted identifier to lowercase).
        // SQLite's own identifier resolution is case-insensitive regardless
        // of quoting, so the same quoted form is safe on both dialects.
        execute: (request) => sql`
          UPDATE sessions
          SET "secretHash" = ${request.secretHash},
              "lastActiveAt" = ${request.lastActiveAt},
              "idleExpiresAt" = ${request.idleExpiresAt}
          WHERE "id" = ${request.id}
            AND "secretHash" = ${request.expectedSecretHash}
          RETURNING *
        `,
      });

      const deleteAllForUserExcept: SessionsRepositoryShape["deleteAllForUserExcept"] = (
        userId,
        keep,
      ) =>
        sql`DELETE FROM sessions WHERE "userId" = ${userId} AND id != ${keep}`.pipe(Effect.asVoid);

      // Quoted `"userId"`: this table's Postgres DDL (`CoreMigrations.ts`)
      // declares the column with preserved mixed case, which only an
      // equally-quoted reference matches there (Postgres folds an
      // unquoted identifier to lowercase); SQLite's own identifier
      // resolution is case-insensitive regardless of quoting, so the same
      // quoted form is correct on both dialects.
      const deleteAllByUser: SessionsRepositoryShape["deleteAllByUser"] = (userId) =>
        sql`DELETE FROM sessions WHERE "userId" = ${userId}`.pipe(Effect.asVoid);

      const tombstoneQuery = SqlSchema.findOne({
        Request: Schema.Struct({
          id: SessionId,
          supersededBy: SessionId,
          supersededAt: Schema.DateTimeUtcFromString,
        }),
        Result: Session,
        execute: (request) => sql`
          UPDATE sessions
          SET "supersededBy" = ${request.supersededBy}, "supersededAt" = ${request.supersededAt}
          WHERE "id" = ${request.id}
          RETURNING *
        `,
      });

      const tombstone: SessionsRepositoryShape["tombstone"] = (input) => tombstoneQuery(input);

      // `reusedAt` must be pre-encoded — unlike `tombstoneQuery`/`touch`
      // above, this is a plain template query with no `SqlSchema` `Request`
      // to do that encoding for it; interpolating a raw `DateTime.Utc`
      // object here binds its internal fields instead of a string.
      const markReused: SessionsRepositoryShape["markReused"] = (id, reusedAt) =>
        sql`UPDATE sessions SET "reusedAt" = ${Schema.encodeSync(Schema.DateTimeUtcFromString)(reusedAt)} WHERE "id" = ${id}`.pipe(
          Effect.asVoid,
        );

      const revokeFamily: SessionsRepositoryShape["revokeFamily"] = (familyId) =>
        sql`DELETE FROM sessions WHERE "familyId" = ${familyId} AND "supersededAt" IS NULL`.pipe(
          Effect.asVoid,
        );

      const reauthenticateQuery = SqlSchema.findOne({
        Request: Schema.Struct({
          id: SessionId,
          authenticatedAt: Schema.DateTimeUtcFromString,
        }),
        Result: Session,
        execute: (request) => sql`
          UPDATE sessions
          SET "authenticatedAt" = ${request.authenticatedAt}
          WHERE "id" = ${request.id}
          RETURNING *
        `,
      });

      const reauthenticate: SessionsRepositoryShape["reauthenticate"] = (id, authenticatedAt) =>
        reauthenticateQuery({ id, authenticatedAt });

      return {
        insert: repo.insert,
        update: repo.update,
        findById: repo.findById,
        delete: repo.delete,
        listByUser,
        touch,
        deleteAllForUserExcept,
        deleteAllByUser,
        tombstone,
        markReused,
        revokeFamily,
        reauthenticate,
      };
    }),
  );

// ---- Verification ---------------------------------------------------------

export interface VerificationRepositoryShape {
  readonly insert: (
    input: typeof VerificationToken.insert.Type,
  ) => Effect.Effect<VerificationToken, RepositoryError>;
  readonly update: (
    input: typeof VerificationToken.update.Type,
  ) => Effect.Effect<VerificationToken, RepositoryError>;
  readonly findById: (
    id: VerificationTokenId,
  ) => Effect.Effect<VerificationToken, Cause.NoSuchElementError | RepositoryError>;
  readonly findByIdentifier: (
    identifier: string,
  ) => Effect.Effect<Option.Option<VerificationToken>, RepositoryError>;
  readonly delete: (id: VerificationTokenId) => Effect.Effect<void, RepositoryError>;
  /**
   * ADR-EA-016: one atomic `INSERT ... ON CONFLICT(identifier) WHERE
   * consumedAt IS NULL DO UPDATE ... RETURNING`, targeting a partial unique
   * index on `(identifier) WHERE consumedAt IS NULL` — the DB engine itself
   * decides "fresh insert" vs. "replace the current live row" in one
   * statement, so two concurrent `issue`s for the same `identifier` can
   * never both leave a live row behind the way a separate delete-then-insert
   * could. Every already-consumed historical row is untouched either way —
   * the partial index (and this statement's own conflict target) only ever
   * sees the single *unconsumed* row for `identifier`, if one exists.
   */
  readonly upsertLive: (input: {
    readonly id: VerificationTokenId;
    readonly identifier: string;
    readonly userId: UserId | null;
    readonly valueHash: string;
    readonly expiresAt: DateTime.Utc;
    readonly createdAt: DateTime.Utc;
    readonly payload: unknown;
  }) => Effect.Effect<VerificationToken, Cause.NoSuchElementError | RepositoryError>;
  /**
   * ADR-EA-016/BEH-EA-058/062: the one atomic statement `consume` is built
   * on — `identifier`/`valueHash`/`expiresAt > now`/`consumedAt IS NULL` are
   * all checked and written in a single `UPDATE ... RETURNING`, so unknown,
   * expired, wrong-secret, and already-consumed all collapse into the same
   * "no row back" result without a separate read racing the write.
   */
  readonly tryConsume: (input: {
    readonly identifier: string;
    readonly valueHash: string;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<Option.Option<VerificationToken>, RepositoryError>;
  /** BCR-003: sweeps every token (live or already-consumed) naming this user — the cascade `Account.ts`'s `deleteUser` needs. */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, SqlError>;
}

export class VerificationRepository extends Context.Service<
  VerificationRepository,
  VerificationRepositoryShape
>()("awthaq/sql/VerificationRepository") {}

export const VerificationRepositoryLive: Layer.Layer<
  VerificationRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  VerificationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* SqlModel.makeRepository(VerificationToken, {
      tableName: "verification_tokens",
      spanPrefix: "VerificationTokens",
      idColumn: "id",
    });

    const findByIdentifier = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: VerificationToken,
      execute: (identifier) =>
        sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY "createdAt" DESC LIMIT 1`,
    });

    const upsertLive = SqlSchema.findOne({
      Request: Schema.Struct({
        id: VerificationTokenId,
        identifier: Schema.String,
        userId: Schema.NullOr(UserId),
        valueHash: Schema.String,
        expiresAt: Schema.DateTimeUtcFromString,
        createdAt: Schema.DateTimeUtcFromString,
        payload: Schema.fromJsonString(Schema.Unknown),
      }),
      Result: VerificationToken,
      execute: (request) => sql`
        INSERT INTO verification_tokens (id, identifier, "userId", "valueHash", "expiresAt", "consumedAt", "createdAt", payload)
        VALUES (${request.id}, ${request.identifier}, ${request.userId}, ${request.valueHash}, ${request.expiresAt}, NULL, ${request.createdAt}, ${request.payload})
        ON CONFLICT(identifier) WHERE "consumedAt" IS NULL
        DO UPDATE SET
          id = excluded.id,
          "userId" = excluded."userId",
          "valueHash" = excluded."valueHash",
          "expiresAt" = excluded."expiresAt",
          "createdAt" = excluded."createdAt",
          payload = excluded.payload,
          "consumedAt" = NULL
        RETURNING *
      `,
    });

    const deleteAllByUser: VerificationRepositoryShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM verification_tokens WHERE "userId" = ${userId}`.pipe(Effect.asVoid);

    const tryConsume = SqlSchema.findOneOption({
      Request: Schema.Struct({
        identifier: Schema.String,
        valueHash: Schema.String,
        now: Schema.DateTimeUtcFromString,
      }),
      Result: VerificationToken,
      execute: (request) => sql`
        UPDATE verification_tokens
        SET "consumedAt" = ${request.now}
        WHERE identifier = ${request.identifier}
          AND "valueHash" = ${request.valueHash}
          AND "expiresAt" > ${request.now}
          AND "consumedAt" IS NULL
        RETURNING *
      `,
    });

    return {
      insert: repo.insert,
      update: repo.update,
      findById: repo.findById,
      delete: repo.delete,
      findByIdentifier,
      upsertLive,
      tryConsume,
      deleteAllByUser,
    };
  }),
);

// ---- VerificationReservations -------------------------------------------

/**
 * BEH-EA-063/ADR-EA-016: `reserve`'s one race-safe primitive — a plugin
 * calling this never sees a separate read followed by a separate write, so
 * two concurrent claims of the same `identifier` cannot both win.
 */
export interface VerificationReservationsRepositoryShape {
  /**
   * `true` only when this call's write actually took effect — a fresh
   * reservation, or one placed on an identifier whose prior reservation has
   * expired; `false` when an unexpired reservation already belongs to
   * someone else. `now` is the caller's own clock reading (the same
   * `DateTime.now` `Verification.layerSql` already reads), never the
   * database's own clock, so `TestClock` controls this the same way it
   * already controls every other time-sensitive behavior in this stratum.
   */
  readonly claim: (input: {
    readonly identifier: string;
    readonly expiresAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<boolean, RepositoryError>;
}

export class VerificationReservationsRepository extends Context.Service<
  VerificationReservationsRepository,
  VerificationReservationsRepositoryShape
>()("awthaq/sql/VerificationReservationsRepository") {}

export const VerificationReservationsRepositoryLive = Layer.effect(
  VerificationReservationsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /**
     * ADR-EA-016: one atomic statement — the `WHERE` clause on the `DO
     * UPDATE` is what makes "unexpired reservations block a new claim" a
     * property of this single write, not a separate check racing against
     * it. `RETURNING *` produces a row only when the insert happened or the
     * conditional update actually fired — SQLite's own UPSERT semantics
     * skip `RETURNING` entirely when the `DO UPDATE`'s `WHERE` is false, so
     * "no row back" and "claim failed" are the same fact, not two things
     * this code has to keep in sync by hand.
     */
    const attempt = SqlSchema.findOneOption({
      Request: Schema.Struct({
        identifier: Schema.String,
        expiresAt: Schema.DateTimeUtcFromString,
        now: Schema.DateTimeUtcFromString,
      }),
      Result: VerificationReservation,
      execute: (request) => sql`
        INSERT INTO verification_reservations (identifier, "expiresAt")
        VALUES (${request.identifier}, ${request.expiresAt})
        ON CONFLICT(identifier) DO UPDATE SET "expiresAt" = excluded."expiresAt"
        WHERE verification_reservations."expiresAt" < ${request.now}
        RETURNING *
      `,
    });

    const claim: VerificationReservationsRepositoryShape["claim"] = (input) =>
      attempt(input).pipe(Effect.map(Option.isSome));

    return { claim };
  }),
);

// ---- AuditLog ---------------------------------------------------------------

/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 01
 * (ALF-001/ESA-001/ESS-002/CSG-004/EP-002): one `auth_audit_log` row per
 * `AuthEvent`, envelope columns plus an opaque `payload` — the same
 * "opaque JSON blob, typed envelope around it" shape `verification_tokens`
 * already uses, not `SqlModel.makeRepository` (which assumes a flat
 * per-entity row; `AuthEvent` is a closed, many-variant union).
 */
export interface AuditLogRow {
  readonly id: string;
  readonly eventTag: string;
  readonly actorUserId: string | null;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: string | null;
  readonly payload: unknown;
}

export interface AuditLogRepositoryShape {
  readonly insert: (input: {
    readonly id: string;
    readonly eventTag: string;
    readonly actorUserId: string | null;
    readonly occurredAt: DateTime.Utc;
    readonly correlationId: string | null;
    readonly payload: unknown;
  }) => Effect.Effect<AuditLogRow, Cause.NoSuchElementError | RepositoryError>;
  readonly list: (input: {
    readonly eventTag: string | null;
    readonly actorUserId: string | null;
    readonly occurredAfter: DateTime.Utc | null;
    readonly occurredBefore: DateTime.Utc | null;
  }) => Effect.Effect<ReadonlyArray<AuditLogRow>, RepositoryError>;
}

export class AuditLogRepository extends Context.Service<
  AuditLogRepository,
  AuditLogRepositoryShape
>()("awthaq/sql/AuditLogRepository") {}

const AuditLogRowSchema = Schema.Struct({
  id: Schema.String,
  eventTag: Schema.String,
  actorUserId: Schema.NullOr(Schema.String),
  occurredAt: Schema.DateTimeUtcFromString,
  correlationId: Schema.NullOr(Schema.String),
  payload: Schema.fromJsonString(Schema.Unknown),
});

export const AuditLogRepositoryLive: Layer.Layer<AuditLogRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    AuditLogRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const insertQuery = SqlSchema.findOne({
        Request: Schema.Struct({
          id: Schema.String,
          eventTag: Schema.String,
          actorUserId: Schema.NullOr(Schema.String),
          occurredAt: Schema.DateTimeUtcFromString,
          correlationId: Schema.NullOr(Schema.String),
          payload: Schema.fromJsonString(Schema.Unknown),
        }),
        Result: AuditLogRowSchema,
        execute: (r) => sql`
        INSERT INTO auth_audit_log (id, "eventTag", "actorUserId", "occurredAt", "correlationId", payload)
        VALUES (${r.id}, ${r.eventTag}, ${r.actorUserId}, ${r.occurredAt}, ${r.correlationId}, ${r.payload})
        RETURNING *
      `,
      });

      const listQuery = SqlSchema.findAll({
        Request: Schema.Struct({
          eventTag: Schema.NullOr(Schema.String),
          actorUserId: Schema.NullOr(Schema.String),
          occurredAfter: Schema.NullOr(Schema.DateTimeUtcFromString),
          occurredBefore: Schema.NullOr(Schema.DateTimeUtcFromString),
        }),
        Result: AuditLogRowSchema,
        execute: (r) => {
          const conditions = [
            ...(r.eventTag === null ? [] : [sql`"eventTag" = ${r.eventTag}`]),
            ...(r.actorUserId === null ? [] : [sql`"actorUserId" = ${r.actorUserId}`]),
            ...(r.occurredAfter === null ? [] : [sql`"occurredAt" >= ${r.occurredAfter}`]),
            ...(r.occurredBefore === null ? [] : [sql`"occurredAt" <= ${r.occurredBefore}`]),
          ];
          return sql`SELECT * FROM auth_audit_log WHERE ${sql.and(conditions)} ORDER BY "occurredAt" DESC`;
        },
      });

      const insert: AuditLogRepositoryShape["insert"] = (input) => insertQuery(input);

      const list: AuditLogRepositoryShape["list"] = (input) => listQuery(input);

      return { insert, list };
    }),
  );
