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
import * as ReadRouting from "./ReadRouting.ts";
import {
  AccountId,
  SessionId,
  UserId,
  VerificationTokenId,
  makeModels,
  resolveDialect,
} from "./Models.ts";
import type {
  Account,
  AccountInsert,
  AccountUpdate,
  Session,
  SessionInsert,
  SessionUpdate,
  SqlModels,
  User,
  UserInsert,
  UserUpdate,
  VerificationToken,
  VerificationTokenInsert,
  VerificationTokenUpdate,
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

/**
 * EOTS-008: SqlModel names its own CRUD spans `<spanPrefix>.<method>`; every
 * hand-written method gets the same convention so a flame graph reads
 * `Users.findByEmail > sql.execute`. Attributes are ids only — never an
 * email, identifier, hash, token or payload (BEH-EA-199).
 */
const traced = (name: string, attributes?: Record<string, unknown>) =>
  Effect.withSpan(name, attributes === undefined ? {} : { attributes }, {
    captureStackTrace: false,
  });

// ---- Opt-in PII column encryption (CSG-006, option B) -------------------------------

/**
 * How one repository stores a personal-data column. The default repositories
 * store it as given; `Users`/`SessionsRepositoryEncryptedLive` seal it with
 * `@awthaq/ports`' `Encryption` (AES-256-GCM, AAD `<entity>:<id>:<field>`, so a
 * ciphertext cannot be moved to another row or column). Choosing the encrypted
 * layer is the opt-in — and puts `Encryption` in the layer's requirements, so
 * forgetting to provide it is a compile error, not a runtime surprise.
 */
interface PiiCodec {
  readonly conceal: (aad: string, value: string | null) => Effect.Effect<string | null>;
  readonly reveal: (
    aad: string,
    stored: string | null,
  ) => Effect.Effect<{
    readonly plaintext: string | null;
    /** A sealed value to write back: the stored one was legacy plaintext or under a retired key. */
    readonly refreshed: Option.Option<string>;
  }>;
}

const sealedPii = (encryption: Encryption.EncryptionShape): PiiCodec => {
  const seal = (aad: string, value: string) => encryption.encrypt(Redacted.make(value), aad);
  const conceal: PiiCodec["conceal"] = (aad, value) =>
    value === null ? Effect.succeed(null) : seal(aad, value);
  return {
    conceal,
    reveal: (aad, stored) => {
      if (stored === null) return Effect.succeed({ plaintext: null, refreshed: Option.none() });
      // A column that adopted encryption after it held plaintext: not an
      // envelope, so read it as the plaintext it is and seal it on this read.
      // (An envelope-shaped value that fails authentication is never read as
      // plaintext — that is tampering, or a retired key.)
      if (!Encryption.looksLikeEnvelope(stored)) {
        return seal(aad, stored).pipe(
          Effect.map((sealed) => ({ plaintext: stored, refreshed: Option.some(sealed) })),
        );
      }
      return encryption.decrypt(stored, aad).pipe(
        Effect.flatMap((decrypted) =>
          Option.isNone(decrypted.staleKid)
            ? Effect.succeed({
                plaintext: Redacted.value(decrypted.plaintext),
                refreshed: Option.none<string>(),
              })
            : encryption.encrypt(decrypted.plaintext, aad).pipe(
                Effect.map((sealed) => ({
                  plaintext: Redacted.value(decrypted.plaintext),
                  refreshed: Option.some(sealed),
                })),
              ),
        ),
        // Same policy as the account tokens (SMS-002): one unreadable column
        // reads as null and is logged (never the ciphertext), it does not
        // take the fiber down.
        Effect.catchTags({
          DecryptionFailed: () =>
            Effect.logWarning(
              "awthaq: a personal-data column is undecryptable; reading it as null",
            ).pipe(Effect.as({ plaintext: null, refreshed: Option.none<string>() })),
          UnknownKeyId: () =>
            Effect.logWarning(
              "awthaq: a personal-data column is under an unknown key; reading it as null",
            ).pipe(Effect.as({ plaintext: null, refreshed: Option.none<string>() })),
        }),
      );
    },
  };
};

// ---- Users ------------------------------------------------------------

export interface UsersRepositoryShape {
  /** TS-001: the dialect-resolved models this repository decodes with — callers build insert/update inputs from these. */
  readonly models: SqlModels;
  readonly insert: (input: UserInsert) => Effect.Effect<User, RepositoryError>;
  readonly update: (input: UserUpdate) => Effect.Effect<User, RepositoryError>;
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

const userMetadataAad = (id: string) => `user:${id}:metadata`;

const makeUsersRepository = (pii: Option.Option<PiiCodec>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = makeModels(yield* resolveDialect(sql));
    const repo = yield* SqlModel.makeRepository(models.User, {
      tableName: "users",
      spanPrefix: "Users",
      idColumn: "id",
    });

    // CSG-006: `users.metadata` is the one free-form personal-data column. With
    // the default repository these are all no-ops; the encrypted variant seals
    // it on write and reveals it on every row that comes back.
    const concealMetadata = (id: string, metadata: string | null) =>
      Option.match(pii, {
        onNone: () => Effect.succeed(metadata),
        onSome: (codec) => codec.conceal(userMetadataAad(id), metadata),
      });

    const revealUser = (row: User): Effect.Effect<User> =>
      Option.match(pii, {
        onNone: () => Effect.succeed(row),
        onSome: (codec) =>
          Effect.gen(function* () {
            const revealed = yield* codec.reveal(userMetadataAad(row.id), row.metadata);
            const config = yield* AccountsRepositoryConfig;
            if (
              config.reencryptOnRead &&
              Option.isSome(revealed.refreshed) &&
              row.metadata !== null
            ) {
              yield* sql`UPDATE users SET metadata = ${revealed.refreshed.value} WHERE id = ${row.id} AND metadata = ${row.metadata}`.pipe(
                Effect.asVoid,
                Effect.catchTag("SqlError", (error) =>
                  Effect.logWarning("awthaq: lazy metadata re-encryption write failed").pipe(
                    Effect.annotateLogs({ userId: row.id, reason: error.message }),
                  ),
                ),
              );
            }
            return models.User.make({ ...row, metadata: revealed.plaintext });
          }),
      });

    const insert: UsersRepositoryShape["insert"] = (input) =>
      concealMetadata(input.id, input.metadata).pipe(
        Effect.flatMap((metadata) => repo.insert({ ...input, metadata })),
        Effect.flatMap(revealUser),
      );

    const update: UsersRepositoryShape["update"] = (input) =>
      concealMetadata(input.id, input.metadata).pipe(
        Effect.flatMap((metadata) => repo.update({ ...input, metadata })),
        Effect.flatMap(revealUser),
      );

    const findById: UsersRepositoryShape["findById"] = (id) =>
      repo.findById(id).pipe(Effect.flatMap(revealUser));

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

    const findByEmail: UsersRepositoryShape["findByEmail"] = (email) =>
      findByEmailQuery(email).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) => revealUser(row).pipe(Effect.map(Option.some)),
          }),
        ),
        traced("Users.findByEmail"),
      );

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

    // Reads `limit + 1` rows: the extra one only proves a next page exists, so an
    // exactly-full final page never invents a cursor.
    const listPage: UsersRepositoryShape["listPage"] = (cursor, limit) => {
      const effectiveLimit = limit ?? DEFAULT_PAGE_SIZE;
      return usersPage({
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorId: cursor?.id ?? null,
        limit: effectiveLimit,
      }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows.slice(0, effectiveLimit), revealUser).pipe(
            Effect.map((items) => ({ items, more: rows.length > effectiveLimit })),
          ),
        ),
        Effect.map(({ items, more }): Page<User> => {
          const last = items.at(-1);
          return {
            items,
            nextCursor:
              more && last !== undefined
                ? Option.some({ createdAt: last.createdAt, id: last.id })
                : Option.none(),
          };
        }),
        traced("Users.listPage"),
      );
    };

    // PPS-007: one `UPDATE ... RETURNING *`, decoded through the dialect
    // model. The boolean binds through the dialect's own wire codec (`TRUE`
    // on pg, `1` on SQLite), so there is no per-dialect literal branch (TS-002).
    const verifyEmailQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: UserId,
        verified: models.wire.boolean,
        updatedAt: models.wire.dateTime,
      }),
      Result: models.User,
      execute: (r) =>
        sql`UPDATE users SET "emailVerified" = ${r.verified}, "updatedAt" = ${r.updatedAt} WHERE id = ${r.id} RETURNING *`,
    });

    const verifyEmail: UsersRepositoryShape["verifyEmail"] = (id) =>
      DateTime.now.pipe(
        Effect.flatMap((updatedAt) => verifyEmailQuery({ id, verified: true, updatedAt })),
        Effect.flatMap(revealUser),
        traced("Users.verifyEmail", { id }),
      );

    return {
      models,
      insert,
      update,
      findById,
      delete: repo.delete,
      findByEmail,
      verifyEmail,
      listPage,
    };
  });

export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
  Layer.effect(UsersRepository, makeUsersRepository(Option.none()));

/**
 * CSG-006 (option B, opt-in): `users.metadata` is encrypted at rest through
 * `Encryption` (AAD `user:<id>:metadata`). Swap this in for `UsersRepositoryLive`
 * to enable it. Existing plaintext rows stay readable and are sealed on their
 * next read (`AccountsRepositoryConfig.reencryptOnRead`) or write. `email` and
 * `name` stay plaintext: email is the lookup and uniqueness key.
 */
export const UsersRepositoryEncryptedLive: Layer.Layer<
  UsersRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  UsersRepository,
  Effect.flatMap(Encryption.Encryption, (encryption) =>
    makeUsersRepository(Option.some(sealedPii(encryption))),
  ),
);

// ---- Accounts -----------------------------------------------------------

export interface AccountsRepositoryShape {
  /** TS-001: the dialect-resolved models this repository decodes with. */
  readonly models: SqlModels;
  readonly insert: (input: AccountInsert) => Effect.Effect<Account, RepositoryError>;
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
    input: AccountUpdate,
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
   * RRS-006: the row's encryption AAD (`providerId`/`userId`, immutable) via a
   * token-free read — it neither decrypts nor lazily re-encrypts the token
   * columns, so a caller about to overwrite them (`updateProviderTokens`) never
   * reads a secret it is not going to keep.
   */
  readonly findAad: (
    id: AccountId,
  ) => Effect.Effect<
    { readonly providerId: string; readonly userId: string },
    Cause.NoSuchElementError | RepositoryError
  >;
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
  readonly idToken: string | null;
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
    const models = makeModels(yield* resolveDialect(sql));
    const repo = yield* SqlModel.makeRepository(models.Account, {
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
        return models.Account.make({
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
      repo
        .findById(id)
        .pipe(Effect.flatMap(decryptRowStrict), traced("Accounts.findTokensById", { id }));

    // SMS-002: targeted writes — neither reads (or decrypts) the old token
    // columns, so an undecryptable row can still be repaired by a fresh write.
    const updatePasswordHashQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: AccountId,
        passwordHash: Schema.String,
        updatedAt: models.wire.dateTime,
      }),
      Result: models.Account,
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
        traced("Accounts.updatePasswordHash", { id }),
      );

    const findAadQuery = SqlSchema.findOne({
      Request: AccountId,
      Result: Schema.Struct({ providerId: Schema.String, userId: Schema.String }),
      execute: (id) => sql`SELECT "providerId", "userId" FROM accounts WHERE id = ${id}`,
    });

    const findAad: AccountsRepositoryShape["findAad"] = (id) =>
      findAadQuery(id).pipe(traced("Accounts.findAad", { id }));

    const updateProviderTokensQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: AccountId,
        accessToken: Schema.NullOr(Schema.String),
        refreshToken: Schema.NullOr(Schema.String),
        idToken: Schema.NullOr(Schema.String),
        accessTokenExpiresAt: models.wire.nullableDateTime,
        refreshTokenExpiresAt: models.wire.nullableDateTime,
        scope: Schema.NullOr(Schema.String),
        tokenType: Schema.NullOr(Schema.String),
        updatedAt: models.wire.dateTime,
      }),
      Result: models.Account,
      execute: (request) => sql`
        UPDATE accounts
        SET "accessToken" = ${request.accessToken},
            "refreshToken" = ${request.refreshToken},
            "idToken" = ${request.idToken},
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
        const idToken = yield* encryptToken(aad.providerId, aad.userId, "idToken", tokens.idToken);
        const updatedAt = yield* DateTime.now;
        const row = yield* updateProviderTokensQuery({
          ...tokens,
          id,
          accessToken,
          refreshToken,
          idToken,
          updatedAt,
        });
        return yield* decryptRow(row);
      }).pipe(traced("Accounts.updateProviderTokens", { id }));

    const findByProviderSubject = SqlSchema.findOneOption({
      Request: Schema.Struct({
        providerId: Schema.String,
        subject: Schema.String,
        issuer: Schema.String,
      }),
      Result: models.Account,
      execute: (request) =>
        sql`SELECT * FROM accounts WHERE "providerId" = ${request.providerId} AND subject = ${request.subject} AND issuer = ${request.issuer}`,
    });

    const listByUser = SqlSchema.findAll({
      Request: UserId,
      Result: models.Account,
      execute: (userId) => sql`SELECT * FROM accounts WHERE "userId" = ${userId}`,
    });

    const deleteAllByUser: AccountsRepositoryShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM accounts WHERE "userId" = ${userId}`.pipe(
        Effect.asVoid,
        traced("Accounts.deleteAllByUser", { userId }),
      );

    return {
      models,
      insert,
      update,
      findById,
      findTokensById,
      updatePasswordHash,
      findAad,
      updateProviderTokens,
      delete: repo.delete,
      // `subject`/`issuer` identify a person at an IdP: only `providerId` is
      // safe as a span attribute.
      findByProviderSubject: (providerId, subject, issuer) =>
        findByProviderSubject({ providerId, subject, issuer }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => decryptRow(row).pipe(Effect.map(Option.some)),
            }),
          ),
          traced("Accounts.findByProviderSubject", { providerId }),
        ),
      listByUser: (userId) =>
        listByUser(userId).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, decryptRow)),
          traced("Accounts.listByUser", { userId }),
        ),
      deleteAllByUser,
    };
  }),
);

// ---- Sessions -----------------------------------------------------------

export interface SessionsRepositoryShape {
  /** TS-001: the dialect-resolved models this repository decodes with. */
  readonly models: SqlModels;
  readonly insert: (input: SessionInsert) => Effect.Effect<Session, RepositoryError>;
  readonly update: (input: SessionUpdate) => Effect.Effect<Session, RepositoryError>;
  readonly findById: (
    id: SessionId,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /**
   * BEH-EA-036: `cursor` is opaque and derived from `(createdAt, id)`.
   * SMS-002/BEH-EA-054: lists only *live* rows — not tombstoned and past
   * neither `absoluteExpiresAt` nor `idleExpiresAt` at `now`. ESR-010:
   * `limit` is clamped to `[1, MAX_PAGE_SIZE]`.
   *
   * RRC-001: reads the primary unless `options.consistency` is `"eventual"`,
   * which a display-only caller (a device list) passes to allow a configured
   * read replica. Never pass it for a liveness or authorization decision.
   */
  readonly listByUser: (
    userId: UserId,
    now: DateTime.Utc,
    cursor?: Cursor,
    limit?: number,
    options?: ReadRouting.ReadOptions,
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
   * SMS-003: the user's live (not tombstoned, past neither expiry at `now`),
   * non-impersonation sessions' ids and last activity — what a concurrent-
   * session cap counts and evicts from. Impersonation (`actingAs`) rows are
   * excluded: an admin's support session never counts against the target.
   */
  readonly listLiveIds: (
    userId: UserId,
    now: DateTime.Utc,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly lastActiveAt: DateTime.Utc }>,
    RepositoryError
  >;
  /**
   * GC-005: deletes session `id` only when it belongs to `userId`, in one
   * statement — ownership is enforced atomically, not by a preceding lookup.
   * `true` when a row was deleted (owned and present), `false` for an unknown
   * id and a foreign id alike, so a caller cannot tell them apart.
   */
  readonly deleteOwned: (id: SessionId, userId: UserId) => Effect.Effect<boolean, SqlError>;
  /**
   * RRS-003: tombstones the superseded row in a rotation — sets
   * `supersededBy`/`supersededAt`, never deletes it. Returns the
   * now-tombstoned row (its own `familyId` is what the new row inherits).
   * ESR-002: applies only to a still-live row (`supersededAt IS NULL`), so two
   * concurrent supersedes of one row cannot both tombstone it and fork its
   * family — the loser gets `NoSuchElementError`.
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
    /** THS-003: the already-unioned `amr` JSON to store; `undefined` leaves it untouched. */
    amr?: string,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
}

export class SessionsRepository extends Context.Service<
  SessionsRepository,
  SessionsRepositoryShape
>()("awthaq/sql/SessionsRepository") {}

const DEFAULT_PAGE_SIZE = 50;

/**
 * ESR-010: the hard upper bound on any one session page. `listByUser` clamps
 * to it, and the request schema below enforces it as defense in depth, so no
 * caller-supplied limit can yield a `SqlError` (0, negative) or an unbounded
 * page.
 */
export const MAX_PAGE_SIZE = 200;

const sessionAad = (id: string, field: "ipAddress" | "userAgent") => `session:${id}:${field}`;

const makeSessionsRepository = (pii: Option.Option<PiiCodec>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = makeModels(yield* resolveDialect(sql));
    const repo = yield* SqlModel.makeRepository(models.Session, {
      tableName: "sessions",
      spanPrefix: "Sessions",
      idColumn: "id",
    });

    // CSG-006: `ipAddress`/`userAgent` are the personal-data columns. With the
    // default repository these are no-ops; the encrypted variant seals them at
    // insert (they are immutable afterwards) and reveals them on every row
    // that comes back, from `SqlModel` or from a hand-written query alike.
    const concealPii = (
      id: string,
      columns: { readonly ipAddress: string | null; readonly userAgent: string | null },
    ) =>
      Option.match(pii, {
        onNone: () => Effect.succeed(columns),
        onSome: (codec) =>
          Effect.all({
            ipAddress: codec.conceal(sessionAad(id, "ipAddress"), columns.ipAddress),
            userAgent: codec.conceal(sessionAad(id, "userAgent"), columns.userAgent),
          }),
      });

    const writeBackSealed = (
      id: string,
      field: "ipAddress" | "userAgent",
      stored: string,
      sealed: string,
    ) =>
      (field === "ipAddress"
        ? sql`UPDATE sessions SET "ipAddress" = ${sealed} WHERE id = ${id} AND "ipAddress" = ${stored}`
        : sql`UPDATE sessions SET "userAgent" = ${sealed} WHERE id = ${id} AND "userAgent" = ${stored}`
      ).pipe(
        Effect.asVoid,
        Effect.catchTag("SqlError", (error) =>
          Effect.logWarning("awthaq: lazy session PII re-encryption write failed").pipe(
            Effect.annotateLogs({ sessionId: id, field, reason: error.message }),
          ),
        ),
      );

    const revealSession = (row: Session): Effect.Effect<Session> =>
      Option.match(pii, {
        onNone: () => Effect.succeed(row),
        onSome: (codec) =>
          Effect.gen(function* () {
            const ip = yield* codec.reveal(sessionAad(row.id, "ipAddress"), row.ipAddress);
            const ua = yield* codec.reveal(sessionAad(row.id, "userAgent"), row.userAgent);
            const config = yield* AccountsRepositoryConfig;
            if (config.reencryptOnRead) {
              if (Option.isSome(ip.refreshed) && row.ipAddress !== null) {
                yield* writeBackSealed(row.id, "ipAddress", row.ipAddress, ip.refreshed.value);
              }
              if (Option.isSome(ua.refreshed) && row.userAgent !== null) {
                yield* writeBackSealed(row.id, "userAgent", row.userAgent, ua.refreshed.value);
              }
            }
            return models.Session.make({
              ...row,
              ipAddress: ip.plaintext,
              userAgent: ua.plaintext,
            });
          }),
      });

    const insert: SessionsRepositoryShape["insert"] = (input) =>
      concealPii(input.id, input).pipe(
        Effect.flatMap((columns) => repo.insert({ ...input, ...columns })),
        Effect.flatMap(revealSession),
      );

    const update: SessionsRepositoryShape["update"] = (input) =>
      repo.update(input).pipe(Effect.flatMap(revealSession));

    const findById: SessionsRepositoryShape["findById"] = (id) =>
      repo.findById(id).pipe(Effect.flatMap(revealSession));

    // RRS-003: `"supersededAt" IS NULL` — load-bearing, not cosmetic. A
    // tombstoned row must never appear in a user's device list, and this
    // is also what makes `Sessions.verifyLive`/`Jwt.introspectLive`
    // correctly reject a reused/family-revoked session's JWT for free —
    // both call this same `list`.
    //
    // RRC-001: the one replica-eligible session read. Built once per client
    // (primary, and the replica when `ReadRouting.replica` is provided); the
    // default `consistency` is `"authoritative"`, i.e. the primary.
    const router = yield* ReadRouting.makeRouter;
    const pageOn = router.route((client) =>
      SqlSchema.findAll({
        Request: Schema.Struct({
          userId: UserId,
          /** SMS-002: the caller's clock (so `TestClock` controls it) — rows past either expiry are not listed. */
          now: models.wire.dateTime,
          cursorCreatedAt: models.wire.nullableDateTime,
          cursorId: Schema.NullOr(Schema.String),
          limit: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
          ),
        }),
        Result: models.Session,
        // SMS-002: the two expiry predicates make the list exactly the rows
        // `verify` would still accept (modulo the secret). PPS-002: the cursor
        // is a row-value comparison over `(createdAt, id)` so the partial
        // composite index `sessions_user_created_live` (migration 19) serves
        // both the filter and the order with no sort node.
        execute: (request) =>
          request.cursorCreatedAt === null || request.cursorId === null
            ? client`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  AND "absoluteExpiresAt" > ${request.now}
                  AND "idleExpiresAt" > ${request.now}
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
            : client`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  AND "absoluteExpiresAt" > ${request.now}
                  AND "idleExpiresAt" > ${request.now}
                  AND ("createdAt", id) > (${request.cursorCreatedAt}, ${request.cursorId})
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`,
      }),
    );

    const listByUser: SessionsRepositoryShape["listByUser"] = (
      userId,
      now,
      cursor,
      limit,
      options,
    ) => {
      const effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      return pageOn(options?.consistency ?? "authoritative").pipe(
        Effect.flatMap((page) =>
          page({
            userId,
            now,
            cursorCreatedAt: cursor?.createdAt ?? null,
            cursorId: cursor?.id ?? null,
            limit: effectiveLimit,
          }),
        ),
        Effect.flatMap((rows) => Effect.forEach(rows, revealSession)),
        Effect.map((items): Page<Session> => {
          const last = items.at(-1);
          const nextCursor =
            items.length === effectiveLimit && last !== undefined
              ? Option.some({ createdAt: last.createdAt, id: last.id })
              : Option.none();
          return { items, nextCursor };
        }),
        traced("Sessions.listByUser", { userId }),
      );
    };

    const touchQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: SessionId,
        expectedSecretHash: Schema.String,
        secretHash: Schema.String,
        lastActiveAt: models.wire.dateTime,
        idleExpiresAt: models.wire.dateTime,
      }),
      Result: models.Session,
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

    const touch: SessionsRepositoryShape["touch"] = (input) =>
      touchQuery(input).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) => revealSession(row).pipe(Effect.map(Option.some)),
          }),
        ),
        traced("Sessions.touch", { id: input.id }),
      );

    const deleteAllForUserExcept: SessionsRepositoryShape["deleteAllForUserExcept"] = (
      userId,
      keep,
    ) =>
      sql`DELETE FROM sessions WHERE "userId" = ${userId} AND id != ${keep}`.pipe(
        Effect.asVoid,
        traced("Sessions.deleteAllForUserExcept", { userId }),
      );

    // Quoted `"userId"`: this table's Postgres DDL (`CoreMigrations.ts`)
    // declares the column with preserved mixed case, which only an
    // equally-quoted reference matches there (Postgres folds an
    // unquoted identifier to lowercase); SQLite's own identifier
    // resolution is case-insensitive regardless of quoting, so the same
    // quoted form is correct on both dialects.
    const deleteAllByUser: SessionsRepositoryShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM sessions WHERE "userId" = ${userId}`.pipe(
        Effect.asVoid,
        traced("Sessions.deleteAllByUser", { userId }),
      );

    const liveIdsQuery = SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, now: models.wire.dateTime }),
      Result: Schema.Struct({ id: Schema.String, lastActiveAt: models.wire.dateTime }),
      execute: (request) => sql`
          SELECT id, "lastActiveAt" FROM sessions
          WHERE "userId" = ${request.userId}
            AND "supersededAt" IS NULL
            AND "actingAsId" IS NULL
            AND "absoluteExpiresAt" > ${request.now}
            AND "idleExpiresAt" > ${request.now}
          ORDER BY "lastActiveAt" ASC, id ASC
        `,
    });

    const listLiveIds: SessionsRepositoryShape["listLiveIds"] = (userId, now) =>
      liveIdsQuery({ userId, now }).pipe(traced("Sessions.listLiveIds", { userId }));

    const deleteOwned: SessionsRepositoryShape["deleteOwned"] = (id, userId) =>
      sql`DELETE FROM sessions WHERE id = ${id} AND "userId" = ${userId} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        traced("Sessions.deleteOwned", { id, userId }),
      );

    const tombstoneQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: SessionId,
        supersededBy: SessionId,
        supersededAt: models.wire.dateTime,
      }),
      Result: models.Session,
      execute: (request) => sql`
          UPDATE sessions
          SET "supersededBy" = ${request.supersededBy}, "supersededAt" = ${request.supersededAt}
          WHERE "id" = ${request.id} AND "supersededAt" IS NULL
          RETURNING *
        `,
    });

    const tombstone: SessionsRepositoryShape["tombstone"] = (input) =>
      tombstoneQuery(input).pipe(
        Effect.flatMap(revealSession),
        traced("Sessions.tombstone", { id: input.id }),
      );

    // SEA-005: like every other timestamp write here, `reusedAt` goes
    // through a `Request` schema, so the dialect's own wire codec is the
    // one and only encoder (interpolating a raw `DateTime.Utc` would bind
    // its internal fields instead of a timestamp).
    const markReusedQuery = SqlSchema.void({
      Request: Schema.Struct({ id: SessionId, reusedAt: models.wire.dateTime }),
      execute: (request) =>
        sql`UPDATE sessions SET "reusedAt" = ${request.reusedAt} WHERE "id" = ${request.id}`,
    });

    const markReused: SessionsRepositoryShape["markReused"] = (id, reusedAt) =>
      markReusedQuery({ id, reusedAt }).pipe(traced("Sessions.markReused", { id }));

    const revokeFamily: SessionsRepositoryShape["revokeFamily"] = (familyId) =>
      sql`DELETE FROM sessions WHERE "familyId" = ${familyId} AND "supersededAt" IS NULL`.pipe(
        Effect.asVoid,
        traced("Sessions.revokeFamily", { familyId }),
      );

    const reauthenticateQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: SessionId,
        authenticatedAt: models.wire.dateTime,
        amr: Schema.NullOr(Schema.String),
      }),
      Result: models.Session,
      execute: (request) => sql`
          UPDATE sessions
          SET "authenticatedAt" = ${request.authenticatedAt},
              "amr" = COALESCE(${request.amr}, "amr")
          WHERE "id" = ${request.id}
          RETURNING *
        `,
    });

    const reauthenticate: SessionsRepositoryShape["reauthenticate"] = (id, authenticatedAt, amr) =>
      reauthenticateQuery({ id, authenticatedAt, amr: amr ?? null }).pipe(
        Effect.flatMap(revealSession),
        traced("Sessions.reauthenticate", { id }),
      );

    return {
      models,
      insert,
      update,
      findById,
      delete: repo.delete,
      listByUser,
      touch,
      deleteAllForUserExcept,
      deleteAllByUser,
      deleteOwned,
      listLiveIds,
      tombstone,
      markReused,
      revokeFamily,
      reauthenticate,
    };
  });

export const SessionsRepositoryLive: Layer.Layer<SessionsRepository, never, SqlClient.SqlClient> =
  Layer.effect(SessionsRepository, makeSessionsRepository(Option.none()));

/**
 * CSG-006 (option B, opt-in): `sessions.ipAddress` and `sessions.userAgent` are
 * encrypted at rest through `Encryption` (AAD `session:<id>:<field>`). Swap this
 * in for `SessionsRepositoryLive` to enable it. Rows written earlier as
 * plaintext stay readable and are sealed on their next read
 * (`AccountsRepositoryConfig.reencryptOnRead`). The secret hash is unaffected
 * (it is already hash-only), and lookups never filter on these columns.
 */
export const SessionsRepositoryEncryptedLive: Layer.Layer<
  SessionsRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  SessionsRepository,
  Effect.flatMap(Encryption.Encryption, (encryption) =>
    makeSessionsRepository(Option.some(sealedPii(encryption))),
  ),
);

// ---- Verification ---------------------------------------------------------

export interface VerificationRepositoryShape {
  /** TS-001: the dialect-resolved models this repository decodes with. */
  readonly models: SqlModels;
  readonly insert: (
    input: VerificationTokenInsert,
  ) => Effect.Effect<VerificationToken, RepositoryError>;
  readonly update: (
    input: VerificationTokenUpdate,
  ) => Effect.Effect<VerificationToken, RepositoryError>;
  readonly findById: (
    id: VerificationTokenId,
  ) => Effect.Effect<VerificationToken, Cause.NoSuchElementError | RepositoryError>;
  /** PPS-003: the current live (unconsumed) token for `identifier`, if any. */
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
   *
   * ACS-002: the digest equality happens inside this predicate rather than
   * through `Hmac`'s comparison — an accepted exception, since both sides are
   * SHA-256 of a 256-bit random secret (BEH-EA-060).
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
    const models = makeModels(yield* resolveDialect(sql));
    const repo = yield* SqlModel.makeRepository(models.VerificationToken, {
      tableName: "verification_tokens",
      spanPrefix: "VerificationTokens",
      idColumn: "id",
    });

    const findByIdentifierQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: models.VerificationToken,
      // PPS-003: the live row only — the partial unique index
      // `verification_tokens_live_identifier` (`WHERE "consumedAt" IS NULL`)
      // holds at most one such row per identifier, so no sort and no scan of
      // the consumed history the table keeps. Nothing needs "the latest
      // including consumed": ADR-EA-016's `upsertLive`/`tryConsume` own the
      // write paths.
      execute: (identifier) =>
        sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} AND "consumedAt" IS NULL`,
    });

    // `identifier` embeds a user id or email (`verify-email:<userId>`), so it
    // is never a span attribute.
    const findByIdentifier: VerificationRepositoryShape["findByIdentifier"] = (identifier) =>
      findByIdentifierQuery(identifier).pipe(traced("VerificationTokens.findByIdentifier"));

    const upsertLiveQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: VerificationTokenId,
        identifier: Schema.String,
        userId: Schema.NullOr(UserId),
        valueHash: Schema.String,
        expiresAt: models.wire.dateTime,
        createdAt: models.wire.dateTime,
        payload: Schema.fromJsonString(Schema.Unknown),
      }),
      Result: models.VerificationToken,
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

    const upsertLive: VerificationRepositoryShape["upsertLive"] = (input) =>
      upsertLiveQuery(input).pipe(traced("VerificationTokens.upsertLive", { id: input.id }));

    const deleteAllByUser: VerificationRepositoryShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM verification_tokens WHERE "userId" = ${userId}`.pipe(
        Effect.asVoid,
        traced("VerificationTokens.deleteAllByUser", { userId }),
      );

    const tryConsumeQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        identifier: Schema.String,
        valueHash: Schema.String,
        now: models.wire.dateTime,
      }),
      Result: models.VerificationToken,
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

    const tryConsume: VerificationRepositoryShape["tryConsume"] = (input) =>
      tryConsumeQuery(input).pipe(traced("VerificationTokens.tryConsume"));

    return {
      models,
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
    const models = makeModels(yield* resolveDialect(sql));

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
        expiresAt: models.wire.dateTime,
        now: models.wire.dateTime,
      }),
      Result: models.VerificationReservation,
      execute: (request) => sql`
        INSERT INTO verification_reservations (identifier, "expiresAt")
        VALUES (${request.identifier}, ${request.expiresAt})
        ON CONFLICT(identifier) DO UPDATE SET "expiresAt" = excluded."expiresAt"
        WHERE verification_reservations."expiresAt" < ${request.now}
        RETURNING *
      `,
    });

    const claim: VerificationReservationsRepositoryShape["claim"] = (input) =>
      attempt(input).pipe(Effect.map(Option.isSome), traced("VerificationReservations.claim"));

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
  /** RRC-001: a history listing — `"eventual"` (replica-eligible) unless `options.consistency` says otherwise. */
  readonly list: (
    input: {
      readonly eventTag: string | null;
      readonly actorUserId: string | null;
      readonly occurredAfter: DateTime.Utc | null;
      readonly occurredBefore: DateTime.Utc | null;
    },
    options?: ReadRouting.ReadOptions,
  ) => Effect.Effect<ReadonlyArray<AuditLogRow>, RepositoryError>;
}

export class AuditLogRepository extends Context.Service<
  AuditLogRepository,
  AuditLogRepositoryShape
>()("awthaq/sql/AuditLogRepository") {}

export const AuditLogRepositoryLive: Layer.Layer<AuditLogRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    AuditLogRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const models = makeModels(yield* resolveDialect(sql));

      const insertQuery = SqlSchema.findOne({
        Request: Schema.Struct({
          id: Schema.String,
          eventTag: Schema.String,
          actorUserId: Schema.NullOr(Schema.String),
          occurredAt: models.wire.dateTime,
          correlationId: Schema.NullOr(Schema.String),
          payload: Schema.fromJsonString(Schema.Unknown),
        }),
        Result: models.AuditLogRow,
        execute: (r) => sql`
        INSERT INTO auth_audit_log (id, "eventTag", "actorUserId", "occurredAt", "correlationId", payload)
        VALUES (${r.id}, ${r.eventTag}, ${r.actorUserId}, ${r.occurredAt}, ${r.correlationId}, ${r.payload})
        RETURNING *
      `,
      });

      // RRC-001: a history listing — replica-eligible, and `"eventual"` by
      // default (a fiber that just wrote is held to the primary by its causal
      // token; pass `"authoritative"` to force the primary regardless).
      const router = yield* ReadRouting.makeRouter;
      const listOn = router.route((client) =>
        SqlSchema.findAll({
          Request: Schema.Struct({
            eventTag: Schema.NullOr(Schema.String),
            actorUserId: Schema.NullOr(Schema.String),
            occurredAfter: models.wire.nullableDateTime,
            occurredBefore: models.wire.nullableDateTime,
          }),
          Result: models.AuditLogRow,
          execute: (r) => {
            const conditions = [
              ...(r.eventTag === null ? [] : [client`"eventTag" = ${r.eventTag}`]),
              ...(r.actorUserId === null ? [] : [client`"actorUserId" = ${r.actorUserId}`]),
              ...(r.occurredAfter === null ? [] : [client`"occurredAt" >= ${r.occurredAfter}`]),
              ...(r.occurredBefore === null ? [] : [client`"occurredAt" <= ${r.occurredBefore}`]),
            ];
            return client`SELECT * FROM auth_audit_log WHERE ${client.and(conditions)} ORDER BY "occurredAt" DESC`;
          },
        }),
      );

      const insert: AuditLogRepositoryShape["insert"] = (input) =>
        insertQuery(input).pipe(
          traced("AuditLog.insert", { id: input.id, eventTag: input.eventTag }),
        );

      const list: AuditLogRepositoryShape["list"] = (input, options) =>
        listOn(options?.consistency ?? "eventual").pipe(
          Effect.flatMap((query) => query(input)),
          traced("AuditLog.list"),
        );

      return { insert, list };
    }),
  );
