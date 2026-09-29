// @awthaq/qadi — SubjectExtractor (Path B adapter)
//
// spec/behaviors/20-qadi-bridge-path-b.md, BEH-EA-153.
//
// `@qadi/http` already ships the `SubjectExtractor` interface and the
// `RequirePermission` middleware built on it (BEH-EA-154 through 160 are all
// qadi's own exports — `RequiredPermission`/`PublicEndpoint` annotations,
// `requiresPermission`/`publicEndpoint`, the 403/502/500 status mapping,
// `registerApi`/`permissionRegistryRoute` — nothing awthaq-specific to
// build for those). What awthaq owns is the one *implementation* of
// that interface: running awthaq's own session resolution directly
// against the raw request, independent of `Authentication`'s middleware
// pipeline (so qadi's `RequirePermission` can run before any awthaq
// contract middleware does), while reusing — not reimplementing —
// `Authentication`'s own `resolvePrincipal` (the identical hash-comparison
// and absolute/idle-expiry logic over `Sessions`, per BEH-EA-153's own text).
import { Api } from "@awthaq/api";
import { SessionCookie, Sessions } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { SubjectExtractor } from "@qadi/http";
import { SubjectResolver } from "./SubjectResolver.ts";

const BEARER_PREFIX = "bearer ";

/**
 * BEH-EA-065/072's own declaration order, replicated here since Path B runs
 * before any `HttpApiSecurity` scheme decodes anything: the session cookie
 * is tried first, the `Authorization` bearer header second. Matched
 * case-insensitively and trimmed, the same robustness `@qadi/http`'s own
 * `subjectExtractorBearer` documents for exactly this scheme.
 */
const extractCredential = (
  request: HttpServerRequest.HttpServerRequest,
  cookieName: string,
): { readonly scheme: "cookie" | "bearer"; readonly credential: Redacted.Redacted<string> } => {
  const cookie = request.cookies[cookieName];
  if (cookie !== undefined && cookie.length > 0) {
    return { scheme: "cookie", credential: Redacted.make(cookie) };
  }
  const header = Headers.get(request.headers, "authorization");
  if (Option.isSome(header) && header.value.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = header.value.slice(BEARER_PREFIX.length).trim();
    if (token.length > 0) return { scheme: "bearer", credential: Redacted.make(token) };
  }
  return { scheme: "bearer", credential: Redacted.make("") };
};

/**
 * BEH-EA-153: an absent or invalid credential is `anonymousPrincipal` — only
 * `Api.Unauthenticated` (an unknown or expired session) is caught below and
 * mapped to it, the same uniform treatment `OptionalAuthenticationLive`'s
 * bearer handler relies on. NHS-002: `resolvePrincipal`'s own
 * `resolveSession` no longer collapses a genuinely broken store into
 * `Unauthenticated` — a lookup `PlatformError` is `Effect.orDie`d into a
 * defect there, so it propagates through here uncaught rather than being
 * silently reported as an anonymous caller, giving this extractor the
 * store-is-unreachable distinction `@qadi/http`'s own
 * `SubjectExtractionFailed` is reserved for, without this module needing to
 * construct that error itself.
 */
export const SubjectExtractorLive: Layer.Layer<
  SubjectExtractor,
  never,
  Sessions.Sessions | Authentication.PrincipalResolver
> = Layer.effect(
  SubjectExtractor,
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const principalResolver = yield* Authentication.PrincipalResolver;
    const subjectResolver = yield* SubjectResolver;
    return {
      extract: (request) =>
        Effect.gen(function* () {
          // IC-007: the configured session-cookie name (default `__Host-session`).
          const cookieName = SessionCookie.cookieName(yield* SessionCookie.SessionCookieConfig);
          const { scheme, credential } = extractCredential(request, cookieName);
          // PIL-005: `scheme` tells a rotating `verify` how to deliver the
          // new secret — `resolveSession` registers that delivery on the
          // request itself, so a Path-B-only route still rotates cleanly.
          const principal = yield* Authentication.resolvePrincipal(
            sessions,
            principalResolver,
            credential,
            scheme,
          ).pipe(
            // Ticket 03: `resolvePrincipal` reads the ambient
            // `HttpServerRequest` to key its per-request verify memoization
            // — `extract` already received it as a plain parameter (Path B
            // runs independent of the router's own middleware chain, per
            // this module's own header comment), so it's provided here
            // explicitly rather than assumed already in context.
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.catchTag("Unauthenticated", () => Effect.succeed(Api.anonymousPrincipal)),
          );
          return yield* subjectResolver.resolve(principal);
        }),
    };
  }),
);
