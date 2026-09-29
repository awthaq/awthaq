// @awthaq/server — Authentication middleware
//
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
// Implements the `Authentication`/`OptionalAuthentication` declarations from
// `@awthaq/api`'s `Api.ts` against `@awthaq/core`'s `Sessions`.

import { Sessions } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { unhandled } from "effect/Types";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * BEH-EA-069: derives a `Principal` from a resolved `Session` alone, with no
 * authorization decision (that is qadi's `SubjectResolver`'s job, downstream)
 * — its own service so a deployment may override how a session maps to a
 * principal without touching `Authentication` itself.
 */
export interface PrincipalResolverShape {
  readonly resolve: (session: Sessions.SessionView) => Effect.Effect<Api.Principal>;
}

export class PrincipalResolver extends Context.Service<PrincipalResolver, PrincipalResolverShape>()(
  "awthaq/server/PrincipalResolver",
) {}

/**
 * The ordinary case: a session resolves to the `UserPrincipal` it belongs to.
 * BEH-EA-211: a session's own `actingAs` (BEH-EA-209/210) is placed onto the
 * resolved `UserPrincipal` unconditionally, closing the loop BEH-EA-142
 * (`@awthaq/qadi`'s `SubjectResolver`) already anticipates — omitted
 * entirely, not `undefined`, when the session carries none
 * (`exactOptionalPropertyTypes`).
 */
export const PrincipalResolverLive: Layer.Layer<PrincipalResolver> = Layer.succeed(
  PrincipalResolver,
  {
    resolve: (session) =>
      Effect.succeed(
        new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: session.userId }),
          sessionId: session.id,
          ...(Option.isSome(session.actingAs)
            ? {
                actingAs: new Api.PrincipalRef({
                  type: session.actingAs.value.type,
                  id: session.actingAs.value.id,
                }),
              }
            : {}),
        }),
      ),
  },
);

/**
 * `.scratch/jwt/spec.md`'s "Automatic response mirroring" decision (and
 * `.scratch/jwt/issues/02-mint-delivery-mechanism.md`'s own resolution): a
 * second overridable slot, mirroring `PrincipalResolver` immediately
 * above — an application/plugin may decorate the response of any
 * successfully-authenticated request, without this middleware knowing or
 * caring who's listening. Defaults to a true identity no-op, so installing
 * a plugin that never overrides this reference (i.e. every plugin except
 * `@awthaq/jwt` today) changes nothing about existing behavior.
 * `decorate`'s own type — `Effect.Effect<HttpServerResponse>`, no error
 * channel — forces any override to handle its own failures internally
 * (e.g. minting a JWT must never be able to fail an otherwise-successful
 * response); this middleware never adds its own recovery for it.
 */
export interface PostAuthResponseHookShape {
  /**
   * PDR-003: `context.scheme` names the credential that authenticated the
   * request, so a hook can treat a cookie-authenticated browser request
   * differently from a bearer-authenticated API client (e.g. `@awthaq/jwt`'s
   * `mirrorResponses: "bearer"`).
   */
  readonly decorate: (
    principal: Api.Principal,
    response: HttpServerResponse.HttpServerResponse,
    context: { readonly scheme: "cookie" | "bearer" },
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

export const PostAuthResponseHook = Context.Reference<PostAuthResponseHookShape>(
  "awthaq/server/PostAuthResponseHook",
  { defaultValue: () => ({ decorate: (_principal, response) => Effect.succeed(response) }) },
);

/** What a resolved session carries once verified — including whether `verify` rotated its secret this call. */
export interface ResolvedSession {
  readonly session: Sessions.SessionView;
  readonly rotated: Option.Option<Redacted.Redacted<string>>;
}

/**
 * Upstream-hardening-followups ticket 03: `Api.Authentication`'s own
 * middleware and `@awthaq/qadi`'s `SubjectExtractorLive` (Path B) both
 * funnel through `resolveSession` below, independently, on the same
 * request — `SubjectExtractorLive`'s own doc comment explains why it
 * can't just call through `Api.Authentication`'s middleware instead. Once
 * ticket 01 made `Sessions.verify` rotate the session secret on a
 * throttled touch, a second call within the same request — against the
 * credential the first call already rotated away from — would fail
 * `SessionNotFound` instead of the harmless no-op it was before rotation
 * existed.
 *
 * Keyed by the ambient `HttpServerRequest`'s own identity, not a new
 * per-request service: Effect v4 has no `FiberRef` (everything moved to
 * `Context.Reference`, whose own `defaultValue()` is memoized once,
 * globally, on the reference itself — unsuitable for per-request state
 * without a new middleware explicitly re-providing it every request,
 * ahead of both bridges, which is exactly the ordering problem this
 * ticket exists to route around). `HttpServerRequest` is already the one
 * thing both bridges have ambient access to, is provided once per
 * request by the router (confirmed via `effect`'s own `HttpRouter.ts`/
 * `HttpApiBuilder.ts`), and is mutated in place rather than replaced
 * (`@qadi/http`'s own `RequirePermission.ts` writes `request.payload`
 * directly) — so its identity is stable for a request's whole lifetime
 * and naturally garbage-collected once that request completes, with no
 * explicit cleanup this module has to perform.
 */
const sessionResolutionCache = new WeakMap<
  HttpServerRequest.HttpServerRequest,
  Ref.Ref<HashMap.HashMap<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>>
>();

/** The current request's cache `Ref`, creating and registering an empty one on first access. */
const perRequestCache = (request: HttpServerRequest.HttpServerRequest) =>
  Option.fromNullishOr(sessionResolutionCache.get(request)).pipe(
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Ref.make(HashMap.empty<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>()).pipe(
          Effect.tap((ref) => Effect.sync(() => sessionResolutionCache.set(request, ref))),
        ),
    }),
  );

/**
 * BEH-EA-069/070: shared by both `Authentication` and `OptionalAuthentication`
 * — an empty credential (BEH-EA-065's cookie/bearer schemes decode to `""`
 * when the request carries neither, never a decode failure) and an invalid
 * or expired session are both reported as `Unauthenticated`, uniformly.
 *
 * Upstream-hardening ticket 01: exposes `rotated` alongside the resolved
 * `session` so a caller that owns an actual HTTP response (this module's
 * own `AuthenticationLive`/`OptionalAuthenticationLive`) can deliver a
 * rotated token; `resolvePrincipal` below is the principal-only wrapper
 * for callers that don't.
 *
 * Ticket 03: memoized per request (see `sessionResolutionCache` above),
 * keyed on the raw presented credential — a second call in the same
 * request with the identical credential reuses the first call's outcome
 * (`Effect.cached` memoizes the `Exit`, so a failure is reused exactly
 * like a success) rather than hitting `Sessions.verify` again.
 */
export const resolveSession = (
  sessions: Sessions.SessionsShape,
  credential: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const cache = yield* perRequestCache(request);
    const raw = Redacted.value(credential);
    const existing = HashMap.get(yield* Ref.get(cache), raw);
    if (Option.isSome(existing)) {
      return yield* existing.value;
    }
    // NHS-002/EEM-003: `verify`'s three failure tags used to collapse
    // uniformly to `Unauthenticated` via a blanket `Effect.mapError` — a
    // backing-store outage (`PlatformError`) answered 401 on every
    // request, indistinguishable from a bad credential, RFC-inverted (401
    // claims the credential is wrong, not that the server is broken), and
    // invisible to status-code-keyed alerting. `PlatformError` alone dies
    // (this codebase's own established idiom, e.g. `Password.ts`/
    // `OAuth.ts`'s identical `Effect.catchTag("PlatformError", Effect.die)`)
    // — a real infrastructure fault, reported as a server error by the
    // framework's own default defect handling instead. Only what's left
    // after that (`SessionNotFound`/`SessionExpired`, a genuinely absent or
    // expired session) maps to `Unauthenticated`; ordering matters here —
    // `catchTag` must run before `mapError`, or the die would itself get
    // mapped away.
    const memoized = yield* Effect.cached(
      raw === ""
        ? Effect.fail(new Api.Unauthenticated())
        : sessions.verify(Redacted.make(raw)).pipe(
            Effect.catchTag("PlatformError", Effect.die),
            Effect.mapError(() => new Api.Unauthenticated()),
          ),
    );
    yield* Ref.update(cache, HashMap.set(raw, memoized));
    return yield* memoized;
  });

/**
 * Exported (not module-private) so `@awthaq/qadi`'s `SubjectExtractor.ts`
 * (BEH-EA-153) can call the identical hash-comparison/expiry logic this
 * middleware uses, rather than reimplementing it against the raw request —
 * BEH-EA-153 requires exactly that reuse. Discards `rotated`: a caller with
 * no response to deliver a rotated token through has nowhere to put it.
 */
export const resolvePrincipal = (
  sessions: Sessions.SessionsShape,
  resolver: PrincipalResolverShape,
  credential: Redacted.Redacted<string>,
) =>
  resolveSession(sessions, credential).pipe(
    Effect.flatMap(({ session }) => resolver.resolve(session)),
  );

/**
 * Upstream-hardening ticket 01: `set-auth-token` alone would never rotate
 * anything for a browser — only `Set-Cookie` updates a browser's own
 * cookie jar. Delivery therefore splits by how the request authenticated:
 * `cookie` gets the same `Set-Cookie` write `OAuth.ts` already uses after
 * `issue`; `bearer` gets a `set-auth-token` response header, upstream's
 * own mechanism and the only way a bearer client (presenting the raw
 * secret directly, not through a plugin like `@awthaq/jwt`) can learn its
 * token rotated. A no-op when `verify` didn't rotate this call.
 */
const deliverRotation = (
  scheme: "cookie" | "bearer",
  rotated: Option.Option<Redacted.Redacted<string>>,
  response: HttpServerResponse.HttpServerResponse,
) => {
  if (Option.isNone(rotated)) {
    return Effect.succeed(response);
  }
  const token = Redacted.value(rotated.value);
  return scheme === "cookie"
    ? HttpServerResponse.setCookie(
        response,
        Sessions.SESSION_COOKIE_NAME,
        token,
        Sessions.SESSION_COOKIE_ATTRIBUTES,
      ).pipe(Effect.orDie)
    : Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
};

/**
 * BEH-EA-065 through 067/070: fails `Unauthenticated` only once every
 * declared scheme has. Ticket 01: `cookie` and `bearer` each resolve
 * through the shared `resolveSession`/`resolver.resolve` core, then apply
 * their own rotation-delivery step (`deliverRotation`) — no longer one
 * literal `handle` shared between both slots, since delivery is genuinely
 * scheme-specific.
 */
export const AuthenticationLive: Layer.Layer<
  Api.Authentication,
  never,
  Sessions.Sessions | PrincipalResolver
> = Layer.effect(
  Api.Authentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const resolver = yield* PrincipalResolver;
    const authenticate = (
      scheme: "cookie" | "bearer",
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
      credential: Redacted.Redacted<string>,
    ) =>
      resolveSession(sessions, credential).pipe(
        Effect.flatMap(({ session, rotated }) =>
          resolver.resolve(session).pipe(
            Effect.flatMap((principal) =>
              Effect.provideService(httpEffect, Api.CurrentPrincipal, principal).pipe(
                Effect.flatMap((response) =>
                  // `PostAuthResponseHook` is resolved here, per request,
                  // not captured once above alongside `sessions`/
                  // `resolver` — a plugin overriding it (e.g.
                  // `@awthaq/jwt`) may itself need `Api.Authentication`
                  // for its own endpoints, which would make capturing the
                  // override at THIS layer's own build time an
                  // unresolvable circular build order. Resolved per
                  // request instead, from whatever the request's own full
                  // ambient context already has. Rotation delivery runs
                  // first — always-on core session-security machinery,
                  // orthogonal to the plugin decoration seam below.
                  deliverRotation(scheme, rotated, response).pipe(
                    Effect.flatMap((withRotation) =>
                      Effect.flatMap(PostAuthResponseHook, (hook) =>
                        hook.decorate(principal, withRotation, { scheme }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    const handle: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
      Api.CurrentPrincipal,
      typeof Api.Unauthenticated,
      never
    >["cookie"] = (httpEffect, { credential }) => authenticate("cookie", httpEffect, credential);
    const bearer: typeof handle = (httpEffect, { credential }) =>
      authenticate("bearer", httpEffect, credential);
    return { cookie: handle, bearer };
  }),
);

/**
 * BEH-EA-068/029: `cookie` still fails through to `bearer` on an absent or
 * invalid credential (BEH-EA-065/072's declaration-order chain) — only
 * `bearer`, the last scheme in the record, catches that failure and defaults
 * to `anonymousPrincipal` instead of letting it reach the caller.
 */
export const OptionalAuthenticationLive: Layer.Layer<
  Api.OptionalAuthentication,
  never,
  Sessions.Sessions | PrincipalResolver
> = Layer.effect(
  Api.OptionalAuthentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const resolver = yield* PrincipalResolver;
    const authenticate = (
      scheme: "cookie" | "bearer",
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
      credential: Redacted.Redacted<string>,
    ) =>
      resolveSession(sessions, credential).pipe(
        Effect.flatMap(({ session, rotated }) =>
          resolver.resolve(session).pipe(
            Effect.flatMap((principal) =>
              Effect.provideService(httpEffect, Api.CurrentPrincipal, principal).pipe(
                Effect.flatMap((response) =>
                  // Per request, not captured at build time — see the
                  // identical note on `AuthenticationLive` above.
                  deliverRotation(scheme, rotated, response).pipe(
                    Effect.flatMap((withRotation) =>
                      Effect.flatMap(PostAuthResponseHook, (hook) =>
                        hook.decorate(principal, withRotation, { scheme }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    const cookie: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
      Api.CurrentPrincipal,
      typeof Api.Unauthenticated,
      never
    >["cookie"] = (httpEffect, { credential }) => authenticate("cookie", httpEffect, credential);
    const bearer: typeof cookie = (httpEffect, { credential }) =>
      authenticate("bearer", httpEffect, credential).pipe(
        // The anonymous fallback below is a *recovery* from resolution
        // failure, never a success `authenticate` itself produced —
        // `PostAuthResponseHook`/rotation delivery are only ever
        // consulted above, on the genuine success path, so an
        // anonymous/no-credential caller never gets a decorated (e.g.
        // `@awthaq/jwt`-minted) response.
        Effect.catchTag("Unauthenticated", () =>
          Effect.provideService(httpEffect, Api.CurrentPrincipal, Api.anonymousPrincipal),
        ),
      );
    return { cookie, bearer };
  }),
);
