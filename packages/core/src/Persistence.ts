// @awthaq/core — Persistence
//
// Plan 02 (ADR-EA-041): the matched store bundles. Each core service (`Users`, `Accounts`, `Sessions`,
// `Verification`, `AuditLog`) is written once over a store port; a composition provides the five
// stores, and the transaction that goes with them, once. Matching is the point: a bundle supplies every
// store AND the right `SqlTransaction` (a no-op beside the `Ref` stores, a real one over the same
// `SqlClient` beside the SQL stores), so a composition cannot pair a memory store with a SQL
// transaction by accident, which used to leave a swapped module's writes silently outside it
// (INV-EA-017, DRS-006).
//
// Swapping one store is still legal (ADR-EA-014), and explicit:
//
//   Layer.merge(Persistence.sql(), KvSessionStore.layer)   // the later layer wins in the merged context
//
// A store outside the `SqlTransaction` takes no part in its rollback, so its participation in erasure
// (ADR-EA-031) must be idempotent and retry-safe. Deleting sessions is.

import {
  AccountStore,
  AuditLogStore,
  type Encryption,
  SessionStore,
  SqlTransaction,
  UserStore,
  VerificationStore,
} from "@awthaq/ports";
import {
  AccountStoreSql,
  AuditLogStoreSql,
  Repositories,
  SessionStoreSql,
  UserStoreSql,
  VerificationStoreSql,
} from "@awthaq/sql";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * TRBS-005: test-grade, single-process. Every store is a `Ref`, and the transaction is `layerNoop`:
 * each primitive is atomic on its own, but a unit spanning several is not rolled back as a whole (see
 * `SqlTransaction.layerNoop`). Lost on restart, not shared across instances.
 */
export const memory = Layer.mergeAll(
  UserStore.layerMemory,
  AccountStore.layerMemory,
  SessionStore.layerMemory,
  VerificationStore.layerMemory,
  AuditLogStore.layerMemory,
  SqlTransaction.layerNoop,
);

export interface SqlOptions {
  /**
   * CSG-006: seal `users.metadata` and `sessions.ipAddress`/`userAgent` at rest through `Encryption`
   * (AAD `<entity>:<id>:<field>`). Default `false`. Provider tokens are always sealed.
   */
  readonly encryptPii?: boolean;
}

/** What `sql(...)` requires of a composition: the one client, and the encryption provider tokens are sealed with. */
export type SqlRequirements = SqlClient.SqlClient | Encryption.Encryption;

/**
 * Every SQL store over ONE `SqlClient`, and `SqlTransaction.layerSql` over the same client
 * (INV-EA-017: the core identity tables share one transaction domain). Requires `SqlClient` and
 * `Encryption` (the accounts repository seals provider tokens).
 */
export const sql = (options?: SqlOptions) =>
  Layer.mergeAll(
    UserStoreSql.layer,
    AccountStoreSql.layer,
    SessionStoreSql.layer,
    VerificationStoreSql.layer,
    AuditLogStoreSql.layer,
    SqlTransaction.layerSql,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        options?.encryptPii === true
          ? Repositories.UsersRepositoryEncryptedLive
          : Repositories.UsersRepositoryLive,
        options?.encryptPii === true
          ? Repositories.SessionsRepositoryEncryptedLive
          : Repositories.SessionsRepositoryLive,
        Repositories.AccountsRepositoryLive,
        Repositories.VerificationRepositoryLive,
        Repositories.VerificationReservationsRepositoryLive,
        Repositories.AuditLogRepositoryLive,
      ),
    ),
  );
