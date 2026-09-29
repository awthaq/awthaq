// @awthaq/api — Contract stratum (1)
//
// spec/behaviors/04-contract-stratum.md, BEH-EA-025 (Principal), BEH-EA-027
// (contract errors), BEH-EA-028/029/030 (Authentication/OptionalAuthentication/
// CsrfProtection middleware *declarations*). This package is isomorphic (no
// server code) — the real resolution logic these declarations name is built
// against them in `@awthaq/server`'s Authentication.ts/Csrf.ts, which
// depends on `@awthaq/core`; this package deliberately does not.

import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

/** BEH-EA-025: "who is asking," independent of what they may do (qadi's job). */
export class PrincipalRef extends Schema.Class<PrincipalRef>("PrincipalRef")({
  type: Schema.String,
  id: Schema.String,
}) {}

export class UserPrincipal extends Schema.TaggedClass<UserPrincipal>()("User", {
  ref: PrincipalRef,
  sessionId: Schema.String,
  actingAs: Schema.optional(PrincipalRef),
}) {}

export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
  ref: PrincipalRef,
}) {}

export class ServicePrincipal extends Schema.TaggedClass<ServicePrincipal>()("Service", {
  ref: PrincipalRef,
}) {}

export class AnonymousPrincipal extends Schema.TaggedClass<AnonymousPrincipal>()("Anonymous", {
  ref: PrincipalRef,
}) {}

export const Principal = Schema.Union([
  UserPrincipal,
  ApiKeyPrincipal,
  ServicePrincipal,
  AnonymousPrincipal,
]);
export type Principal = typeof Principal.Type;

/** The one, shared `AnonymousPrincipal` value BEH-EA-029/068 resolve to. */
export const anonymousPrincipal = new AnonymousPrincipal({
  ref: new PrincipalRef({ type: "anonymous", id: "anonymous" }),
});

/**
 * BEH-EA-070: provided only by `Authentication`/`OptionalAuthentication`'s own
 * middleware Layer — a required `Context.Service` (no default value), so a
 * handler under neither cannot read it at all, not even as an accident of a
 * permissive default.
 */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "awthaq/api/CurrentPrincipal",
) {}

/** BEH-EA-027/067: no scheme resolved a live session. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
  { httpApiStatus: 401 },
) {}

/** BEH-EA-078: any of `CsrfProtection`'s checks failed. */
export class CsrfRejected extends Schema.TaggedError<CsrfRejected>()(
  "CsrfRejected",
  {},
  { httpApiStatus: 403 },
) {}

/** BEH-EA-027: identical whether the submitted credential's target account exists or not. */
export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * Shipping-gap map (.scratch/shipping-gaps), ticket 12. BEH-EA-106: the
 * wire counterpart of `@awthaq/ports`' `RateLimiter.RateLimitExceeded` —
 * `retryAfterMillis` carried as a typed field (not folded into a message
 * string) so a client can render "try again in n seconds" without parsing
 * text. Declared here, not per-plugin, since every rate-limited endpoint
 * across every plugin answers with this same shape.
 */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfterMillis: Schema.Number },
  { httpApiStatus: 429 },
) {}

/**
 * BEH-EA-065: cookie name matches `@awthaq/core`'s `Sessions.SESSION_COOKIE_NAME`
 * exactly (`api` cannot import `core`, so the literal is repeated here rather
 * than shared — both are `"__Host-session"` by construction, not by convention).
 */
export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
/**
 * APS-006/BEH-EA-213: where `@awthaq/admin`'s `impersonate` delivers the
 * impersonation session in cookie mode — a name of its own, so the admin's
 * `__Host-session` is shadowed (not replaced) and restored by clearing this one.
 * Literal repeated from `Sessions.IMPERSONATION_COOKIE_NAME` for the same
 * `api`-cannot-import-`core` reason as `SessionCookie` above.
 */
export const ImpersonationCookie = HttpApiSecurity.apiKey({
  key: "__Host-impersonation",
  in: "cookie",
});
export const BearerToken = HttpApiSecurity.bearer;

/** BEH-EA-080: the CSRF cookie/header names are fixed, never per-plugin configurable. */
export const CSRF_COOKIE_NAME = "__Host-csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const CsrfCookie = HttpApiSecurity.apiKey({ key: CSRF_COOKIE_NAME, in: "cookie" });

/**
 * BEH-EA-028/065/072: cookie is tried before bearer because it is declared
 * first — the record's own key order is the entire strategy chain. APS-006:
 * `impersonation` is declared first of all, so an impersonation cookie shadows
 * the caller's own session cookie; its handler only accepts a session carrying
 * `actingAs` and otherwise falls through.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("Authentication", {
  security: { impersonation: ImpersonationCookie, cookie: SessionCookie, bearer: BearerToken },
  error: Unauthenticated,
}) {}

/**
 * AR-003/BEH-EA-071: the authentication scheme of the admin tier — every group whose id
 * has an `admin` segment (`AuthPlugin.isAdminTier`) is declared behind this instead of
 * `Authentication`. Same security record, same error, same `CurrentPrincipal`, so
 * `@awthaq/server`'s default `AdminAuthenticationLive` simply delegates to
 * `Authentication` and a co-hosted deployment behaves exactly as before. A host that
 * runs the admin surface on its own listener swaps the layer (mTLS, a service
 * principal, an internal SSO) without forking any contract: an override implements the
 * same three handlers however it likes — e.g. `bearer` resolving a client-certificate
 * identity — and still provides `CurrentPrincipal`.
 */
export class AdminAuthentication extends HttpApiMiddleware.Service<
  AdminAuthentication,
  { provides: CurrentPrincipal }
>()("AdminAuthentication", {
  security: { impersonation: ImpersonationCookie, cookie: SessionCookie, bearer: BearerToken },
  error: Unauthenticated,
}) {}

/**
 * BEH-EA-029/068: declares the same `Unauthenticated` error `Authentication`
 * does — not because it can actually reach a caller (its own `@awthaq/server`
 * implementation always resolves `CurrentPrincipal`, defaulting to
 * `anonymousPrincipal`, never letting a failure escape the middleware) but
 * because the underlying per-scheme handler shape requires every entry in
 * one `security` record to share one declared error type, and cookie's
 * handler must still be able to fail *internally* to fall through to bearer
 * (BEH-EA-065/072's declaration-order chain), which only bearer's handler
 * then catches.
 */
export class OptionalAuthentication extends HttpApiMiddleware.Service<
  OptionalAuthentication,
  { provides: CurrentPrincipal }
>()("OptionalAuthentication", {
  security: { impersonation: ImpersonationCookie, cookie: SessionCookie, bearer: BearerToken },
  error: Unauthenticated,
}) {}

/** BEH-EA-030/076/079: a plain (non-security) middleware — CSRF is a request-property check, not a credential scheme. */
export class CsrfProtection extends HttpApiMiddleware.Service<CsrfProtection>()("CsrfProtection", {
  requiredForClient: true,
  error: CsrfRejected,
}) {}
