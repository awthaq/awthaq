// @awthaq/qadi — Resolvers and obligation handlers
//
// spec/behaviors/21-qadi-resolvers-obligations.md, BEH-EA-161, BEH-EA-165.
//
// **What is deliberately not here, and why:**
// - BEH-EA-162 (`Organization.relationships`) belongs to the `Organization`
//   plugin (M7), which does not exist yet — nothing to build in this
//   package for it.
// - BEH-EA-163 (`relationshipResolverFromEdges`) is `@qadi/core`'s own
//   export, used directly; there is nothing awthaq-specific to wrap.
// - BEH-EA-164 (`DecisionHistory` backed by audit events) needs a durable
//   audit-event table this repository does not have — no `AuditLog`
//   service exists anywhere in `@awthaq/core` yet. Building one only
//   to satisfy this resolver would be exactly the kind of speculative
//   infrastructure this project avoids (the same reasoning `WebAuthn`'s
//   deferred port interface documents).
// - BEH-EA-166/167/168 (SQL pushdown via `toPredicate`/`compileSql`, sink
//   wiring, the guarded devtools decision stream) are all direct,
//   already-working uses of `@qadi/predicate-sql`/`@qadi/audit`/
//   `@qadi/devtools` an application wires itself — application-level usage
//   patterns, not something this bridge package ships.
import { Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Obligation, ObligationHandler } from "@qadi/core";
import { AttributeResolver, obligation } from "@qadi/core";

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
 * `Users.findById` itself has no distinguishable "the store is down" error
 * separate from `UserNotFound` today, so there is no genuine outage this
 * resolver could report through `AttributeResolveError` even if it wanted
 * to; a real SQL outage would surface as an unhandled defect, not a typed
 * failure caught here — a real, open gap, not a swallowed one.
 */
/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 14
 * (AAPS-002): the attribute names `UserAttributes` actually answers,
 * declared alongside the `Layer` itself so a composing application's own
 * `AttributeResolvers.attributeResolverRegistry` call never hand-copies a
 * list that can drift from `resolve`'s own `switch` below.
 */
export const UserAttributeNames = ["email", "emailVerified", "name"] as const;

export const UserAttributes: Layer.Layer<AttributeResolver, never, Users.Users> = Layer.effect(
  AttributeResolver,
  Effect.gen(function* () {
    const users = yield* Users.Users;
    return {
      name: "awthaq/UserAttributes",
      resolve: (subjectId, attribute) => {
        if (!subjectId.startsWith(USER_SUBJECT_PREFIX)) {
          return Effect.succeed(undefined);
        }
        const userId = Users.UserId(subjectId.slice(USER_SUBJECT_PREFIX.length));
        return users.findById(userId).pipe(
          Effect.map((user): unknown => {
            switch (attribute) {
              case "email":
                return user.email;
              case "emailVerified":
                return user.emailVerified;
              case "name":
                return user.name;
              default:
                return undefined;
            }
          }),
          Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)),
        );
      },
    };
  }),
);

/** BEH-EA-165: the duty a `changeEmail`-shaped handler obliges its caller to. */
export const REAUTH_OBLIGATION_ID = "awthaq/reauth";

/** Builds the `reauth` obligation, e.g. `obliged(reauth(300), hasPermission(...))`. */
export const reauth = (maxAgeSeconds: number): Obligation =>
  obligation(REAUTH_OBLIGATION_ID, { maxAgeSeconds });

/** BEH-EA-165: the client maps this to a "confirm your password" prompt. */
export class ReauthRequired extends Data.TaggedError("ReauthRequired")<{
  readonly maxAgeSeconds: number;
}> {}

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
const reauthHandler: ObligationHandler<ReauthRequired, Api.CurrentPrincipal | Sessions.Sessions> = (
  obligations,
) =>
  Effect.gen(function* () {
    for (const duty of obligations) {
      if (duty.id !== REAUTH_OBLIGATION_ID) {
        return yield* Effect.die(
          new Error(`awthaq: ObligationHandlers.reauth cannot discharge obligation "${duty.id}"`),
        );
      }
    }
    const maxAgeSeconds = obligations
      .map((duty) => duty.attributes["maxAgeSeconds"])
      .find((value): value is number => typeof value === "number");
    if (maxAgeSeconds === undefined) return;

    const principal = yield* Api.CurrentPrincipal;
    if (principal._tag !== "User") {
      return yield* Effect.fail(new ReauthRequired({ maxAgeSeconds }));
    }
    const sessions = yield* Sessions.Sessions;
    const userId = Users.UserId(principal.ref.id);
    const sessionId = Sessions.SessionId(principal.sessionId);
    // TIR-003: a keyed lookup, not `list` + `find` (a paginated list could
    // omit the caller's own current session).
    const current = yield* sessions.findOwned(userId, sessionId);
    if (Option.isNone(current)) {
      return yield* Effect.fail(new ReauthRequired({ maxAgeSeconds }));
    }
    const now = yield* DateTime.now;
    if (Sessions.isStale(current.value.authenticatedAt, maxAgeSeconds, now)) {
      return yield* Effect.fail(new ReauthRequired({ maxAgeSeconds }));
    }
  });

export const ObligationHandlers = { reauth: reauthHandler };
