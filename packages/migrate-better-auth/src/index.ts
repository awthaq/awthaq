// @awthaq/migrate-better-auth
//
// BAM-003 (.issues/high): a real, opt-in adapter bridging still-live
// better-auth sessions into freshly minted awthaq sessions during a
// cutover — see this package's own README for the full rollout sequence.
// A deployment that never installs this package gets forced re-login on
// cutover, the explicit, versioned default `@awthaq/ports`'s own
// `LegacySessionBridge` no-op establishes.

export * as AliasLegacyCookieMiddleware from "./AliasLegacyCookieMiddleware.ts";
export * as LegacySessionBridgeLive from "./LegacySessionBridgeLive.ts";
