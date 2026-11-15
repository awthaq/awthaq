// The resolution engine and the `Scope` seam types (ADR-EA-042 decisions 1, 2 and 5), with the per-request
// memo tables beside `make`. One of the internal modules behind `../Credentials.ts`.

import { Observability, Sessions } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import type { ClaimCarrier } from "./CredentialResolvers.ts";
import { PrincipalResolver } from "./PrincipalResolver.ts";
import type { Carrier, Presented, SessionCarrier, Tier } from "./Presented.ts";

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
