// @awthaq/sql — Persistence stratum (3)
//
// Models, SQL store adapters, migrations — database-neutral persistence (ADR-EA-004).
//
// Models.ts (spec/behaviors/05-persistence-stratum.md, BEH-EA-033/034):
// `makeModels(dialect)` builds the entities with the dialect's boolean/DateTime
// wire codec (TS-001). <X>StoreSql.ts (BEH-EA-035/036, plan 16): the SQL adapters of the
// core store ports of `@awthaq/ports` (users, accounts, sessions, verification
// tokens and reservations (ADR-EA-016), the audit log and the relay cursor), each
// owning its statements, its sealing hook, its tenant stamp and its dialect branches;
// CoreStoresSql.ts bundles them with `SqlTransaction.layerSql` (`Persistence.sql` is
// that function). CoreMigrations.ts: the core
// tables' forward-only migrations (BEH-EA-037). RateLimiterStoreSql.ts: an
// opt-in SQL rate-limit store. RelayCursorStoreSql.ts: the event relay's persisted position
// (plan 23). ReadRouting.ts: opt-in, default-off read-replica
// routing with per-read consistency classes and causal tokens (RRC-001,
// ADR-EA-024). TenantScope.ts: opt-in Postgres row-level security under the
// `"tenantId"` column and `withTenant` (DRS-001, ADR-EA-018). TenantScoped.ts, SealedColumn.ts and
// StoreFailure.ts (plus CoreSealedColumns.ts, core's six sealed columns declared on it, plan 17): the plugin-table substrate (plan 05): tenant scoping and the cross-tenant
// witness, sealed columns with lazy re-seal, and the `StoreUnavailable` mapping. See README.md for operations (drivers, pool configuration,
// migrations, encryption boundary, replicas).
// SqlDdl.ts: the dialect-specific DDL tokens as fragments, an always-IF-NOT-EXISTS index builder and
// `only` (plan 22, ADR-EA-004 rev 1.3), which a plugin's migrations are written with.
// See spec/overview.md for the full package map.

export * as AccountStoreSql from "./AccountStoreSql.ts";
export * as AuditLogStoreSql from "./AuditLogStoreSql.ts";
export * as CoreMigrations from "./CoreMigrations.ts";
export * as CoreSealedColumns from "./CoreSealedColumns.ts";
export * as CoreStoresSql from "./CoreStoresSql.ts";
export * as Models from "./Models.ts";
export * as RateLimiterStoreSql from "./RateLimiterStoreSql.ts";
export * as RelayCursorStoreSql from "./RelayCursorStoreSql.ts";
export * as ReadRouting from "./ReadRouting.ts";
export * as SealedColumn from "./SealedColumn.ts";
export * as SessionStoreSql from "./SessionStoreSql.ts";
export * as SqlDdl from "./SqlDdl.ts";
export * as SqlStore from "./SqlStore.ts";
export * as StoreFailure from "./StoreFailure.ts";
export * as TenantScope from "./TenantScope.ts";
export * as TenantScoped from "./TenantScoped.ts";
export * as UserStoreSql from "./UserStoreSql.ts";
export * as VerificationStoreSql from "./VerificationStoreSql.ts";
