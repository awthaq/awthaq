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
  /**
   * APS-007/THS-003: how the session was authenticated (RFC 8176 `amr`),
   * copied from the session. A host MUST gate trust on this and
   * `emailVerified`, not on "has a session" — a fresh password sign-up holds a
   * session before its mailbox is verified.
   */
  amr: Schema.optional(Schema.Array(Schema.String)),
  /** APS-007: present only under the opt-in `PrincipalResolverWithUserFactsLive` (it costs one user lookup per request). */
  emailVerified: Schema.optional(Schema.Boolean),
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

/**
 * BEH-EA-165 (EEM-005): the session must be re-authenticated within
 * `maxAgeSeconds` before this operation may proceed — the client maps it to a
 * "confirm your password" prompt. A `Schema.TaggedError` (unlike a plain
 * `Data.TaggedError`) so it crosses the wire: a Path A endpoint whose policy
 * carries `reauth(...)` declares it in its `error:` array and a generated
 * `HttpApiClient` decodes it, telling a reauth demand (with its window) apart
 * from a plain permission denial. `@awthaq/qadi`'s `ObligationHandlers.reauth`
 * fails with this exact error.
 */
export class ReauthRequired extends Schema.TaggedError<ReauthRequired>()(
  "ReauthRequired",
  { maxAgeSeconds: Schema.Number },
  { httpApiStatus: 403 },
) {}

/** Narrows an unknown decoded error to `ReauthRequired` — the client's "confirm your password" branch. */
export const isReauthRequired = Schema.is(ReauthRequired);

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

/**
 * MNA-001 (decision ticket 17): the request header a native/bearer client sends
 * to opt in to bearer delivery on every session-minting response — the raw
 * token in the body's `token` field and no `Set-Cookie`. Absent (the browser
 * default) keeps cookie-only delivery, byte-for-byte unchanged; `bearer` is the
 * one recognised value.
 */
export const TOKEN_DELIVERY_HEADER = "x-awthaq-token-delivery";

/**
 * MNA-001: `TOKEN_DELIVERY_HEADER` carried a value other than `bearer`. Explicit
 * rather than a silent cookie fallback: a native client that typo'd the header
 * would otherwise be handed a `Set-Cookie` it can never read and a session it
 * cannot use. Raised before any session is minted.
 */
export class InvalidTokenDelivery extends Schema.TaggedError<InvalidTokenDelivery>()(
  "InvalidTokenDelivery",
  {},
  { httpApiStatus: 400 },
) {}

/** BEH-EA-065: cookie scheme keyed on `SESSION_COOKIE_NAME`. */
export const SessionCookie = HttpApiSecurity.apiKey({ key: SESSION_COOKIE_NAME, in: "cookie" });
/**
 * APS-006/BEH-EA-213: where `@awthaq/admin`'s `impersonate` delivers the
 * impersonation session in cookie mode — a name of its own, so the admin's
 * `__Host-session` is shadowed (not replaced) and restored by clearing this one.
 * `Sessions.IMPERSONATION_COOKIE_NAME` derives from this constant, as
 * `SESSION_COOKIE_NAME` does (CSS-007).
 */
export const IMPERSONATION_COOKIE_NAME = "__Host-impersonation";
export const ImpersonationCookie = HttpApiSecurity.apiKey({
  key: IMPERSONATION_COOKIE_NAME,
  in: "cookie",
});
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
 * matters). APS-006: `impersonation` is declared first of all, so an
 * impersonation cookie shadows the caller's own session cookie; its handler
 * only accepts a session carrying `actingAs` and otherwise falls through.
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
  security: { impersonation: ImpersonationCookie, cookie: SessionCookie, bearer: BearerToken },
}) {}

/** BEH-EA-030/076/079: a plain (non-security) middleware — CSRF is a request-property check, not a credential scheme. */
export class CsrfProtection extends HttpApiMiddleware.Service<CsrfProtection>()("CsrfProtection", {
  requiredForClient: true,
  error: CsrfRejected,
}) {}
