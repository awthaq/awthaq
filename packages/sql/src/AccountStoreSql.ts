// @awthaq/sql — AccountStoreSql
//
// Plan 02 / plan 16 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `AccountStore`. It owns every
// statement over `accounts` (moved verbatim from the former `Repositories.ts`), the sealing of the
// three provider-token columns, the tenant stamp (`Tenant.resolve`, BEH-EA-231), the Postgres
// `FOR UPDATE` of the last-account guard and the failure classification.
//
// Token encryption (plan 17): each token column is a declared `SealedColumn`
// (`CoreSealedColumns.accounts*`), AAD `accounts:<id>:<field>`, which binds the ciphertext to the
// account row and column, so a token cannot be copied to another account (even of the same user and
// provider) or to another token column. The tokens are handed to the domain sealed (nothing is
// opened here), and lazily re-sealed when the domain opens them.
//
// - Identity reads (`get`, `getByKey`, `listByUser`) select the identity columns only: no token is
//   decrypted and nothing is written on the read path. `readProviderTokens` is the one strict path,
//   and it decrypts nothing itself (the tokens leave sealed).
// - `insertIfAbsent` is one `INSERT ... ON CONFLICT ("providerId", subject, issuer) DO NOTHING`, so a
//   taken key is `None`, never a unique violation, and never aborts an enclosing Postgres transaction.
// - `deleteUnlessLast` is one transaction (a savepoint inside a caller's): it locks the user's account
//   rows first (Postgres `FOR UPDATE`), then counts and deletes. Without the lock, two concurrent
//   unlinks of a user's two different accounts each count two siblings under READ COMMITTED and both
//   commit, leaving none (BEH-EA-045).
// - Retried on a transient failure: the idempotent primitives only (the two writes and
//   `deleteByUser`). `insertIfAbsent` and `deleteUnlessLast` are not: repeating either after a success
//   whose answer was lost would change it.
// - Span names are the statements' (`Accounts.*`, EOTS-008); `subject`/`issuer` identify a person at
//   an IdP, so only `providerId` is ever a span attribute.

import { AccountStore, type Encryption, SqlTransaction, Tenant } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlModel from "effect/sql/SqlModel";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as CoreSealedColumns from "./CoreSealedColumns.ts";
import { sealCell, sealedCell } from "./internal/Cells.ts";
import { traced } from "./internal/traced.ts";
import { AccountId, makeModels, resolveDialect, UserId } from "./Models.ts";
import * as SealedColumn from "./SealedColumn.ts";
import * as SqlStore from "./SqlStore.ts";

/** The provider-token columns written together (plaintext on the way in; sealed before they reach SQL). */
interface TokenColumns {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly accessTokenExpiresAt: DateTime.Utc | null;
  readonly refreshTokenExpiresAt: DateTime.Utc | null;
  readonly scope: string | null;
  readonly tokenType: string | null;
}

/** BE-002: a `ProviderTokens` as plaintext columns; no tokens is all `null`. */
const toColumns = (tokens: Option.Option<AccountStore.ProviderTokens>): TokenColumns =>
  Option.match(tokens, {
    onNone: () => ({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      tokenType: null,
    }),
    onSome: (set) => ({
      accessToken: Redacted.value(set.accessToken),
      refreshToken: Option.getOrNull(Option.map(set.refreshToken, Redacted.value)),
      idToken: Option.getOrNull(Option.map(set.idToken, Redacted.value)),
      accessTokenExpiresAt: Option.getOrNull(set.accessTokenExpiresAt),
      refreshTokenExpiresAt: Option.getOrNull(set.refreshTokenExpiresAt),
      scope: Option.getOrNull(set.scope),
      tokenType: Option.getOrNull(set.tokenType),
    }),
  });

const notFound: AccountStore.DeleteOutcome = { _tag: "NotFound" };
const deleted: AccountStore.DeleteOutcome = { _tag: "Deleted" };

/** What the adapter requires: the client its statements run on, and the `Encryption` the tokens are sealed with. */
export type Requires = SqlClient.SqlClient | Encryption.Encryption;

/** The SQL adapter. Requires `SqlClient | Encryption`. */
export const layer = Layer.effect(
  AccountStore.AccountStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* resolveDialect(sql);
    const models = makeModels(dialect);
    const crud = yield* SqlModel.makeRepository(models.Account, {
      tableName: "accounts",
      spanPrefix: "Accounts",
      idColumn: "id",
    });
    const codecs = {
      accessToken: yield* SealedColumn.sqlCodec(CoreSealedColumns.accountsAccessToken),
      refreshToken: yield* SealedColumn.sqlCodec(CoreSealedColumns.accountsRefreshToken),
      idToken: yield* SealedColumn.sqlCodec(CoreSealedColumns.accountsIdToken),
    };
    const { write, read, once } = SqlStore.make(sql);

    /** The token cells of `columns`, each sealed under the account's canonical AAD. */
    const sealTokens = (id: string, columns: TokenColumns) =>
      Effect.all({
        accessToken: sealCell(Option.some(codecs.accessToken), id, columns.accessToken),
        refreshToken: sealCell(Option.some(codecs.refreshToken), id, columns.refreshToken),
        idToken: sealCell(Option.some(codecs.idToken), id, columns.idToken),
      });

    // ---- identity: everything but the credential hash and the tokens -----------------------------
    // Decoded straight into the port's record (`tenantId` as an `Option`).
    const IdentityRow = Schema.Struct({
      id: AccountId,
      userId: UserId,
      providerId: Schema.String,
      subject: Schema.String,
      issuer: Schema.String,
      tenantId: Schema.OptionFromNullOr(Schema.String),
      createdAt: models.wire.dateTime,
      updatedAt: models.wire.dateTime,
    });
    const identityColumns = sql`id, "userId", "providerId", subject, issuer, "tenantId", "createdAt", "updatedAt"`;

    const identityByIdQuery = SqlSchema.findOneOption({
      Request: AccountId,
      Result: IdentityRow,
      execute: (id) => sql`SELECT ${identityColumns} FROM accounts WHERE id = ${id}`,
    });

    const identityByKeyQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        providerId: Schema.String,
        subject: Schema.String,
        issuer: Schema.String,
      }),
      Result: IdentityRow,
      execute: (request) =>
        sql`SELECT ${identityColumns} FROM accounts WHERE "providerId" = ${request.providerId} AND subject = ${request.subject} AND issuer = ${request.issuer}`,
    });

    // BEH-EA-036: a user's accounts in `(createdAt, id)` order.
    const identitiesByUserQuery = SqlSchema.findAll({
      Request: UserId,
      Result: IdentityRow,
      execute: (userId) =>
        sql`SELECT ${identityColumns} FROM accounts WHERE "userId" = ${userId} ORDER BY "createdAt" ASC, id ASC`,
    });

    // `INSERT ... ON CONFLICT ("providerId", subject, issuer) DO NOTHING RETURNING <identity>`: `None`
    // when the key is taken, and a taken key never aborts an enclosing Postgres transaction
    // (BEH-EA-043). The tokens are sealed before they get here (AAD `accounts:<id>:<field>`).
    const insertIdentityQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: AccountId,
        userId: UserId,
        providerId: Schema.String,
        subject: Schema.String,
        issuer: Schema.String,
        tenantId: Schema.NullOr(Schema.String),
        passwordHash: Schema.NullOr(Schema.String),
        accessToken: Schema.NullOr(Schema.String),
        refreshToken: Schema.NullOr(Schema.String),
        idToken: Schema.NullOr(Schema.String),
        accessTokenExpiresAt: models.wire.nullableDateTime,
        refreshTokenExpiresAt: models.wire.nullableDateTime,
        scope: Schema.NullOr(Schema.String),
        tokenType: Schema.NullOr(Schema.String),
        createdAt: models.wire.dateTime,
        updatedAt: models.wire.dateTime,
      }),
      Result: IdentityRow,
      execute: (r) => sql`
        INSERT INTO accounts (id, "userId", "providerId", subject, issuer, "tenantId", "passwordHash",
          "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt",
          scope, "tokenType", "createdAt", "updatedAt")
        VALUES (${r.id}, ${r.userId}, ${r.providerId}, ${r.subject}, ${r.issuer}, ${r.tenantId},
          ${r.passwordHash}, ${r.accessToken}, ${r.refreshToken}, ${r.idToken},
          ${r.accessTokenExpiresAt}, ${r.refreshTokenExpiresAt}, ${r.scope}, ${r.tokenType},
          ${r.createdAt}, ${r.updatedAt})
        ON CONFLICT ("providerId", subject, issuer) DO NOTHING
        RETURNING ${identityColumns}
      `,
    });

    // BEH-EA-044: only the stored hash (no token column is read). Outer `None` = no such account.
    const passwordHashQuery = SqlSchema.findOneOption({
      Request: AccountId,
      Result: Schema.Struct({ passwordHash: Schema.NullOr(Schema.String) }),
      execute: (id) => sql`SELECT "passwordHash" FROM accounts WHERE id = ${id}`,
    });

    // SMS-002: the strict token read. Nothing is opened here: the domain opens (and the codec lazily
    // re-seals) the cells it needs, and decides what an unreadable one means.
    const tokensByIdQuery = SqlSchema.findOneOption({
      Request: AccountId,
      Result: Schema.Struct({
        accessToken: Schema.NullOr(Schema.String),
        refreshToken: Schema.NullOr(Schema.String),
        idToken: Schema.NullOr(Schema.String),
        accessTokenExpiresAt: models.wire.nullableDateTime,
        refreshTokenExpiresAt: models.wire.nullableDateTime,
        scope: Schema.NullOr(Schema.String),
        tokenType: Schema.NullOr(Schema.String),
      }),
      execute: (id) => sql`
        SELECT "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt",
               "refreshTokenExpiresAt", scope, "tokenType"
        FROM accounts WHERE id = ${id}`,
    });

    // BEH-EA-116: replaces the hash and sets `updatedAt`; no rows = no such account. Reads no token.
    const writePasswordHashQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        id: AccountId,
        passwordHash: Schema.String,
        updatedAt: models.wire.dateTime,
      }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) =>
        sql`UPDATE accounts SET "passwordHash" = ${r.passwordHash}, "updatedAt" = ${r.updatedAt} WHERE id = ${r.id} RETURNING id`,
    });

    // SMS-002: replaces the whole token group and sets `updatedAt`.
    const writeTokensQuery = SqlSchema.findAll({
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
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) => sql`
        UPDATE accounts
        SET "accessToken" = ${r.accessToken}, "refreshToken" = ${r.refreshToken},
            "idToken" = ${r.idToken}, "accessTokenExpiresAt" = ${r.accessTokenExpiresAt},
            "refreshTokenExpiresAt" = ${r.refreshTokenExpiresAt}, scope = ${r.scope},
            "tokenType" = ${r.tokenType}, "updatedAt" = ${r.updatedAt}
        WHERE id = ${r.id}
        RETURNING id
      `,
    });

    // Shipping-gap map ticket 09/10: whole-user deletion's own cascade — deliberately bypasses
    // `deleteUnlessLast`'s last-account refusal (BEH-EA-045), which exists to stop a user locking
    // themselves out of an otherwise-still-existing account, not to block deleting the account
    // entirely. A raw bulk statement, not `delete` called once per row.
    const deleteAllByUserQuery = SqlSchema.findAll({
      Request: UserId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (userId) => sql`DELETE FROM accounts WHERE "userId" = ${userId} RETURNING id`,
    });

    // BEH-EA-045: locks every account row of `userId` for the rest of the enclosing transaction
    // (Postgres `SELECT ... FOR UPDATE`; a no-op on SQLite and libSQL, whose drivers already open the
    // transaction as a write transaction). Two concurrent unlinks of a user's two different accounts
    // would otherwise each count two siblings under READ COMMITTED and both commit, leaving the user
    // with none.
    const lockByUser = (userId: UserId) =>
      dialect === "pg"
        ? sql`SELECT id FROM accounts WHERE "userId" = ${userId} FOR UPDATE`.pipe(
            Effect.asVoid,
            traced("Accounts.lockByUser", { userId }),
          )
        : Effect.void;

    return AccountStore.AccountStore.of({
      insertIfAbsent: (row) =>
        Effect.gen(function* () {
          const tokens = toColumns(row.tokens);
          const sealed = yield* sealTokens(row.id, tokens);
          const tenantId = yield* Tenant.resolve(Option.none());
          return yield* insertIdentityQuery({
            id: row.id,
            userId: row.userId,
            providerId: row.providerId,
            subject: row.subject,
            issuer: row.issuer,
            tenantId: Option.getOrNull(tenantId),
            passwordHash: Option.getOrNull(Option.map(row.credentialHash, Redacted.value)),
            ...sealed,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            scope: tokens.scope,
            tokenType: tokens.tokenType,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }).pipe(
          traced("Accounts.insertIdentityIfAbsent", { id: row.id }),
          once("AccountStore.insertIfAbsent"),
        ),

      getByKey: (providerId, subject, issuer) =>
        identityByKeyQuery({ providerId, subject, issuer }).pipe(
          traced("Accounts.findIdentityByKey", { providerId }),
          read("AccountStore.getByKey"),
        ),

      get: (id) =>
        identityByIdQuery(id).pipe(
          traced("Accounts.findIdentityById", { id }),
          read("AccountStore.get"),
        ),

      listByUser: (userId) =>
        identitiesByUserQuery(userId).pipe(
          traced("Accounts.listIdentitiesByUser", { userId }),
          read("AccountStore.listByUser"),
        ),

      readCredentialHash: (id) =>
        passwordHashQuery(id).pipe(
          traced("Accounts.findPasswordHash", { id }),
          Effect.map(
            Option.map((row) => Option.map(Option.fromNullOr(row.passwordHash), Redacted.make)),
          ),
          read("AccountStore.readCredentialHash"),
        ),

      readProviderTokens: (id) =>
        tokensByIdQuery(id).pipe(
          Effect.map(
            Option.map((row) =>
              // The stored token group: `None` when the row has no stored access token.
              Option.map(
                sealedCell(Option.some(codecs.accessToken), id, row.accessToken),
                (accessToken) => ({
                  accessToken,
                  refreshToken: sealedCell(Option.some(codecs.refreshToken), id, row.refreshToken),
                  idToken: sealedCell(Option.some(codecs.idToken), id, row.idToken),
                  accessTokenExpiresAt: Option.fromNullOr(row.accessTokenExpiresAt),
                  refreshTokenExpiresAt: Option.fromNullOr(row.refreshTokenExpiresAt),
                  scope: Option.fromNullOr(row.scope),
                  tokenType: Option.fromNullOr(row.tokenType),
                }),
              ),
            ),
          ),
          traced("Accounts.findSealedTokensById", { id }),
          read("AccountStore.readProviderTokens"),
        ),

      writeCredentialHash: (id, hash, at) =>
        writePasswordHashQuery({ id, passwordHash: Redacted.value(hash), updatedAt: at }).pipe(
          Effect.map((rows) => rows.length > 0),
          traced("Accounts.writePasswordHash", { id }),
          write("AccountStore.writeCredentialHash"),
        ),

      // The AAD is the account id the caller already holds, so this is one `UPDATE` and the old
      // ciphertext is never read or decrypted: a row whose old tokens are unreadable heals on this write.
      writeProviderTokens: (id, tokens, at) =>
        Effect.gen(function* () {
          const columns = toColumns(Option.some(tokens));
          const sealed = yield* sealTokens(id, columns);
          const rows = yield* writeTokensQuery({
            ...columns,
            ...sealed,
            id,
            updatedAt: at,
          });
          return rows.length > 0;
        }).pipe(traced("Accounts.writeTokens", { id }), write("AccountStore.writeProviderTokens")),

      deleteUnlessLast: (id, allowZero) =>
        SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            const target = yield* identityByIdQuery(id).pipe(
              traced("Accounts.findIdentityById", { id }),
            );
            if (Option.isNone(target)) return notFound;
            const userId = target.value.userId;
            // BEH-EA-045: hold the user's account rows before counting them, so a concurrent unlink
            // of a sibling waits for this transaction and then counts what is really left.
            yield* lockByUser(userId);
            const siblings = yield* identitiesByUserQuery(userId).pipe(
              traced("Accounts.listIdentitiesByUser", { userId }),
            );
            if (!siblings.some((row) => row.id === id)) return notFound;
            if (siblings.length <= 1 && !allowZero) {
              const refused: AccountStore.DeleteOutcome = { _tag: "LastAccount", userId };
              return refused;
            }
            yield* crud.delete(id);
            return deleted;
          }),
        ).pipe(once("AccountStore.deleteUnlessLast")),

      deleteByUser: (userId) =>
        deleteAllByUserQuery(userId).pipe(
          Effect.map((rows) => rows.length),
          traced("Accounts.deleteAllByUser", { userId }),
          write("AccountStore.deleteByUser"),
        ),
    });
  }),
);
