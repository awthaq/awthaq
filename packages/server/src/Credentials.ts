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

import { Observability, SessionCookie, Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Cookies from "effect/unstable/http/Cookies";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

// ---- the principal resolver and the claimed-credential registry (moved from Authentication.ts) ----------

/**
 * BEH-EA-069: derives a `Principal` from a resolved `Session` alone, with no
 * authorization decision (that is qadi's `SubjectResolver`'s job, downstream)
 * — its own service so a deployment may override how a session maps to a
 * principal without touching `Authentication` itself.
 */
export interface PrincipalResolverShape {
  readonly resolve: (
    session: Sessions.SessionView,
  ) => Effect.Effect<Api.Principal, Api.StoreUnavailable>;
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
 * (`exactOptionalPropertyTypes`). The one mapping both resolvers share.
 */
const userPrincipalOf = (session: Sessions.SessionView): Api.UserPrincipal =>
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
    // APS-007/THS-003: how the session was authenticated (empty when the
    // issuing path recorded none), never a guess.
    amr: session.amr,
    // AAPS-006/AOMS-012: OIDC `auth_time` (epoch seconds) — the freshness fact beside `amr`.
    authenticatedAt: Math.floor(DateTime.toEpochMillis(session.authenticatedAt) / 1000),
  });

export const PrincipalResolverLive: Layer.Layer<PrincipalResolver> = Layer.succeed(
  PrincipalResolver,
  { resolve: (session) => Effect.succeed(userPrincipalOf(session)) },
);

/**
 * APS-007: opt-in resolver that also exposes `emailVerified` on the principal,
 * at the cost of one `Users.findById` per request (hence not the default). A
 * missing user (deleted between verify and here) resolves as unverified —
 * fail-closed, never a defect. Everything else is `PrincipalResolverLive`'s
 * mapping.
 */
export const PrincipalResolverWithUserFactsLive = Layer.effect(
  PrincipalResolver,
  Effect.gen(function* () {
    const users = yield* Users.Users;
    return {
      resolve: (session: Sessions.SessionView) =>
        users.findById(session.userId).pipe(
          Effect.map(Users.isEmailVerified),
          Effect.catchTag("UserNotFound", () => Effect.succeed(false)),
          Effect.map(
            (emailVerified) =>
              new Api.UserPrincipal({ ...userPrincipalOf(session), emailVerified }),
          ),
        ),
    };
  }),
);

/**
 * MAPS-001/MAPS-004/OCM-002: the carriers whose credentials a plugin may claim
 * instead of a session: `bearer` (`Authorization: Bearer`, JWTs) and `apiKey`
 * (`x-api-key`). `cookie`/`impersonation` are session-only by design (BEH-EA-065).
 */
export type ClaimCarrier = "bearer" | "apiKey";

/**
 * MAPS-001/MAPS-004 (wayfinder ticket 33, registry option): one plugin's claim on
 * a carrier's credentials. `claims` is a cheap, secret-free look at the credential's
 * *shape* (three dot-separated segments and a JOSE `typ`, a key prefix), never a
 * verification and never constant-time-sensitive; the first contribution whose
 * `claims` matches resolves, and if that resolution fails the request is
 * `Unauthenticated` (later contributions are not tried, so one credential is
 * never probed against several strategies). A `bearer` credential nobody claims
 * falls through to opaque session resolution, exactly as before.
 * `resolve` goes straight to an `Api.Principal`: a stateless token has no session
 * row to hand `PrincipalResolver` (and so no rotation to deliver). It runs inside
 * the request (`HttpServerRequest` is the one service it may require, e.g. to
 * rate-limit by client address); every other dependency is captured when the
 * contributing layer is built.
 */
export interface CredentialResolverContribution {
  readonly id: string;
  /** Lower runs first among contributions claiming the same credential shape; ties break on `id`. Default 0. */
  readonly order?: number;
  readonly claims: (credential: string) => boolean;
  readonly resolve: (
    credential: Redacted.Redacted<string>,
  ) => Effect.Effect<
    Api.Principal,
    Api.Unauthenticated | Api.StoreUnavailable,
    HttpServerRequest.HttpServerRequest
  >;
}

/** Two contributions on one carrier share an `id`: a composition mistake, surfaced at layer build. */
export class DuplicateCredentialResolver extends Data.TaggedError("DuplicateCredentialResolver")<{
  readonly carrier: ClaimCarrier;
  readonly id: string;
  readonly message: string;
}> {}

/** A contribution arrived after the registry was first read (ADR-EA-012: registries freeze at first read). */
export class CredentialResolversFrozen extends Data.TaggedError("CredentialResolversFrozen")<{
  readonly message: string;
}> {}

export interface CredentialResolversShape {
  readonly register: (
    carrier: ClaimCarrier,
    contribution: CredentialResolverContribution,
  ) => Effect.Effect<void, DuplicateCredentialResolver | CredentialResolversFrozen>;
  /** The carrier's contributions in (`order`, `id`) order; the first call freezes the registry. */
  readonly resolvers: (
    carrier: ClaimCarrier,
  ) => Effect.Effect<ReadonlyArray<CredentialResolverContribution>>;
}

/**
 * ADR-EA-012 registry (aggregating, not an exclusive slot): any number of plugins
 * add a credential type with `contribute` and a Layer alone, without editing
 * `@awthaq/api` or this package. A real per-composition service (like
 * `RateLimitsRegistry`), so unrelated compositions and tests never share one.
 * `Authentication` reads it per request through `Effect.serviceOption`, so
 * `AuthenticationLive`'s own `R` is unchanged and an app that provides no
 * registry simply has no contributions.
 */
export class CredentialResolvers extends Context.Service<
  CredentialResolvers,
  CredentialResolversShape
>()("awthaq/server/CredentialResolvers") {}

export const CredentialResolversLive = Layer.effect(
  CredentialResolvers,
  Effect.gen(function* () {
    const entries = yield* Ref.make<
      ReadonlyArray<{
        readonly carrier: ClaimCarrier;
        readonly contribution: CredentialResolverContribution;
      }>
    >([]);
    const frozen = yield* Ref.make(false);
    const register: CredentialResolversShape["register"] = (carrier, contribution) =>
      Effect.gen(function* () {
        if (yield* Ref.get(frozen)) {
          return yield* new CredentialResolversFrozen({
            message: `awthaq: credential resolver "${contribution.id}" was contributed after the registry was first read`,
          });
        }
        const existing = yield* Ref.get(entries);
        if (existing.some((e) => e.carrier === carrier && e.contribution.id === contribution.id)) {
          return yield* new DuplicateCredentialResolver({
            carrier,
            id: contribution.id,
            message: `awthaq: two ${carrier} credential resolvers share the id "${contribution.id}"`,
          });
        }
        yield* Ref.set(entries, [...existing, { carrier, contribution }]);
      });
    const resolvers: CredentialResolversShape["resolvers"] = (carrier) =>
      Ref.set(frozen, true).pipe(
        Effect.flatMap(() => Ref.get(entries)),
        Effect.map((all) =>
          all
            .filter((e) => e.carrier === carrier)
            .map((e) => e.contribution)
            .sort(
              (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            ),
        ),
      );
    return CredentialResolvers.of({ register, resolvers });
  }),
);

/** A Layer that adds one contribution to `carrier`: how `@awthaq/jwt` and `@awthaq/api-key` claim credentials. */
export const contribute = (carrier: ClaimCarrier, contribution: CredentialResolverContribution) =>
  Layer.effectDiscard(
    Effect.flatMap(CredentialResolvers, (registry) => registry.register(carrier, contribution)),
  );

/**
 * The claiming contribution for `credential`, or `None` when no contribution claims it (or none are
 * registered). The registry lookup alone; running the contribution is `resolveClaimed`.
 */
const findClaim = (carrier: ClaimCarrier, credential: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const raw = Redacted.value(credential);
    const registry = yield* Effect.serviceOption(CredentialResolvers);
    if (raw === "" || Option.isNone(registry)) return Option.none<CredentialResolverContribution>();
    const contributions = yield* registry.value.resolvers(carrier);
    return Option.fromNullishOr(contributions.find((contribution) => contribution.claims(raw)));
  });

/**
 * MAPS-001/OCM-002: the claiming contribution's principal, or `None` when no contribution claims the
 * credential. A claimed credential that fails to resolve fails `Unauthenticated`: see
 * `CredentialResolverContribution`.
 */
const resolveClaimed = (carrier: ClaimCarrier, credential: Redacted.Redacted<string>) =>
  findClaim(carrier, credential).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<Api.Principal>()),
        onSome: (claiming) => Effect.map(claiming.resolve(credential), Option.some),
      }),
    ),
  );

// ---- what a request presents ----------------------------------------------------------------------------

/** APS-006/OCM-002: every credential carrier an awthaq middleware declares. */
export type Carrier = "impersonation" | "cookie" | "apiKey" | "bearer";
/** The carriers that resolve to a session row (and so can rotate). */
export type SessionCarrier = "impersonation" | "cookie" | "bearer";

const isCarrier = (key: string): key is Carrier =>
  key === "impersonation" || key === "cookie" || key === "apiKey" || key === "bearer";

/** What one request presents. An absent or empty value is `None` (BEH-EA-065: an empty credential never resolves). */
export type Presented = { readonly [K in Carrier]: Option.Option<Redacted.Redacted<string>> };

/** How an adapter exposes its request: a parsed cookie lookup and a case-insensitive header lookup. */
export interface Source {
  readonly cookie: (name: string) => string | undefined;
  readonly header: (name: string) => string | undefined;
}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value === ""
    ? Option.none<Redacted.Redacted<string>>()
    : Option.some(Redacted.make(value));

/** RFC 9110 §11.1, identical to `HttpApiBuilder.securityDecode(Api.BearerToken)` (pinned by the parsing tests). */
const bearerCredential = (authorization: string | undefined) => {
  const scheme = "bearer";
  if (
    authorization === undefined ||
    authorization.length <= scheme.length ||
    authorization.charCodeAt(scheme.length) !== 32 ||
    authorization.slice(0, scheme.length).toLowerCase() !== scheme
  ) {
    return undefined;
  }
  const credential = authorization.slice(scheme.length + 1).replace(/^ +/, "");
  return credential === "" ? undefined : credential;
};

/**
 * IC-007: reads every carrier, the cookie names from the ambient `SessionCookieConfig`. The one reader:
 * no adapter names a cookie or a header itself.
 */
export const presented = Effect.fnUntraced(function* (source: Source) {
  const config = yield* SessionCookie.SessionCookieConfig;
  return {
    impersonation: nonEmpty(source.cookie(SessionCookie.cookieName(config, "impersonation"))),
    cookie: nonEmpty(source.cookie(SessionCookie.cookieName(config, "session"))),
    apiKey: nonEmpty(source.header(Api.API_KEY_HEADER_NAME)),
    bearer: nonEmpty(bearerCredential(source.header("authorization"))),
  } satisfies Presented;
});

/** The HTTP source: Effect's parsed cookies (the same map `HttpApiSecurity.apiKey({ in: "cookie" })` decodes). */
export const fromRequest = (request: HttpServerRequest.HttpServerRequest) =>
  presented({
    cookie: (name) => request.cookies[name],
    header: (name) => Option.getOrUndefined(Headers.get(request.headers, name)),
  });

// ---- tiers ----------------------------------------------------------------------------------------------

/** A tier: the carriers its declaration lists, in declaration order (BEH-EA-072), and the principals it admits. */
export interface Tier<P extends Api.Principal> {
  readonly carriers: ReadonlyArray<Carrier>;
  readonly admits: (principal: Api.Principal) => principal is P;
}

export const tier = <P extends Api.Principal>(
  declaration: {
    readonly security: Readonly<Record<string, HttpApiSecurity.HttpApiSecurity>>;
  },
  admits: (principal: Api.Principal) => principal is P,
) => ({ carriers: Record.keys(declaration.security).filter(isCarrier), admits }) satisfies Tier<P>;

const isUser = (principal: Api.Principal): principal is Api.UserPrincipal =>
  principal._tag === "User";
const isAny = (_principal: Api.Principal): _principal is Api.Principal => true;

/** OCM-002: the user tier admits a `User` only; the machine tier admits whatever a claimed credential resolves to. */
export const userTier = tier(Api.Authentication, isUser);
export const optionalTier = tier(Api.OptionalAuthentication, isUser);
export const machineTier = tier(Api.MachineAuthentication, isAny);

// ---- the seam: a scope ----------------------------------------------------------------------------------

/** PIL-005: a verify that rotated, and the carrier its credential came in on (the delivery's channel and cookie kind). */
export interface Rotation {
  readonly carrier: SessionCarrier;
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

/** The seam. One implementation per entry point kind (HTTP request, framework call). */
export interface Scope {
  /** PCS-006: the identity the per-request memo and outage record hang off. HTTP: `request.source` (NHS-006). */
  readonly key: object;
  /** Called once, by the one verify that rotated (the memo owner). */
  readonly deliver: (rotation: Rotation) => Effect.Effect<void>;
  /** MAPS-001: the registry's principal for a claimed credential; `None` when nobody claims it. */
  readonly claim: (
    carrier: ClaimCarrier,
    credential: Redacted.Redacted<string>,
  ) => Effect.Effect<Option.Option<Api.Principal>, Api.Unauthenticated | Api.StoreUnavailable>;
}

/** What a request resolved to. `Session` carries the row the web adapter needs; `Claimed` has none (no rotation). */
export type Resolved<P extends Api.Principal> =
  | {
      readonly _tag: "Session";
      readonly carrier: SessionCarrier;
      readonly principal: P;
      readonly session: Sessions.SessionView;
    }
  | { readonly _tag: "Claimed"; readonly carrier: ClaimCarrier; readonly principal: P };

type Failure = Api.Unauthenticated | Api.StoreUnavailable;

// PCS-006/TS-003: single-flight per (scope, slot). One Deferred per credential, created in one synchronous
// get-or-create step (JS is single-threaded, so it is atomic): the verify (or the claim) runs at most once per
// (scope, credential) under any interleaving. Keyed by `scope.key`, like Effect's own per-request state
// (`requestPreResponseHandlers` is a `WeakMap` on `request.source`), so the entry is garbage-collected with the
// request and needs no cleanup.
const sessionMemo = new WeakMap<
  object,
  Map<string, Deferred.Deferred<Sessions.VerifiedSession, Failure>>
>();
const claimMemo = new WeakMap<
  object,
  Map<string, Deferred.Deferred<Option.Option<Api.Principal>, Failure>>
>();
// MA-004: Effect's security chain falls through to the next scheme on *any* typed failure and answers with
// the last one's, so a `StoreUnavailable` from the cookie scheme would be overwritten by the bearer scheme's
// ordinary `Unauthenticated`. The first carrier that sees an outage records it here (weak-keyed on the scope)
// and every later step of the same scope fails with it before doing any work, so the final answer is the 503.
const outages = new WeakMap<object, Api.StoreUnavailable>();

const once = <A>(
  table: WeakMap<object, Map<string, Deferred.Deferred<A, Failure>>>,
  key: object,
  slot: string,
  effect: () => Effect.Effect<A, Failure>,
) =>
  Effect.gen(function* () {
    const claimed = yield* Effect.sync(() => {
      const perScope = table.get(key) ?? new Map<string, Deferred.Deferred<A, Failure>>();
      table.set(key, perScope);
      const existing = perScope.get(slot);
      if (existing !== undefined) return { deferred: existing, owner: false, perScope };
      const deferred = Deferred.makeUnsafe<A, Failure>();
      perScope.set(slot, deferred);
      return { deferred, owner: true, perScope };
    });
    if (!claimed.owner) return yield* Deferred.await(claimed.deferred);
    yield* effect().pipe(
      Effect.onInterrupt(() => Effect.sync(() => claimed.perScope.delete(slot))),
      Deferred.into(claimed.deferred),
    );
    return yield* Deferred.await(claimed.deferred);
  });

/**
 * MAPS-007: names the principal (and, for a user, its session) on the current span and on
 * every log the handler writes — ids only (`auth.principal.ref`, `auth.session.id`), never
 * a name, email or credential — so a trace or a log line identifies who and which session
 * without a join.
 */
export const principalFields = (principal: Api.Principal) => ({
  [Observability.Field.principalType]: principal.ref.type,
  [Observability.Field.principalRef]: principal.ref.id,
  ...(principal._tag === "User" ? { [Observability.Field.sessionId]: principal.sessionId } : {}),
});

const annotatePrincipal = (principal: Api.Principal) =>
  Effect.annotateCurrentSpan({
    ...principalFields(principal),
    [Observability.Field.outcome]: "success",
  });

/** Built once per adapter layer (or per web call); `R` = `Sessions | PrincipalResolver`. */
export const make = Effect.gen(function* () {
  const sessions = yield* Sessions.Sessions;
  const resolver = yield* PrincipalResolver;

  // BEH-EA-069/070: an empty credential and an invalid or expired session are both `Unauthenticated`. NHS-002/MA-004:
  // an outage is the typed `StoreUnavailable`; only `Sessions/NotFound`/`SessionExpired` mean "not a session".
  // Upstream-hardening ticket 01/PIL-005: a `verify` that rotated hands the new secret to the scope, at verify
  // time, before any later failure (a resolver outage) can lose it.
  const verified = (carrier: SessionCarrier, credential: Redacted.Redacted<string>, scope: Scope) =>
    once(sessionMemo, scope.key, Redacted.value(credential), () =>
      sessions.verify(credential).pipe(
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
                  "auth.scheme": carrier,
                }),
              ),
            ),
          ),
        ),
        Effect.catchTags({
          "Sessions/NotFound": () => Effect.fail(new Api.Unauthenticated()),
          SessionExpired: () => Effect.fail(new Api.Unauthenticated()),
        }),
        Effect.tap(({ session, rotated }) =>
          Option.isSome(rotated)
            ? scope.deliver({ carrier, session, token: rotated.value })
            : Effect.void,
        ),
      ),
    );

  const viaSession = (
    carrier: SessionCarrier,
    credential: Redacted.Redacted<string>,
    scope: Scope,
  ) =>
    verified(carrier, credential, scope).pipe(
      // APS-006: only a session carrying `actingAs` counts from the impersonation cookie — judged on the
      // session, before the resolver, for every entry point.
      Effect.filterOrFail(
        ({ session }) => carrier !== "impersonation" || Option.isSome(session.actingAs),
        () => new Api.Unauthenticated(),
      ),
      Effect.flatMap(({ session }) =>
        resolver
          .resolve(session)
          .pipe(
            Effect.map((principal) => ({ _tag: "Session", carrier, principal, session }) as const),
          ),
      ),
    );

  const viaClaim = (carrier: ClaimCarrier, credential: Redacted.Redacted<string>, scope: Scope) =>
    Effect.gen(function* () {
      const claimed = yield* once(
        claimMemo,
        scope.key,
        `${carrier}:${Redacted.value(credential)}`,
        () => scope.claim(carrier, credential),
      );
      if (Option.isSome(claimed)) {
        return { _tag: "Claimed", carrier, principal: claimed.value } as const;
      }
      // MAPS-001: an unclaimed bearer is an opaque session token; an unclaimed api key is nothing.
      if (carrier !== "bearer") return yield* Effect.fail(new Api.Unauthenticated());
      return yield* viaSession("bearer", credential, scope);
    });

  /** One carrier: what Path A's handler for that declared scheme runs. */
  const step = <P extends Api.Principal>(
    carrier: Carrier,
    presentedCredentials: Presented,
    admission: Tier<P>,
    scope: Scope,
  ) =>
    Effect.gen(function* () {
      const outage = outages.get(scope.key);
      if (outage !== undefined) return yield* Effect.fail(outage);
      const credential = presentedCredentials[carrier];
      if (Option.isNone(credential)) return yield* Effect.fail(new Api.Unauthenticated());
      const resolved =
        carrier === "impersonation" || carrier === "cookie"
          ? yield* viaSession(carrier, credential.value, scope)
          : yield* viaClaim(carrier, credential.value, scope);
      const principal = resolved.principal;
      // OCM-002: admission applies to every principal, session-derived or claimed.
      if (!admission.admits(principal)) return yield* Effect.fail(new Api.Unauthenticated());
      yield* annotatePrincipal(principal);
      return resolved._tag === "Session"
        ? ({
            _tag: "Session",
            carrier: resolved.carrier,
            principal,
            session: resolved.session,
          } as const)
        : ({ _tag: "Claimed", carrier: resolved.carrier, principal } as const);
    }).pipe(
      Effect.tapError((error) =>
        Predicate.isTagged(error, "StoreUnavailable")
          ? Effect.sync(() => outages.set(scope.key, error))
          : Effect.void,
      ),
      // MAPS-007: every authenticated request's trace has this span, one per carrier tried.
      Effect.withSpan(Observability.Span.principalResolve, {
        attributes: { "auth.scheme": carrier },
      }),
    );

  /**
   * The whole chain, for entry points with no security loop of their own (the optional tier, Path B, the web
   * adapter): the tier's carriers in declaration order, falling through on `Unauthenticated` exactly as
   * Effect's loop does. An outage stops it: `step` records it, so every later carrier fails with it.
   */
  const resolve = <P extends Api.Principal>(
    presentedCredentials: Presented,
    admission: Tier<P>,
    scope: Scope,
  ) =>
    admission.carriers.reduce<Effect.Effect<Resolved<P>, Failure>>(
      (previous, carrier) =>
        previous.pipe(
          Effect.catchTag("Unauthenticated", () =>
            step(carrier, presentedCredentials, admission, scope),
          ),
        ),
      Effect.fail(new Api.Unauthenticated()),
    );

  return { step, resolve };
});

// ---- the two scopes -------------------------------------------------------------------------------------

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
  (rotation: Rotation): HttpEffect.PreResponseHandler =>
  (_request, response) => {
    const noStore = HttpServerResponse.setHeader(response, "cache-control", "no-store");
    if (rotation.carrier === "bearer") {
      return Effect.succeed(
        HttpServerResponse.setHeader(
          noStore,
          Api.ROTATED_TOKEN_HEADER,
          Redacted.value(rotation.token),
        ),
      );
    }
    // IC-007/BO-005: rendered through the shared `SessionCookie` config, so a
    // rotation carries the configured attributes and a `Max-Age` recomputed
    // from the session's remaining absolute lifetime.
    return SessionCookie.render(
      rotation.session,
      rotation.token,
      rotation.carrier === "impersonation" ? "impersonation" : "session",
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

/** The HTTP scope: one per request (keyed on `source`, so `request.modify` re-wraps share it — NHS-006). */
export const httpScope = (request: HttpServerRequest.HttpServerRequest) =>
  ({
    key: request.source,
    deliver: (rotation) =>
      Effect.sync(() =>
        HttpEffect.appendPreResponseHandlerUnsafe(request, rotationDelivery(rotation)),
      ),
    claim: (carrier, credential) =>
      resolveClaimed(carrier, credential).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      ),
  }) satisfies Scope;

/** A framework call (web `getSession`): its own memo identity; rotations are collected, never written here. */
export const collecting = Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<Rotation>>([]);
  const scope = {
    key: {},
    deliver: (rotation) => Ref.update(seen, (all) => [...all, rotation]),
    // A cookie-only call presents no claimable carrier; if one ever does, it is unclaimed.
    claim: () => Effect.succeedNone,
  } satisfies Scope;
  return { scope, rotations: Ref.get(seen) };
});
