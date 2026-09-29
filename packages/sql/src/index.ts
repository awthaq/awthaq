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
// ADR-EA-024). See README.md for operations (drivers, pool configuration,
// migrations, encryption boundary, replicas).
// See spec/overview.md for the full package map.

export * as CoreMigrations from "./CoreMigrations.ts";
export * as Models from "./Models.ts";
export * as RateLimiterStoreSql from "./RateLimiterStoreSql.ts";
export * as ReadRouting from "./ReadRouting.ts";
export * as Repositories from "./Repositories.ts";
