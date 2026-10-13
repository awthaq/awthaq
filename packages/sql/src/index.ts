// @awthaq/sql — Persistence stratum (3)
//
// Models, repositories, migrations — database-neutral persistence (ADR-EA-004).
//
// Models.ts (spec/behaviors/05-persistence-stratum.md, BEH-EA-033/034):
// `makeModels(dialect)` builds the entities with the dialect's boolean/DateTime
// wire codec (TS-001). Repositories.ts (BEH-EA-035/036): users, accounts,
// sessions, verification tokens/reservations (ADR-EA-016) and the audit log,
// consumed by @awthaq/core's `layerSql` services. CoreMigrations.ts: the core
// tables' forward-only migrations (BEH-EA-037). RateLimiterStoreSql.ts: an
// opt-in SQL rate-limit store. ReadRouting.ts: opt-in, default-off read-replica
// routing with per-read consistency classes and causal tokens (RRC-001,
// ADR-EA-024). TenantScope.ts: opt-in Postgres row-level security under the
// `"tenantId"` column and `withTenant` (DRS-001, ADR-EA-018). TenantScoped.ts, SealedColumn.ts and
// StoreFailure.ts: the plugin-table substrate (plan 05): tenant scoping and the cross-tenant
// witness, sealed columns with lazy re-seal, and the `StoreUnavailable` mapping. See README.md for operations (drivers, pool configuration,
// migrations, encryption boundary, replicas).
// See spec/overview.md for the full package map.

export * as AccountStoreSql from "./AccountStoreSql.ts";
export * as AuditLogStoreSql from "./AuditLogStoreSql.ts";
export * as CoreMigrations from "./CoreMigrations.ts";
export * as Models from "./Models.ts";
export * as RateLimiterStoreSql from "./RateLimiterStoreSql.ts";
export * as ReadRouting from "./ReadRouting.ts";
export * as Repositories from "./Repositories.ts";
export * as SealedColumn from "./SealedColumn.ts";
export * as SqlStore from "./SqlStore.ts";
export * as StoreFailure from "./StoreFailure.ts";
export * as TenantScope from "./TenantScope.ts";
export * as TenantScoped from "./TenantScoped.ts";
export * as UserStoreSql from "./UserStoreSql.ts";
export * as VerificationStoreSql from "./VerificationStoreSql.ts";
