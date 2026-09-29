// @awthaq/qadi — Resolvers and obligation handlers
//
// spec/behaviors/21-qadi-resolvers-obligations.md, BEH-EA-161, BEH-EA-165.
//
// **What is deliberately not here, and why:**
// - BEH-EA-162 (`Organization.relationships`) belongs to the `Organization`
//   plugin (`@awthaq/organization`'s `OrganizationQadi.ts`) — nothing to
//   build in this package for it.
// - BEH-EA-163 (`relationshipResolverFromEdges`) is `@qadi/core`'s own
//   export, used directly; there is nothing awthaq-specific to wrap.
// - BEH-EA-164 (`DecisionHistory` backed by audit events) is a follow-up, not
//   an impossibility: `@awthaq/core`'s `AuditLog` (durable `auth_audit_log`)
//   now exists and `DecisionLogging.ts` writes denials into it, so a
//   `DecisionHistory` reading them back is buildable — it just has no
//   consumer yet, and this package does not ship infrastructure ahead of one.
// - BEH-EA-166/167/168 (SQL pushdown via `toPredicate`/`compileSql`, sink
//   wiring, the guarded devtools decision stream) are all direct,
//   already-working uses of `@qadi/predicate-sql`/`@qadi/audit`/
//   `@qadi/devtools` an application wires itself — application-level usage
//   patterns, not something this bridge package ships.
import { Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { Obligation, ObligationHandler } from "@qadi/core";
import { AttributeResolver, AttributeResolveError, obligation } from "@qadi/core";

const USER_SUBJECT_PREFIX = "user:";

/**
 * BEH-EA-161: backed by `Users`, mapping only the attributes a `UserRecord`
 * actually carries (`email`, `emailVerified`, `name` — there is no `plan`
 * field on `UserRecord`, unlike the spec's own illustrative example, so this
 * resolves what really exists rather than a fabricated one). `undefined`
 * covers three legitimate "no opinion" cases uniformly: a non-`user:`
 * subject (this resolver only has an opinion on subjects `SubjectResolver`
 * itself minted), an attribute name it does not recognize, and a subject
 * whose user has since been deleted (`UserNotFound`) — none of these is an
 * infrastructure failure, so none maps to `AttributeResolveError`.
 *
 * `@qadi/core`'s current `AttributeResolveError` carries only `attribute`
 * and `cause` (no `subjectId`, unlike the spec's own illustrative code
 * block) — this resolver is written against that real, installed shape.
 *
 * TS-002: a `Users` outage (`Users.findById` `orDie`s a store failure, so it
 * surfaces as a defect, distinct from `UserNotFound`) is mapped here to
 * `AttributeResolveError` naming the attribute — the resolver itself tells
 * "source down" from "no opinion" (REQ-EA-452/453) instead of leaning on
 * `@qadi/core`'s own defect backstop (`catchPortDefect`), which would catch
 * it too but only as an anonymous port failure.
 *
 * AAPS-004: the user record is memoized *per request*, so a policy reading
 * `email` and `emailVerified` costs one `Users.findById`, not one per
 * attribute. Never across requests (no staleness, no invalidation to wire):
 * the memo is keyed by the ambient `HttpServerRequest`'s identity — the same
 * per-request key `Authentication.ts`'s session-resolution cache uses, one
 * both bridges have — and outside an HTTP request there is no memo at all.
 */
/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 14
 * (AAPS-002): the attribute names `UserAttributes` actually answers,
 * declared alongside the `Layer` itself so a composing application's own
 * `AttributeResolvers.attributeResolverRegistry` call never hand-copies a
 * list that can drift from `resolve`'s own `switch` below.
 */
export const UserAttributeNames = ["email", "emailVerified", "name"] as const;

type UserLookup = Effect.Effect<Option.Option<Users.UserRecord>, AttributeResolveError>;

/** One request's memoized lookups, by user id (see `UserAttributes`' doc comment). */
const userLookupsByRequest = new WeakMap<
  HttpServerRequest.HttpServerRequest,
  Ref.Ref<HashMap.HashMap<Users.UserId, UserLookup>>
>();

export const UserAttributes: Layer.Layer<AttributeResolver, never, Users.Users> = Layer.effect(
  AttributeResolver,
  Effect.gen(function* () {
    const users = yield* Users.Users;

    const lookup = (userId: Users.UserId, attribute: string): UserLookup =>
      users.findById(userId).pipe(
        Effect.map(Option.some),
        // A deleted user stays "no opinion" (as documented); only a genuine
        // outage (a defect) becomes a typed failure naming the attribute.
        Effect.catchTag("UserNotFound", () => Effect.succeed(Option.none<Users.UserRecord>())),
        Effect.catchDefect((cause) => Effect.fail(new AttributeResolveError({ attribute, cause }))),
      );

    const memoizedLookup = (userId: Users.UserId, attribute: string): UserLookup =>
      Effect.gen(function* () {
        const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
        if (Option.isNone(request)) return yield* lookup(userId, attribute);
        const cache = yield* Option.fromNullishOr(userLookupsByRequest.get(request.value)).pipe(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Ref.make(HashMap.empty<Users.UserId, UserLookup>()).pipe(
                Effect.tap((ref) => Effect.sync(() => userLookupsByRequest.set(request.value, ref))),
              ),
          }),
        );
        const existing = HashMap.get(yield* Ref.get(cache), userId);
        if (Option.isSome(existing)) return yield* existing.value;
        const memoized = yield* Effect.cached(lookup(userId, attribute));
        yield* Ref.update(cache, HashMap.set(userId, memoized));
        return yield* memoized;
      });

    return {
      name: "awthaq/UserAttributes",
      resolve: (subjectId, attribute) => {
        if (!subjectId.startsWith(USER_SUBJECT_PREFIX)) {
          return Effect.succeed(undefined);
        }
        const userId = Users.UserId(subjectId.slice(USER_SUBJECT_PREFIX.length));
        return memoizedLookup(userId, attribute).pipe(
          Effect.map((found): unknown => {
            if (Option.isNone(found)) return undefined;
            switch (attribute) {
              case "email":
                return found.value.email;
              case "emailVerified":
                return found.value.emailVerified;
              case "name":
                return found.value.name;
              default:
                return undefined;
            }
          }),
        );
      },
    };
  }),
);

/** BEH-EA-165: the duty a `changeEmail`-shaped handler obliges its caller to. */
export const REAUTH_OBLIGATION_ID = "awthaq/reauth";

/**
 * Builds the `reauth` obligation, e.g. `obliged(reauth(300), hasPermission(...))`.
 * TS-001: refuses (throws, at authoring time) a `maxAgeSeconds` the handler
 * could not interpret — non-finite or negative — so a malformed obligation
 * cannot be authored through the helper.
 */
export const reauth = (maxAgeSeconds: number): Obligation => {
  if (!isValidMaxAge(maxAgeSeconds)) {
    throw new Error(
      `awthaq: reauth(maxAgeSeconds) needs a finite, non-negative number, got ${String(maxAgeSeconds)}`,
    );
  }
  return obligation(REAUTH_OBLIGATION_ID, { maxAgeSeconds });
};

const isValidMaxAge = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * BEH-EA-165 (EEM-005): re-exported from `@awthaq/api` under its old name —
 * the shared, wire-decodable error (`Schema.TaggedError`, 403) the client maps
 * to a "confirm your password" prompt. A Path A endpoint enforcing a policy
 * with `reauth(...)` declares `Api.ReauthRequired` in its `error:` array.
 * Path B (`RequirePermission`) keeps qadi's own `UndischargedObligation`
 * mapping (BEH-EA-160): it cannot carry this error, and says so.
 */
export const ReauthRequired = Api.ReauthRequired;
export type ReauthRequired = Api.ReauthRequired;

/**
 * BEH-EA-165: reads `CurrentPrincipal`'s session and compares its
 * `authenticatedAt` (wayfinder map .scratch/resolve-ready-for-human-findings,
 * ticket 15 — AAPS-001: "when this session last *proved* a credential,"
 * set at `issue` and advanced only by `Sessions.reauthenticate`, never by
 * idle refresh/rotation, unlike `createdAt` this handler used to compare
 * instead) to the obligation's own `maxAgeSeconds` via `Sessions.isStale`.
 * A stale session fails with `ReauthRequired`, never silently passes
 * because it happens to still be live; `@awthaq/password`'s
 * `POST /password/reauthenticate` and `@awthaq/passkey`'s
 * `POST /passkey/reauthenticate/*` are this obligation's real discharge
 * paths — each re-proves the session's own credential and calls
 * `Sessions.reauthenticate` on success.
 *
 * Applies only to the `awthaq/reauth` obligation id; a binding
 * obligation with any other id reaching this handler is a wiring mistake
 * (a policy paired with the wrong `onObligations` handler) and fails loudly
 * rather than being silently discharged unexamined.
 */
const reauthHandler: ObligationHandler<
  Api.ReauthRequired,
  Api.CurrentPrincipal | Sessions.Sessions
> = (obligations) =>
  Effect.gen(function* () {
    for (const duty of obligations) {
      if (duty.id !== REAUTH_OBLIGATION_ID) {
        return yield* Effect.die(
          new Error(`awthaq: ObligationHandlers.reauth cannot discharge obligation "${duty.id}"`),
        );
      }
    }
    if (obligations.length === 0) return;
    // TS-001: every duty must carry an interpretable window — a malformed one
    // is a policy-authoring/wiring error and fails loudly instead of being
    // silently discharged; among valid duties the strictest (smallest) wins.
    const windows: Array<number> = [];
    for (const duty of obligations) {
      const value = duty.attributes["maxAgeSeconds"];
      if (!isValidMaxAge(value)) {
        return yield* Effect.die(
          new Error(
            "awthaq: reauth obligation is missing a finite, non-negative numeric maxAgeSeconds",
          ),
        );
      }
      windows.push(value);
    }
    const maxAgeSeconds = Math.min(...windows);

    const principal = yield* Api.CurrentPrincipal;
    if (principal._tag !== "User") {
      return yield* Effect.fail(new Api.ReauthRequired({ maxAgeSeconds }));
    }
    const sessions = yield* Sessions.Sessions;
    const userId = Users.UserId(principal.ref.id);
    const sessionId = Sessions.SessionId(principal.sessionId);
    const items = yield* sessions.list(userId, sessionId);
    const current = items.find((item) => item.id === sessionId);
    if (current === undefined) {
      return yield* Effect.fail(new Api.ReauthRequired({ maxAgeSeconds }));
    }
    const now = yield* DateTime.now;
    if (Sessions.isStale(current.authenticatedAt, maxAgeSeconds, now)) {
      return yield* Effect.fail(new Api.ReauthRequired({ maxAgeSeconds }));
    }
  });

export const ObligationHandlers = { reauth: reauthHandler };
