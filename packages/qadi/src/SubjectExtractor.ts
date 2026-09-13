// @effect-auth/qadi — SubjectExtractor (Path B adapter)
//
// spec/behaviors/20-qadi-bridge-path-b.md, BEH-EA-153.
//
// `@qadi/http` already ships the `SubjectExtractor` interface and the
// `RequirePermission` middleware built on it (BEH-EA-154 through 160 are all
// qadi's own exports — `RequiredPermission`/`PublicEndpoint` annotations,
// `requiresPermission`/`publicEndpoint`, the 403/502/500 status mapping,
// `registerApi`/`permissionRegistryRoute` — nothing effect-auth-specific to
// build for those). What effect-auth owns is the one *implementation* of
// that interface: running effect-auth's own session resolution directly
// against the raw request, independent of `Authentication`'s middleware
// pipeline (so qadi's `RequirePermission` can run before any effect-auth
// contract middleware does), while reusing — not reimplementing —
// `Authentication`'s own `resolvePrincipal` (the identical hash-comparison
// and absolute/idle-expiry logic over `Sessions`, per BEH-EA-153's own text).
import { Api } from "@effect-auth/api";
import { Sessions } from "@effect-auth/core";
import { Authentication } from "@effect-auth/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Headers from "effect/unstable/http/Headers";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
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
): Redacted.Redacted<string> => {
  const cookie = request.cookies[Sessions.SESSION_COOKIE_NAME];
  if (cookie !== undefined && cookie.length > 0) {
    return Redacted.make(cookie);
  }
  const header = Headers.get(request.headers, "authorization");
  if (Option.isSome(header) && header.value.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = header.value.slice(BEARER_PREFIX.length).trim();
    if (token.length > 0) return Redacted.make(token);
  }
  return Redacted.make("");
};

/**
 * BEH-EA-153: an absent or invalid credential is `anonymousPrincipal` —
 * `resolvePrincipal` already collapses every failure (an unknown session, an
 * expired one, even a lookup `PlatformError`) into `Api.Unauthenticated`,
 * the same uniform treatment `OptionalAuthenticationLive`'s bearer handler
 * relies on — never `SubjectExtractionFailed`, which is reserved for a
 * genuinely broken store (`@qadi/http`'s own `SubjectExtractionFailed` doc
 * comment), a distinction this effect-auth-backed extractor has no way to
 * observe yet: `Sessions`/`Users` report typed domain errors, not a
 * store-is-unreachable signal distinct from "no such session."
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
          const credential = extractCredential(request);
          const principal = yield* Authentication.resolvePrincipal(
            sessions,
            principalResolver,
            credential,
          ).pipe(Effect.catchTag("Unauthenticated", () => Effect.succeed(Api.anonymousPrincipal)));
          return yield* subjectResolver.resolve(principal);
        }),
    };
  }),
);
