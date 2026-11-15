// @awthaq/server — internal PrincipalResolver
//
// BEH-EA-069, APS-007: the principal resolver, one of the internal modules behind `Credentials.ts`.

import { Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
