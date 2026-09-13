// @awthaq/sql — Persistence stratum (3)
//
// Models, repositories, migration records, memory twins — database-neutral persistence (ADR-EA-004).
//
// Implemented: Models.ts (spec/behaviors/05-persistence-stratum.md, BEH-EA-033/034),
// Repositories.ts (BEH-EA-035/036) — consumed by @awthaq/core's
// Users.layerSql/Accounts.layerSql/Sessions.layerSql/Verification.layerSql,
// the last of these via VerificationReservationsRepository's atomic claim
// (spec/decisions/016-verification-sql-claiming.md, ADR-EA-016).
// Planned next: migration records/linker input (BEH-EA-037/038).
// See spec/overview.md for the full package map.

export * as CoreMigrations from "./CoreMigrations.ts";
export * as Models from "./Models.ts";
export * as Repositories from "./Repositories.ts";
