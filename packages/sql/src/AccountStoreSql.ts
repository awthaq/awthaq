// @awthaq/sql — AccountStoreSql
//
// Plan 02 (ADR-EA-041): the SQL adapter of `@awthaq/ports`' `AccountStore`, over `AccountsRepository`
// (so token encryption is unchanged except its AAD, `accounts:<id>:<field>` since plan 17, which binds the
// account row; the tokens are handed to the domain sealed, and lazily re-sealed when it opens them).
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

import { AccountStore, SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AccountsRepository,
  type AccountIdentityRow,
  type AccountTokenColumns,
  type SealedTokenRow,
} from "./Repositories.ts";
import * as SqlStore from "./SqlStore.ts";

const toIdentity = (row: AccountIdentityRow): AccountStore.AccountIdentity => ({
  id: row.id,
  userId: row.userId,
  providerId: row.providerId,
  subject: row.subject,
  issuer: row.issuer,
  tenantId: Option.fromNullOr(row.tenantId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** BE-002: a `ProviderTokens` as the plaintext columns the repository encrypts; no tokens is all `null`. */
const toColumns = (tokens: Option.Option<AccountStore.ProviderTokens>): AccountTokenColumns =>
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

/** The stored token group as the port carries it: `None` when the row has no stored access token. */
const toTokens = (row: SealedTokenRow): Option.Option<AccountStore.SealedProviderTokens> =>
  Option.map(row.accessToken, (accessToken) => ({
    accessToken,
    refreshToken: row.refreshToken,
    idToken: row.idToken,
    accessTokenExpiresAt: Option.fromNullOr(row.accessTokenExpiresAt),
    refreshTokenExpiresAt: Option.fromNullOr(row.refreshTokenExpiresAt),
    scope: Option.fromNullOr(row.scope),
    tokenType: Option.fromNullOr(row.tokenType),
  }));

const notFound: AccountStore.DeleteOutcome = { _tag: "NotFound" };
const deleted: AccountStore.DeleteOutcome = { _tag: "Deleted" };

/** The SQL adapter. Requires the accounts repository and the client its delete transaction runs on. */
export const layer = Layer.effect(
  AccountStore.AccountStore,
  Effect.gen(function* () {
    const repo = yield* AccountsRepository;
    const sql = yield* SqlClient.SqlClient;
    const { write, read, once } = SqlStore.make(sql);

    const insertIfAbsent: AccountStore.AccountStoreShape["insertIfAbsent"] = (row) =>
      repo
        .insertIdentityIfAbsent({
          id: row.id,
          userId: row.userId,
          providerId: row.providerId,
          subject: row.subject,
          issuer: row.issuer,
          passwordHash: Option.getOrNull(Option.map(row.credentialHash, Redacted.value)),
          tokens: toColumns(row.tokens),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        .pipe(Effect.map(Option.map(toIdentity)), once("AccountStore.insertIfAbsent"));

    const get: AccountStore.AccountStoreShape["get"] = (id) =>
      repo.findIdentityById(id).pipe(Effect.map(Option.map(toIdentity)), read("AccountStore.get"));

    const getByKey: AccountStore.AccountStoreShape["getByKey"] = (providerId, subject, issuer) =>
      repo
        .findIdentityByKey(providerId, subject, issuer)
        .pipe(Effect.map(Option.map(toIdentity)), read("AccountStore.getByKey"));

    const listByUser: AccountStore.AccountStoreShape["listByUser"] = (userId) =>
      repo.listIdentitiesByUser(userId).pipe(
        Effect.map((rows) => rows.map(toIdentity)),
        read("AccountStore.listByUser"),
      );

    const readCredentialHash: AccountStore.AccountStoreShape["readCredentialHash"] = (id) =>
      repo
        .findPasswordHash(id)
        .pipe(
          Effect.map(Option.map((hash) => Option.map(Option.fromNullOr(hash), Redacted.make))),
          read("AccountStore.readCredentialHash"),
        );

    const readProviderTokens: AccountStore.AccountStoreShape["readProviderTokens"] = (id) =>
      repo
        .findSealedTokensById(id)
        .pipe(Effect.map(Option.map(toTokens)), read("AccountStore.readProviderTokens"));

    const writeCredentialHash: AccountStore.AccountStoreShape["writeCredentialHash"] = (
      id,
      hash,
      at,
    ) =>
      repo
        .writePasswordHash(id, Redacted.value(hash), at)
        .pipe(write("AccountStore.writeCredentialHash"));

    const writeProviderTokens: AccountStore.AccountStoreShape["writeProviderTokens"] = (
      id,
      tokens,
      at,
    ) =>
      repo
        .writeTokens(id, toColumns(Option.some(tokens)), at)
        .pipe(write("AccountStore.writeProviderTokens"));

    const deleteUnlessLast: AccountStore.AccountStoreShape["deleteUnlessLast"] = (id, allowZero) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          const target = yield* repo.findIdentityById(id);
          if (Option.isNone(target)) return notFound;
          const userId = target.value.userId;
          // BEH-EA-045: hold the user's account rows before counting them, so a concurrent unlink of a
          // sibling waits for this transaction and then counts what is really left.
          yield* repo.lockByUser(userId);
          const siblings = yield* repo.listIdentitiesByUser(userId);
          if (!siblings.some((row) => row.id === id)) return notFound;
          if (siblings.length <= 1 && !allowZero) {
            const refused: AccountStore.DeleteOutcome = { _tag: "LastAccount", userId };
            return refused;
          }
          yield* repo.delete(id);
          return deleted;
        }),
      ).pipe(once("AccountStore.deleteUnlessLast"));

    const deleteByUser: AccountStore.AccountStoreShape["deleteByUser"] = (userId) =>
      repo.deleteAllByUser(userId).pipe(write("AccountStore.deleteByUser"));

    return AccountStore.AccountStore.of({
      insertIfAbsent,
      getByKey,
      get,
      listByUser,
      readCredentialHash,
      readProviderTokens,
      writeCredentialHash,
      writeProviderTokens,
      deleteUnlessLast,
      deleteByUser,
    });
  }),
);
