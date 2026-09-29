// @awthaq/core — Domain stratum (4)
//
// Domain services, hook points, AuthEvents, config references, slots, the Auth namespace — the plugin contract and Auth.make composition live here.
//
// Implemented: AuthPlugin.ts (spec/behaviors/01-plugin-contract.md, BEH-EA-001-008),
// Auth.ts (spec/behaviors/02-plugin-composition-validate.md, BEH-EA-009-016, scoped as documented in Auth.ts's own header),
// Users.ts (spec/behaviors/06-domain-users-accounts.md, BEH-EA-041/042),
// Accounts.ts (spec/behaviors/06-domain-users-accounts.md, BEH-EA-043-045/047),
// Sessions.ts (spec/behaviors/07-sessions.md, BEH-EA-049-056),
// Verification.ts (spec/behaviors/08-verification-tokens.md, BEH-EA-057-064),
// AuthEvents.ts (spec/behaviors/13-events.md, BEH-EA-097-104),
// HookPoint.ts (spec/behaviors/12-hooks.md, BEH-EA-089-096, scoped as
// documented in that module's own header),
// RateLimits.ts (spec/behaviors/14-rate-limiting.md, BEH-EA-107/108/110/111 —
// the port half, `RateLimiter`, lives in `@awthaq/ports`),
// Slots.ts (spec/behaviors/03-ports-slots-hooks-registries.md, BEH-EA-017/019/021,
// scoped as documented in that module's own header — its `SlotConflict<P>`
// check is real but runtime, not the compile-time one BEH-EA-012 illustrates,
// a confirmed structural limit of `Context.Reference` in this effect
// version, not a scoping choice).
// `Users`/`Accounts`/`Sessions`/`Verification` each have both a `layerMemory`
// and a SQL-backed `layerSql` (over `@awthaq/sql`'s repositories,
// BEH-EA-033/034; `Verification.layerSql` per
// spec/decisions/016-verification-sql-claiming.md, ADR-EA-016).
// See spec/overview.md for the full package map.

export * as Accounts from "./Accounts.ts";
export * as Auth from "./Auth.ts";
export * as AuditChain from "./AuditChain.ts";
export * as AuditLog from "./AuditLog.ts";
export * as AuthEvents from "./AuthEvents.ts";
export * as AuthPlugin from "./AuthPlugin.ts";
export * as Errors from "./Errors.ts";
export * as HookPoint from "./HookPoint.ts";
export * as Hooks from "./Hooks.ts";
// MA-003: re-exported, not wrapped — see this file's own header comment
// for why a plugin author should import the httpapi contract classes from
// here rather than straight from `effect/unstable/httpapi/*`.
export * from "./HttpApiTypes.ts";
export * as MailDispatch from "./MailDispatch.ts";
export * as Migrations from "./Migrations.ts";
export * as RateLimits from "./RateLimits.ts";
export * as SessionCookie from "./SessionCookie.ts";
export * as Sessions from "./Sessions.ts";
export * as Slots from "./Slots.ts";
export * as Users from "./Users.ts";
export * as Verification from "./Verification.ts";
export * as VerificationLink from "./VerificationLink.ts";
