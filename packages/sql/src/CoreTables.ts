// @awthaq/sql: CoreTables (CAT-01..03, BEH-EA-231/232/233)
//
// The one declared list of the tables core owns. It is a classification, not a schema (ADR-EA-004):
// no column names, types, defaults, indexes or DDL live here; `test/CoreTables.test.ts` compares the
// list with what the migrations really create instead. Rows are in migration-creation order and that
// order is a contract (`TenantScope.partitionedTables`, the order `enableRls` issues DDL, the order
// `LaggingReplica` copies in), so no view ever sorts. Adding a core table is one row here plus its
// migration, and the drift guard fails otherwise. The sealed view is `CoreSealedColumns`, never a
// second list of sealed columns.

import * as CoreSealedColumns from "./CoreSealedColumns.ts";
import type * as SealedColumn from "./SealedColumn.ts";

/**
 * How a core table relates to tenants. `partitioned`: a `"tenantId"` column the row-level-security
 * policy filters on. `directory`: a `"tenantId"` column that is a membership stamp, resolved
 * across tenants (users, accounts). `none`: no `"tenantId"` column at all.
 */
export type Tenancy = "partitioned" | "directory" | "none";

const declared = [
  { name: "users", tenancy: "directory", replicated: true },
  { name: "accounts", tenancy: "directory", replicated: true },
  { name: "sessions", tenancy: "partitioned", replicated: true },
  { name: "verification_tokens", tenancy: "partitioned", replicated: true },
  { name: "verification_reservations", tenancy: "partitioned", replicated: true },
  { name: "auth_audit_log", tenancy: "partitioned", replicated: true },
  {
    name: "auth_relay_cursor",
    tenancy: "none",
    replicated: false,
    reason:
      "no tenant column: one row per named relay, deployment-wide (migration 27 declares only name, lastEventId, updatedAt). Not mirrored by a replica because a relay reads its cursor from the primary only (RelayCursorStoreSql.get) and must never resume from a stale position.",
  },
  {
    name: "rate_limit_buckets",
    tenancy: "none",
    replicated: false,
    reason:
      "no tenant column: a bucket is keyed by bucket_key alone. Not mirrored because it is a read-modify-write counter (one atomic upsert, plus peek) always on the primary and never a display or history listing (ADR-EA-024 decision 2), and because it is opt-in: created by RateLimiterStoreSql.migrate under its own ledger rather than by CoreMigrations, so a replica of a database without it must not copy it.",
  },
] as const;

type Declared = (typeof declared)[number];

/** The name of a core table. */
export type CoreTableName = Declared["name"];

/** One core table's classification. */
export interface CoreTable {
  readonly name: CoreTableName;
  /** A fixed marker: every table here is core's, a plugin's tables are declared by the plugin. */
  readonly owner: "core";
  readonly tenancy: Tenancy;
  /**
   * `LaggingReplica` (the test-side replica) mirrors this table's rows. It is NOT ADR-EA-024's
   * replica-eligible read set (only sessions and the audit log have an eventual read path): never
   * derive read routing from it.
   */
  readonly replicated: boolean;
  /** The columns of this table `Persistence.sql({ encryptPii: true })` seals: the `CoreSealedColumns` declarations themselves. */
  readonly sealed: ReadonlyArray<SealedColumn.Sweepable>;
  /** Why the table is not tenant-stamped or not replicated; present whenever either holds. */
  readonly reason?: string;
}

const deployedSealed = CoreSealedColumns.deployed({ encryptPii: true });

/** The eight core tables, in migration-creation order. */
export const tables: ReadonlyArray<CoreTable> = declared.map((entry): CoreTable => ({
  ...entry,
  owner: "core",
  sealed: deployedSealed.filter((column) => column.table === entry.name),
}));

/** Every core table name, in migration-creation order. */
export const names: ReadonlyArray<CoreTableName> = declared.map((entry) => entry.name);

/** The tables Postgres row-level security partitions on `"tenantId"`. */
export const partitionedTables: ReadonlyArray<
  Extract<Declared, { readonly tenancy: "partitioned" }>["name"]
> = declared.filter((entry) => entry.tenancy === "partitioned").map((entry) => entry.name);

/** The tables whose `"tenantId"` is a membership stamp resolved across tenants. */
export const directoryTables: ReadonlyArray<"users" | "accounts"> = declared
  .filter((entry) => entry.tenancy === "directory")
  .map((entry) => entry.name);

/** The tables carrying a `"tenantId"` column (every tenancy but `none`). */
export const stamped: ReadonlyArray<CoreTableName> = declared
  .filter((entry) => entry.tenancy !== "none")
  .map((entry) => entry.name);

/** The tables `LaggingReplica` mirrors; see `CoreTable.replicated` for what that does not mean. */
export const replicated: ReadonlyArray<CoreTableName> = declared
  .filter((entry) => entry.replicated)
  .map((entry) => entry.name);

/** Whether `name` is a core table carrying a `"tenantId"` column. */
export const isStamped = (name: string): boolean => stamped.some((table) => table === name);
