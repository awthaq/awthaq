// @awthaq/server — HTTP stratum (5)
//
// Middleware implementations, core handlers, AuthHttp — the mechanism that registers a composed HttpApi with a router.
//
// Implemented: Credentials.ts (the one credential-resolution module, ADR-EA-042; the principal resolver and
// the claimed-credential registry live here), Authentication.ts (spec/behaviors/09-authentication-middleware.md,
// BEH-EA-065-072; the Path A adapter over Credentials),
// Csrf.ts (spec/behaviors/10-csrf.md, BEH-EA-073-080), Session.ts (core session-group
// handlers, BEH-EA-031), AuthHttp.ts (spec/behaviors/11-http-error-mapping.md, BEH-EA-083/084),
// BodyLimit.ts (the default request-body cap, NHS-004 / BEH-EA-085),
// RequestContext.ts (the per-request correlation id / client address for events, ALF-006),
// SessionLifecycle.ts (the server half of the contract's session-lifecycle markers, ADR-EA-045).
// See spec/overview.md for the full package map.

export * as Account from "./Account.ts";
export * as Authentication from "./Authentication.ts";
export * as AuthHost from "./AuthHost.ts";
export * as AuthHttp from "./AuthHttp.ts";
export * as BodyLimit from "./BodyLimit.ts";
export * as Credentials from "./Credentials.ts";
export * as Csrf from "./Csrf.ts";
export * as RequestContext from "./RequestContext.ts";
export * as SecurityHeaders from "./SecurityHeaders.ts";
export * as Session from "./Session.ts";
export * as SessionDelivery from "./SessionDelivery.ts";
export * as SessionLifecycle from "./SessionLifecycle.ts";
