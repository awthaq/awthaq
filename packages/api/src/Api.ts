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
 * wire counterpart of `@awthaq/ports`' `RateLimiter.RateLimited` —
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
 * CSS-007: the one definition of the session cookie's name. `@awthaq/core`'s
 * `Sessions.SESSION_COOKIE_NAME` derives from this (core, stratum 4, may
 * depend on api, stratum 1), so the security scheme and the cookie every
 * issuance site sets can never drift apart.
 */
export const SESSION_COOKIE_NAME = "__Host-session";

/**
 * CSS-007/PIL-005: the response header a bearer client reads a rotated
 * session token from (`Sessions.verify`'s throttled touch, BEH-EA-052) —
 * one constant shared by the server that sets it and any client that
 * captures it.
 */
export const ROTATED_TOKEN_HEADER = "set-auth-token";

/** BEH-EA-065: cookie scheme keyed on `SESSION_COOKIE_NAME`. */
export const SessionCookie = HttpApiSecurity.apiKey({ key: SESSION_COOKIE_NAME, in: "cookie" });
export const BearerToken = HttpApiSecurity.bearer;

/** BEH-EA-080: the CSRF cookie/header names are fixed, never per-plugin configurable. */
export const CSRF_COOKIE_NAME = "__Host-csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const CsrfCookie = HttpApiSecurity.apiKey({ key: CSRF_COOKIE_NAME, in: "cookie" });

/**
 * BEH-EA-028/065/072: cookie is tried before bearer because it is declared
 * first — the *declaration's* `security` key order is the entire strategy
 * chain (NHS-010: Effect looks the Live handlers up by key, so the order of
 * the record `@awthaq/server` returns is irrelevant; only this declaration's
 * matters).
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("Authentication", {
  security: { cookie: SessionCookie, bearer: BearerToken },
  error: Unauthenticated,
}) {}

/**
 * BEH-EA-029/068: declares no error type (EHA-006) — it cannot fail with
 * `Unauthenticated`: `@awthaq/server`'s implementation resolves the cookie,
 * then the bearer credential, then defaults to `anonymousPrincipal` itself,
 * inside the first scheme's handler, so no failure ever escapes. Declaring
 * one would make the generated OpenAPI document advertise a 401 this
 * middleware can never produce. The two schemes stay declared so OpenAPI
 * still documents both credential inputs.
 */
export class OptionalAuthentication extends HttpApiMiddleware.Service<
  OptionalAuthentication,
  { provides: CurrentPrincipal }
>()("OptionalAuthentication", {
  security: { cookie: SessionCookie, bearer: BearerToken },
}) {}

/** BEH-EA-030/076/079: a plain (non-security) middleware — CSRF is a request-property check, not a credential scheme. */
export class CsrfProtection extends HttpApiMiddleware.Service<CsrfProtection>()("CsrfProtection", {
  requiredForClient: true,
  error: CsrfRejected,
}) {}
