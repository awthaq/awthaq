// @awthaq/server — Authentication middleware
//
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
// Implements the `Authentication`/`OptionalAuthentication` declarations from
// `@awthaq/api`'s `Api.ts` against `@awthaq/core`'s `Sessions`.

import { Observability, SessionCookie, Sessions } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import type { unhandled } from "effect/Types";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Credentials from "./Credentials.ts";

/**
 * `.scratch/jwt/spec.md`'s "Automatic response mirroring" decision (and
 * `.scratch/jwt/issues/02-mint-delivery-mechanism.md`'s own resolution): a
 * second overridable slot, mirroring `Credentials.PrincipalResolver` immediately
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
   * `mirrorResponses: "bearer"`). `"impersonation"` is a cookie-delivered
   * episode (`__Host-impersonation`), so a hook keyed on `"bearer"` treats it
   * like `"cookie"`.
   */
  readonly decorate: (
    principal: Api.Principal,
    response: HttpServerResponse.HttpServerResponse,
    context: { readonly scheme: Credentials.Carrier },
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

export const PostAuthResponseHook = Context.Reference<PostAuthResponseHookShape>(
  "awthaq/server/PostAuthResponseHook",
  { defaultValue: () => ({ decorate: (_principal, response) => Effect.succeed(response) }) },
);

/** APS-006: the credential carriers that resolve to a session, in chain order. */
type Scheme = "impersonation" | "cookie" | "bearer";

/**
 * The claiming contribution's principal, or `None` when no contribution claims
 * the credential (or none are registered). A claimed credential that fails to
 * resolve fails `Unauthenticated`: see `CredentialResolverContribution`.
 */
const resolveClaimed = (carrier: Credentials.ClaimCarrier, credential: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const claiming = yield* Credentials.findClaim(carrier, credential);
    if (Option.isNone(claiming)) return Option.none<Api.Principal>();
    // MA-004 / plan 05: a contribution's store outage is the request's outage, exactly as the
    // cookie scheme's is: later schemes of the same request fail with it before doing any work.
    const request = yield* HttpServerRequest.HttpServerRequest;
    const outage = requestOutages.get(request.source);
    if (outage !== undefined) return yield* Effect.fail(outage);
    return Option.some(
      yield* claiming.value
        .resolve(credential)
        .pipe(
          Effect.tapError((error) =>
            Predicate.isTagged(error, "StoreUnavailable")
              ? Effect.sync(() => requestOutages.set(request.source, error))
              : Effect.void,
          ),
        ),
    );
  });

/**
 * Serves `httpEffect` as `principal` and runs the post-auth hook. Shared by the
 * session path and the claimed-credential path. `PostAuthResponseHook` is
 * resolved here, per request, not captured at layer-build time: a plugin
 * overriding it (e.g. `@awthaq/jwt`) may itself need `Api.Authentication` for
 * its own endpoints, which would make capturing it in THIS layer an
 * unresolvable circular build order.
 */
const serve = (
  scheme: Scheme | "apiKey",
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, unhandled, Api.CurrentPrincipal>,
  principal: Api.Principal,
) =>
  Effect.provideService(httpEffect, Api.CurrentPrincipal, principal).pipe(
    Effect.annotateLogs(principalFields(principal)),
    Effect.flatMap((response) =>
      Effect.flatMap(PostAuthResponseHook, (hook) =>
        hook.decorate(principal, response, { scheme }),
      ),
    ),
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
 * Keyed by the request's underlying `request.source`, not the
 * `HttpServerRequest` wrapper (NHS-006): `HttpRouter`'s prefix mounts hand
 * a route a *new* wrapper via `request.modify` (`sliceRequestUrl`) that
 * keeps the same `source`, so code outside and inside a mounted route would
 * otherwise see two identities and fork the cache. This is the very idiom
 * Effect's own per-request state uses (`requestPreResponseHandlers` in
 * `unstable/http/internal/preResponseHandler.ts` is a module-level
 * `WeakMap` keyed on `request.source`; Effect v4 has no `FiberRef`, ELC-007),
 * so the entry is garbage-collected with the request and needs no cleanup.
 *
 * TS-003: each credential's slot is a `Deferred` created in one synchronous
 * get-or-create step (JS is single-threaded, so it is atomic), so
 * `Sessions.verify` runs at most once per (request, credential) under any
 * interleaving — a `Ref` + `yield*` between get and set could let two fibers
 * each register their own memo and verify (and rotate) twice.
 */
const sessionResolutionCache = new WeakMap<
  object,
  Map<string, Deferred.Deferred<ResolvedSession, Api.Unauthenticated | Api.StoreUnavailable>>
>();

/**
 * MA-004: Effect's security chain falls through to the next scheme on *any* typed failure and
 * answers with the last scheme's, so a `StoreUnavailable` from the cookie scheme would be
 * overwritten by the bearer scheme's ordinary `Unauthenticated` (no credential presented) and
 * answer 401 again — the very conflation NHS-002 fixed. The first scheme to see the outage
 * records it here (weak-keyed on the request, like the memo above) and every later scheme of the
 * same request fails with it before doing any work, so the final answer is the 503.
 */
const requestOutages = new WeakMap<object, Api.StoreUnavailable>();

/**
 * Atomically finds or creates the current request's slot for `raw`. `owner`
 * is true for exactly the one caller that created the slot and must therefore
 * run `verify` and complete it.
 */
const claimResolution = (request: HttpServerRequest.HttpServerRequest, raw: string) =>
  Effect.sync(() => {
    const perRequest =
      sessionResolutionCache.get(request.source) ??
      new Map<
        string,
        Deferred.Deferred<ResolvedSession, Api.Unauthenticated | Api.StoreUnavailable>
      >();
    sessionResolutionCache.set(request.source, perRequest);
    const existing = perRequest.get(raw);
    if (existing !== undefined) return { deferred: existing, owner: false, perRequest };
    const deferred = Deferred.makeUnsafe<
      ResolvedSession,
      Api.Unauthenticated | Api.StoreUnavailable
    >();
    perRequest.set(raw, deferred);
    return { deferred, owner: true, perRequest };
  });

/**
 * PIL-005/NHS-007: delivers a rotated secret on whatever response the
 * request ends up with — registered as a pre-response handler by the one
 * `verify` call that rotated, so it runs for every route style (Path A's
 * middleware, Path B's `RequirePermission`) and every handler outcome,
 * including a typed-error response (a `flatMap` on the handler's success, as
 * this used to be, never sees `HandlerError`, so the rotated secret was lost
 * and the client silently logged out once `SessionConfig.rotationGrace` passed,
 * upstream-hardening ticket 01, RRS-005).
 *
 * Delivery splits by how the request authenticated: `cookie` gets the
 * `Set-Cookie` write `OAuth.ts` already uses after `issue` (a browser's jar
 * is only updated by `Set-Cookie`); `bearer` gets `Api.ROTATED_TOKEN_HEADER`,
 * the only way a raw-secret bearer client can learn its token rotated. Both
 * carry `Cache-Control: no-store` (MAPS-008) — the response holds a
 * long-lived secret. A handler that already wrote the session cookie itself
 * (a fresh sign-in's `issue`, a sign-out's expiry) wins: the rotated secret
 * belongs to a session that handler replaced or ended. An encoding failure is
 * logged and the response returned undecorated, never defected — delivery
 * must not turn a successful response into a 500 (NHS-007).
 */
const rotationDelivery =
  (
    scheme: Scheme,
    session: Sessions.SessionView,
    token: Redacted.Redacted<string>,
  ): HttpEffect.PreResponseHandler =>
  (_request, response) => {
    const noStore = HttpServerResponse.setHeader(response, "cache-control", "no-store");
    if (scheme === "bearer") {
      return Effect.succeed(
        HttpServerResponse.setHeader(noStore, Api.ROTATED_TOKEN_HEADER, Redacted.value(token)),
      );
    }
    // IC-007/BO-005: rendered through the shared `SessionCookie` config, so a
    // rotation carries the configured attributes and a `Max-Age` recomputed
    // from the session's remaining absolute lifetime.
    return SessionCookie.render(
      session,
      token,
      scheme === "impersonation" ? "impersonation" : "session",
    ).pipe(
      Effect.flatMap((cookie) =>
        Option.isSome(Cookies.get(response.cookies, cookie.name))
          ? Effect.succeed(response)
          : HttpServerResponse.setCookie(noStore, cookie.name, cookie.value, cookie.options),
      ),
      Effect.catch((error) =>
        Effect.logWarning("awthaq: could not deliver the rotated session cookie", error).pipe(
          Effect.as(response),
        ),
      ),
    );
  };

/**
 * BEH-EA-069/070: shared by both `Authentication` and `OptionalAuthentication`
 * — an empty credential (BEH-EA-065's cookie/bearer schemes decode to `""`
 * when the request carries neither, never a decode failure) and an invalid
 * or expired session are both reported as `Unauthenticated`, uniformly.
 *
 * `HttpServerRequest` is a hard requirement in `R` (ELC-007): a caller that
 * does not provide it fails to type-check, so nothing degrades silently to
 * per-call verification. The memo's lifetime is the underlying request's, as
 * Effect's own pre-response handlers are (see `sessionResolutionCache`).
 *
 * Upstream-hardening ticket 01/PIL-005: a `verify` that rotated the secret
 * registers its own delivery (`rotationDelivery`) with the request, so
 * `scheme` — how this credential was presented — is required here even for
 * callers that never see the response (`resolvePrincipal`, Path B).
 *
 * Ticket 03: memoized per request (see `sessionResolutionCache` above),
 * keyed on the raw presented credential — a second call in the same
 * request with the identical credential awaits the first call's outcome
 * (a failure is reused exactly like a success) rather than hitting
 * `Sessions.verify` again.
 *
 * PCS-006: a deliberate staleness budget — a session revoked mid-request
 * keeps resolving for the remainder of that same request (bounded by the
 * request's lifetime; a streaming response or long upload inherits the
 * window). Invalidating the memo on revoke-of-current is deliberately not
 * done (BEH-EA-070).
 */
export const resolveSession = (
  sessions: Sessions.SessionsShape,
  credential: Redacted.Redacted<string>,
  scheme: Scheme,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = Redacted.value(credential);
    const outage = requestOutages.get(request.source);
    if (outage !== undefined) return yield* Effect.fail(outage);
    if (raw === "") return yield* Effect.fail(new Api.Unauthenticated());
    const { deferred, owner, perRequest } = yield* claimResolution(request, raw);
    if (!owner) return yield* Deferred.await(deferred);
    // NHS-002/EEM-003: `verify`'s failure tags used to collapse uniformly to
    // `Unauthenticated` via a blanket `Effect.mapError` — a backing-store
    // outage answered 401 on every request, indistinguishable from a bad
    // credential, RFC-inverted (401 claims the credential is wrong, not that
    // the server is broken), and invisible to status-code-keyed alerting.
    // MA-004: an outage is now the typed `StoreUnavailable` (the interim
    // `Effect.die` -> 500 is gone), which this middleware declares and so
    // answers 503; only `SessionNotFound`/`SessionExpired` (a genuinely absent
    // or expired session) map to `Unauthenticated`.
    const verified = sessions.verify(Redacted.make(raw)).pipe(
      // EOTS-003: a rejected credential is otherwise silent. One structured debug line
      // (fixed vocabulary, ticket 27 §3) and a span outcome — never the credential or
      // the session id: the id is the public half of the bearer credential, and a
      // *rejected* one is attacker-supplied input that must not reach the logs. The
      // failure counter lives in `Sessions.verify` itself
      // (`awthaq_session_verify_failed_total{reason}`).
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          [Observability.Field.outcome]: "failure",
          [Observability.Field.reason]: error._tag,
        }).pipe(
          Effect.andThen(
            Effect.logDebug("awthaq: session verification failed").pipe(
              Effect.annotateLogs({
                [Observability.Field.event]: "session.verify.failed",
                [Observability.Field.outcome]: "failure",
                [Observability.Field.reason]: error._tag,
                "auth.scheme": scheme,
              }),
            ),
          ),
        ),
      ),
      Effect.catchTags({
        "Sessions/NotFound": () => Effect.fail(new Api.Unauthenticated()),
        SessionExpired: () => Effect.fail(new Api.Unauthenticated()),
      }),
      Effect.tapError((error) =>
        Predicate.isTagged(error, "StoreUnavailable")
          ? Effect.sync(() => requestOutages.set(request.source, error))
          : Effect.void,
      ),
      Effect.tap(({ session, rotated }) =>
        Option.isSome(rotated)
          ? HttpEffect.appendPreResponseHandler(rotationDelivery(scheme, session, rotated.value))
          : Effect.void,
      ),
    );
    yield* verified.pipe(
      Effect.onInterrupt(() => Effect.sync(() => perRequest.delete(raw))),
      Deferred.into(deferred),
    );
    return yield* Deferred.await(deferred);
  }).pipe(
    // MAPS-007: the shared choke point of Path A (the middleware) and Path B
    // (`SubjectExtractor`), so every authenticated request's trace has this span.
    Effect.withSpan(Observability.Span.principalResolve, {
      attributes: { "auth.scheme": scheme },
    }),
  );

/**
 * MAPS-007: names the principal (and, for a user, its session) on the current span and on
 * every log the handler writes — ids only (`auth.principal.ref`, `auth.session.id`), never
 * a name, email or credential — so a trace or a log line identifies who and which session
 * without a join.
 */
const principalFields = (principal: Api.Principal) => ({
  [Observability.Field.principalType]: principal.ref.type,
  [Observability.Field.principalRef]: principal.ref.id,
  ...(principal._tag === "User" ? { [Observability.Field.sessionId]: principal.sessionId } : {}),
});

const annotatePrincipal = (principal: Api.Principal) =>
  Effect.annotateCurrentSpan({
    ...principalFields(principal),
    [Observability.Field.outcome]: "success",
  });

const resolveAndAnnotate = (
  resolver: Credentials.PrincipalResolverShape,
  session: Sessions.SessionView,
) => resolver.resolve(session).pipe(Effect.tap(annotatePrincipal));

/**
 * Exported (not module-private) so `@awthaq/qadi`'s `SubjectExtractor.ts`
 * (BEH-EA-153) can call the identical hash-comparison/expiry logic this
 * middleware uses, rather than reimplementing it against the raw request —
 * BEH-EA-153 requires exactly that reuse. A rotated secret is still
 * delivered (PIL-005): `resolveSession` registers the delivery on the
 * request itself, so this principal-only wrapper needs no response.
 *
 * MAPS-001/OCM-002: a `bearer`/`apiKey` credential is offered to the
 * registered credential resolvers first (Path B must recognise exactly what
 * `Authentication` does); an unclaimed `bearer` credential is a session token,
 * an unclaimed `apiKey` is `Unauthenticated`.
 */
export const resolvePrincipal = (
  sessions: Sessions.SessionsShape,
  resolver: Credentials.PrincipalResolverShape,
  credential: Redacted.Redacted<string>,
  scheme: Scheme | "apiKey",
) => {
  const viaSession = (sessionScheme: Scheme) =>
    resolveSession(sessions, credential, sessionScheme).pipe(
      Effect.flatMap(({ session }) => resolveAndAnnotate(resolver, session)),
    );
  if (scheme === "cookie" || scheme === "impersonation") return viaSession(scheme);
  return resolveClaimed(scheme, credential).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (principal) => Effect.succeed(principal),
        onNone: () =>
          scheme === "bearer" ? viaSession("bearer") : Effect.fail(new Api.Unauthenticated()),
      }),
    ),
  );
};

/**
 * IC-007: the `cookie` scheme's decoded credential is keyed on the *default*
 * cookie name (the contract is static), so a deployment whose configured name
 * differs (`SecureDomain`'s `__Secure-session`) is read off the request by the
 * configured name instead. Identical to the scheme's own credential otherwise.
 */
const cookieCredential = (
  schemeCredential: Redacted.Redacted<string>,
  kind: SessionCookie.CookieKind = "session",
) =>
  Effect.gen(function* () {
    const name = SessionCookie.cookieName(yield* SessionCookie.SessionCookieConfig, kind);
    const defaultName =
      kind === "impersonation" ? Api.IMPERSONATION_COOKIE_NAME : Api.SESSION_COOKIE_NAME;
    if (name === defaultName) return schemeCredential;
    const request = yield* HttpServerRequest.HttpServerRequest;
    return Redacted.make(request.cookies[name] ?? "");
  });

/** JR-007: the `realm` of every `WWW-Authenticate` challenge this middleware emits. */
const CHALLENGE_REALM = "awthaq";

/**
 * APS-006: an `__Host-impersonation` cookie is only ever an impersonation
 * session — an ordinary session presented there (planted by an attacker who
 * holds one, or a stale value) must not authenticate; failing here lets the
 * chain fall through to `cookie`.
 */
const requireImpersonationSession = (scheme: Scheme, resolved: ResolvedSession) =>
  scheme === "impersonation" && Option.isNone(resolved.session.actingAs)
    ? Effect.fail(new Api.Unauthenticated())
    : Effect.succeed(resolved);

/**
 * BEH-EA-065 through 067/070: fails `Unauthenticated` only once every
 * declared scheme has. `cookie` and `bearer` each resolve through the shared
 * `resolveSession`/`resolver.resolve` core with their own `scheme`, which a
 * rotating `verify` uses to register its delivery (PIL-005) — see
 * `rotationDelivery`.
 */
const makeSessionTierHandlers = (machine: boolean) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const resolver = yield* Credentials.PrincipalResolver;
    const authenticate = (
      scheme: Scheme,
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
      credential: Redacted.Redacted<string>,
    ) =>
      resolveSession(sessions, credential, scheme).pipe(
        Effect.flatMap((resolved) => requireImpersonationSession(scheme, resolved)),
        // Rotation delivery is not here: it rides the request's pre-response
        // handler (PIL-005), so it also covers responses this success path
        // never sees. See `serve` for the per-request `PostAuthResponseHook`.
        Effect.flatMap(({ session }) =>
          resolveAndAnnotate(resolver, session).pipe(
            Effect.flatMap((principal) => serve(scheme, httpEffect, principal)),
          ),
        ),
      );
    // MAPS-001/OCM-002: a credential a registered resolver claims resolves to its
    // principal directly (no session, no rotation); `bearer` alone falls back to
    // opaque session resolution when nothing claims it. Only the machine tier
    // admits a non-`User` principal (see `Api.MachineAuthentication`).
    const authenticateCarried = (
      carrier: Credentials.ClaimCarrier,
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
      credential: Redacted.Redacted<string>,
    ) =>
      resolveClaimed(carrier, credential).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (principal) =>
              machine || principal._tag === "User"
                ? serve(carrier, httpEffect, principal)
                : Effect.fail(new Api.Unauthenticated()),
            onNone: () =>
              carrier === "bearer"
                ? authenticate("bearer", httpEffect, credential)
                : Effect.fail(new Api.Unauthenticated()),
          }),
        ),
      );
    const handle: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      {
        readonly impersonation: typeof Api.ImpersonationCookie;
        readonly cookie: typeof Api.SessionCookie;
        readonly apiKey: typeof Api.ApiKeyHeader;
        readonly bearer: typeof Api.BearerToken;
      },
      Api.CurrentPrincipal,
      typeof Api.Unauthenticated | typeof Api.StoreUnavailable,
      never
    >["cookie"] = (httpEffect, { credential }) =>
      cookieCredential(credential).pipe(
        Effect.flatMap((resolved) => authenticate("cookie", httpEffect, resolved)),
      );
    // APS-006: declared first — an impersonation cookie shadows the caller's
    // own session cookie; only a session carrying `actingAs` authenticates
    // here, anything else falls through to `cookie`.
    const impersonation: typeof handle = (httpEffect, { credential }) =>
      cookieCredential(credential, "impersonation").pipe(
        Effect.flatMap((resolved) => authenticate("impersonation", httpEffect, resolved)),
      );
    // OCM-002: `x-api-key`, between `cookie` and `bearer` so `bearer` stays last.
    // Only `Api.MachineAuthentication` declares this scheme.
    const apiKey: typeof handle = (httpEffect, { credential }) =>
      authenticateCarried("apiKey", httpEffect, credential);
    const bearer: typeof handle = (httpEffect, { credential }) =>
      authenticateCarried("bearer", httpEffect, credential).pipe(
        // JR-007: `bearer` is the last declared scheme, so an `Unauthenticated`
        // here is the middleware's final failure — answer it with an RFC
        // 7235/6750 challenge alongside the unchanged typed JSON body.
        // `invalid_token` only when a bearer credential was actually
        // presented; otherwise the bare realm challenge (RFC 6750 §3.1: an
        // absent credential carries no error code). A handler's own errors
        // reach here wrapped, never as `Unauthenticated`, so they get none.
        Effect.tapError((error) =>
          Predicate.isTagged(error, "Unauthenticated")
            ? HttpEffect.appendPreResponseHandler((_request, response) =>
                Effect.succeed(
                  response.status === 401
                    ? HttpServerResponse.setHeader(
                        response,
                        "www-authenticate",
                        Redacted.value(credential) === ""
                          ? `Bearer realm="${CHALLENGE_REALM}"`
                          : `Bearer realm="${CHALLENGE_REALM}", error="invalid_token"`,
                      )
                    : response,
                ),
              )
            : Effect.void,
        ),
      );
    return { impersonation, cookie: handle, apiKey, bearer };
  });

export const AuthenticationLive: Layer.Layer<
  Api.Authentication,
  never,
  Sessions.Sessions | Credentials.PrincipalResolver
> = Layer.effect(
  Api.Authentication,
  Effect.map(makeSessionTierHandlers(false), ({ impersonation, cookie, bearer }) => ({
    impersonation,
    cookie,
    bearer,
  })),
);

/**
 * OCM-002/MAPS-003: the machine tier — `AuthenticationLive`'s chain plus the
 * `x-api-key` carrier, admitting `ApiKey`/`Service` principals that plugins'
 * credential resolvers produce. Provide it next to `AuthenticationLive`.
 */
export const MachineAuthenticationLive: Layer.Layer<
  Api.MachineAuthentication,
  never,
  Sessions.Sessions | Credentials.PrincipalResolver
> = Layer.effect(Api.MachineAuthentication, makeSessionTierHandlers(true));

/**
 * AR-003: the default admin-tier scheme is `Authentication` itself — the identical
 * handlers behind a second tag, so declaring the admin groups behind
 * `Api.AdminAuthentication` changes nothing for a co-hosted deployment. Override this
 * layer (provide your own `Api.AdminAuthentication`) to put the admin surface behind a
 * different credential; a deployment that serves only `adminApi` and overrides it needs
 * no `Api.Authentication` at all.
 */
export const AdminAuthenticationLive: Layer.Layer<
  Api.AdminAuthentication,
  never,
  Api.Authentication
> = Layer.effect(
  Api.AdminAuthentication,
  Effect.gen(function* () {
    return yield* Api.Authentication;
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
  Sessions.Sessions | Credentials.PrincipalResolver
> = Layer.effect(
  Api.OptionalAuthentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const resolver = yield* Credentials.PrincipalResolver;
    const authenticate = (
      scheme: Scheme,
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
      credential: Redacted.Redacted<string>,
    ) =>
      resolveSession(sessions, credential, scheme).pipe(
        Effect.flatMap((resolved) => requireImpersonationSession(scheme, resolved)),
        Effect.flatMap(({ session }) =>
          resolveAndAnnotate(resolver, session).pipe(
            Effect.flatMap((principal) => serve(scheme, httpEffect, principal)),
          ),
        ),
      );
    // See the identical helper on `AuthenticationLive` above: this is the user
    // tier, so a claimed credential is admitted only as a `User`.
    const authenticateBearer = (
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
      credential: Redacted.Redacted<string>,
    ) =>
      resolveClaimed("bearer", credential).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (principal) =>
              principal._tag === "User"
                ? serve("bearer", httpEffect, principal)
                : Effect.fail(new Api.Unauthenticated()),
            onNone: () => authenticate("bearer", httpEffect, credential),
          }),
        ),
      );
    // EHA-006/NHS-010: `Api.OptionalAuthentication` declares no error type, so
    // no handler may fail with `Unauthenticated` — the first-declared handler
    // (`impersonation`, APS-006) resolves the impersonation cookie, then the
    // session cookie, then the bearer credential itself, then defaults to
    // `anonymousPrincipal`. The anonymous fallback no longer depends on which
    // scheme happens to be declared last. (Effect looks Live handlers up by
    // key and iterates the declaration's `security` record, so `cookie` and
    // `bearer` below are never reached in practice; each carries the rest of
    // its own chain because every declared scheme needs a handler.)
    const anonymous = (
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
    ) => Effect.provideService(httpEffect, Api.CurrentPrincipal, Api.anonymousPrincipal);
    // The session cookie, then the bearer credential, then anonymous.
    const cookieChain = (
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unhandled,
        Api.CurrentPrincipal
      >,
      credential: Redacted.Redacted<string>,
    ) =>
      cookieCredential(credential).pipe(
        Effect.flatMap((resolved) => authenticate("cookie", httpEffect, resolved)),
        Effect.catchTag("Unauthenticated", () =>
          HttpApiBuilder.securityDecode(Api.BearerToken).pipe(
            Effect.flatMap((bearerCredential) => authenticateBearer(httpEffect, bearerCredential)),
            // The anonymous fallback is a *recovery* from resolution failure,
            // never a success `authenticate` itself produced —
            // `PostAuthResponseHook` is only ever consulted on the genuine
            // success path, so an anonymous/no-credential caller never gets
            // a decorated (e.g. `@awthaq/jwt`-minted) response.
            Effect.catchTag("Unauthenticated", () => anonymous(httpEffect)),
          ),
        ),
      );
    const cookie: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      {
        readonly impersonation: typeof Api.ImpersonationCookie;
        readonly cookie: typeof Api.SessionCookie;
        readonly bearer: typeof Api.BearerToken;
      },
      Api.CurrentPrincipal,
      typeof Api.StoreUnavailable,
      never
    >["cookie"] = (httpEffect, { credential }) => cookieChain(httpEffect, credential);
    const impersonation: typeof cookie = (httpEffect, { credential }) =>
      cookieCredential(credential, "impersonation").pipe(
        Effect.flatMap((resolved) => authenticate("impersonation", httpEffect, resolved)),
        Effect.catchTag("Unauthenticated", () =>
          HttpApiBuilder.securityDecode(Api.SessionCookie).pipe(
            Effect.flatMap((sessionCredential) => cookieChain(httpEffect, sessionCredential)),
          ),
        ),
      );
    const bearer: typeof cookie = (httpEffect, { credential }) =>
      authenticateBearer(httpEffect, credential).pipe(
        Effect.catchTag("Unauthenticated", () => anonymous(httpEffect)),
      );
    return { impersonation, cookie, bearer };
  }),
);
