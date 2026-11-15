// @awthaq/server — Credentials
//
// ADR-EA-042: the one place a request's credentials are read, ordered, resolved to a principal, admitted by a
// tier and (on a rotating verify) handed to a delivery sink. Path A (`Authentication.ts`), Path B
// (`@awthaq/qadi`'s `SubjectExtractor`) and the web adapter (`@awthaq/web`'s `getSession`) are adapters over it.
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
//
// "Which credential on this request names the caller, and what is it allowed to be" is one policy:
// 1. the impersonation cookie, counted only when its session carries `actingAs` (APS-006);
// 2. the session cookie (its name comes from `SessionCookieConfig`, IC-007);
// 3. `x-api-key`, on the machine tier only (OCM-002);
// 4. `Authorization: Bearer`, offered to the claimed-credential registry first and to `Sessions` otherwise (MAPS-001);
// 5. a credential that does not resolve falls through to the next one; a store outage stops the chain (MA-004);
// 6. the tier admits only some principals (the user tier only `User`, BEH-EA-066);
// 7. a rotated session secret is delivered back the way it came (PIL-005).
//
// The members live under `./internal/`, one module per concern; this file only names them.

export {
  PrincipalResolver,
  PrincipalResolverLive,
  PrincipalResolverWithUserFactsLive,
} from "./internal/PrincipalResolver.ts";
export type { PrincipalResolverShape } from "./internal/PrincipalResolver.ts";

export {
  contribute,
  CredentialResolvers,
  CredentialResolversFrozen,
  CredentialResolversLive,
  DuplicateCredentialResolver,
} from "./internal/CredentialResolvers.ts";
export type {
  ClaimCarrier,
  CredentialResolverContribution,
  CredentialResolversShape,
} from "./internal/CredentialResolvers.ts";

export {
  fromRequest,
  machineTier,
  optionalTier,
  presented,
  tier,
  userTier,
} from "./internal/Presented.ts";
export type { Carrier, Presented, SessionCarrier, Source, Tier } from "./internal/Presented.ts";

export { make, principalFields } from "./internal/Resolution.ts";
export type { Resolved, Rotation, Scope } from "./internal/Resolution.ts";

export { collecting, httpScope } from "./internal/Scopes.ts";
