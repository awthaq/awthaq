// @awthaq/sql — CoreStoresSql
//
// Plan 16 (ADR-EA-041 decisions 3 and 4): every core SQL store over ONE ambient `SqlClient`, plus
// `SqlTransaction.layerSql` over the same client (INV-EA-017: the core identity tables share one
// transaction domain) and the `SealedColumn.Deployed` list of the columns really sealed. `@awthaq/core`'s
// `Persistence.sql` is this function. The per-store layers stay public: swapping one store stays legal
// (ADR-EA-014), and explicit — merge another adapter after the bundle.
//
//   Layer.merge(CoreStoresSql.layer(), KvSessionStore.layer)   // the later layer wins in the merged context

import {
  type AccountStore,
  type AuditLogStore,
  type Encryption,
  type RelayCursorStore,
  type SessionStore,
  SqlTransaction,
  type UserStore,
  type VerificationStore,
} from "@awthaq/ports";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AccountStoreSql from "./AccountStoreSql.ts";
import * as AuditLogStoreSql from "./AuditLogStoreSql.ts";
import * as CoreSealedColumns from "./CoreSealedColumns.ts";
import * as RelayCursorStoreSql from "./RelayCursorStoreSql.ts";
import * as SealedColumn from "./SealedColumn.ts";
import * as SessionStoreSql from "./SessionStoreSql.ts";
import * as UserStoreSql from "./UserStoreSql.ts";
import * as VerificationStoreSql from "./VerificationStoreSql.ts";

export interface Options {
  /**
   * CSG-006: seal `users.metadata` and `sessions.ipAddress`/`userAgent` at rest through `Encryption`
   * (AAD `<table>:<id>:<column>`, ADR-EA-019 decision 6). Default `false`. Provider tokens are always
   * sealed. The bundle provides `SealedColumn.Deployed`, the list of the columns it really seals, so
   * after a key rotation `SealedColumn.sweepDeployed` re-seals exactly those (and never seals a plaintext one).
   */
  readonly encryptPii?: boolean;
}

/** The stores the bundle provides (named here so declaration emit can reach the ports, TS2883). */
export type Provides =
  | AccountStore.AccountStore
  | AuditLogStore.AuditLogStore
  | RelayCursorStore.RelayCursorStore
  | SealedColumn.Deployed
  | SessionStore.SessionStore
  | UserStore.UserStore
  | VerificationStore.VerificationStore;

/** What the bundle requires: the one client, and the encryption provider tokens are sealed with. */
export type Requires = SqlClient.SqlClient | Encryption.Encryption;

/** Requires `SqlClient | Encryption` (the accounts adapter seals provider tokens). */
export const layer = (options?: Options) => {
  // One value decides both the stores and the `Deployed` list, so the two cannot disagree.
  const encryptPii = options?.encryptPii === true;
  return Layer.mergeAll(
    encryptPii ? UserStoreSql.layerSealedPii : UserStoreSql.layer,
    AccountStoreSql.layer,
    encryptPii ? SessionStoreSql.layerSealedPii : SessionStoreSql.layer,
    VerificationStoreSql.layer,
    AuditLogStoreSql.layer,
    RelayCursorStoreSql.layer,
    SqlTransaction.layerSql,
    Layer.succeed(SealedColumn.Deployed, { columns: CoreSealedColumns.deployed({ encryptPii }) }),
  );
};
