// @awthaq/migrate-better-auth
//
// BAM-003 (.issues/high): a real, opt-in adapter bridging still-live
// better-auth sessions into freshly minted awthaq sessions during a
// cutover — see this package's own README for the full rollout sequence.
// A deployment that never installs this package gets forced re-login on
// cutover, the explicit, versioned default `@awthaq/ports`'s own
// `LegacySessionBridge` no-op establishes.
//
// BAM-004: `BetterAuthScryptVerifier` lets imported better-auth password
// users sign in with their existing password (rehashed on first login).
//
// BAM-001: `BetterAuthSource` reads a better-auth database and maps its users and
// accounts onto `@awthaq/core`'s `UserImport` shape, reporting what has no
// destination — the adapter behind `awthaq import --from better-auth`.

export * as AliasLegacyCookieMiddleware from "./AliasLegacyCookieMiddleware.ts";
export * as BetterAuthScryptVerifier from "./BetterAuthScryptVerifier.ts";
export * as BetterAuthSource from "./BetterAuthSource.ts";
export * as LegacySessionBridgeLive from "./LegacySessionBridgeLive.ts";
