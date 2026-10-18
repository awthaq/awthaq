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
import { Authentication, Credentials } from "@awthaq/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { SubjectExtractionFailed, SubjectExtractor } from "@qadi/http";
import { SubjectResolver } from "./SubjectResolver.ts";

const BEARER_PREFIX = "bearer ";

type Scheme = "impersonation" | "cookie" | "apiKey" | "bearer";

/**
 * BEH-EA-065/072's own declaration order, replicated here since Path B runs
 * before any `HttpApiSecurity` scheme decodes anything: the impersonation
 * cookie (APS-006), the session cookie, the `x-api-key` header second
 * (OCM-002), the `Authorization` bearer header last. EVERY present carrier is
 * returned, in order: a credential that does not resolve falls through to the
 * next one exactly as Effect's security loop does on Path A (a stale cookie
 * beside a valid bearer is the bearer's subject, not anonymous).
 */
const presentedCredentials = (
  request: HttpServerRequest.HttpServerRequest,
  cfg: SessionCookie.SessionCookieConfigShape,
): ReadonlyArray<{ readonly scheme: Scheme; readonly credential: Redacted.Redacted<string> }> => {
  const found: Array<{ scheme: Scheme; credential: Redacted.Redacted<string> }> = [];
  const impersonation = request.cookies[SessionCookie.cookieName(cfg, "impersonation")];
  if (impersonation !== undefined && impersonation.length > 0) {
    found.push({ scheme: "impersonation", credential: Redacted.make(impersonation) });
  }
  const cookie = request.cookies[SessionCookie.cookieName(cfg)];
  if (cookie !== undefined && cookie.length > 0) {
    found.push({ scheme: "cookie", credential: Redacted.make(cookie) });
  }
  const apiKey = Headers.get(request.headers, Api.API_KEY_HEADER_NAME);
  if (Option.isSome(apiKey) && apiKey.value.trim().length > 0) {
    found.push({ scheme: "apiKey", credential: Redacted.make(apiKey.value.trim()) });
  }
  const header = Headers.get(request.headers, "authorization");
  if (Option.isSome(header) && header.value.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = header.value.slice(BEARER_PREFIX.length).trim();
    if (token.length > 0) found.push({ scheme: "bearer", credential: Redacted.make(token) });
  }
  return found;
};

/**
 * BEH-EA-153: an absent or invalid credential is `anonymousPrincipal` — only
 * `Api.Unauthenticated` (an unknown or expired session) is caught below and
 * mapped to it, the same uniform treatment `OptionalAuthenticationLive`'s
 * bearer handler relies on. NHS-002: `resolvePrincipal`'s own
 * `resolveSession` no longer collapses a genuinely broken store into
 * `Unauthenticated`. MA-004: that outage is the typed `StoreUnavailable`,
 * which this extractor reports as `@qadi/http`'s `SubjectExtractionFailed` —
 * the store-is-unreachable signal that error is reserved for — never as an
 * anonymous caller and never as a defect.
 */
export const SubjectExtractorLive: Layer.Layer<
  SubjectExtractor,
  never,
  Sessions.Sessions | Credentials.PrincipalResolver
> = Layer.effect(
  SubjectExtractor,
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const principalResolver = yield* Credentials.PrincipalResolver;
    const subjectResolver = yield* SubjectResolver;
    /** One carrier; APS-006: an impersonation cookie counts only for a session carrying `actingAs`, judged on the session. */
    const resolveOne = (candidate: {
      readonly scheme: Scheme;
      readonly credential: Redacted.Redacted<string>;
    }) =>
      candidate.scheme === "impersonation"
        ? Authentication.resolveSession(sessions, candidate.credential, "impersonation").pipe(
            Effect.filterOrFail(
              ({ session }) => Option.isSome(session.actingAs),
              () => new Api.Unauthenticated(),
            ),
            Effect.flatMap(({ session }) => principalResolver.resolve(session)),
          )
        : // PIL-005: `scheme` tells a rotating `verify` how to deliver the new secret.
          Authentication.resolvePrincipal(
            sessions,
            principalResolver,
            candidate.credential,
            candidate.scheme,
          );
    return {
      extract: (request) =>
        Effect.gen(function* () {
          // IC-007: the configured cookie names.
          const cfg = yield* SessionCookie.SessionCookieConfig;
          const principal = yield* presentedCredentials(request, cfg)
            .reduce<
              Effect.Effect<
                Api.Principal,
                Api.Unauthenticated | Api.StoreUnavailable,
                HttpServerRequest.HttpServerRequest
              >
            >(
              (previous, candidate) =>
                previous.pipe(Effect.catchTag("Unauthenticated", () => resolveOne(candidate))),
              Effect.fail(new Api.Unauthenticated()),
            )
            .pipe(
              // Ticket 03: `resolvePrincipal` reads the ambient `HttpServerRequest` to key its per-request
              // verify memoization; `extract` received it as a plain parameter, so it is provided here.
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
              Effect.catchTag("Unauthenticated", () => Effect.succeed(Api.anonymousPrincipal)),
            );
          return yield* subjectResolver.resolve(principal);
        }).pipe(
          Effect.catchTag("StoreUnavailable", (error) =>
            Effect.fail(
              new SubjectExtractionFailed({
                reason: `awthaq: session store unavailable (${error.operation})`,
              }),
            ),
          ),
        ),
    };
  }),
);
