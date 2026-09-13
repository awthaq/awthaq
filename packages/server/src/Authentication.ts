// @effect-auth/server — Authentication middleware
//
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
// Implements the `Authentication`/`OptionalAuthentication` declarations from
// `@effect-auth/api`'s `Api.ts` against `@effect-auth/core`'s `Sessions`.

import { Sessions } from "@effect-auth/core";
import { Api } from "@effect-auth/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpApiMiddleware } from "effect/unstable/httpapi";

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
  "effect-auth/server/PrincipalResolver",
) {}

/** The ordinary case: a session resolves to the `UserPrincipal` it belongs to. */
export const PrincipalResolverLive: Layer.Layer<PrincipalResolver> = Layer.succeed(
  PrincipalResolver,
  {
    resolve: (session) =>
      Effect.succeed(
        new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: session.userId }),
          sessionId: session.id,
        }),
      ),
  },
);

/**
 * BEH-EA-069/070: shared by both `Authentication` and `OptionalAuthentication`
 * — an empty credential (BEH-EA-065's cookie/bearer schemes decode to `""`
 * when the request carries neither, never a decode failure) and an invalid
 * or expired session are both reported as `Unauthenticated`, uniformly.
 *
 * Exported (not module-private) so `@effect-auth/qadi`'s `SubjectExtractor.ts`
 * (BEH-EA-153) can call the identical hash-comparison/expiry logic this
 * middleware uses, rather than reimplementing it against the raw request —
 * BEH-EA-153 requires exactly that reuse.
 */
export const resolvePrincipal = (
  sessions: Sessions.SessionsShape,
  resolver: PrincipalResolverShape,
  credential: Redacted.Redacted<string>,
): Effect.Effect<Api.Principal, Api.Unauthenticated> => {
  const raw = Redacted.value(credential);
  if (raw === "") {
    return Effect.fail(new Api.Unauthenticated());
  }
  return sessions.verify(Redacted.make(raw)).pipe(
    Effect.mapError(() => new Api.Unauthenticated()),
    Effect.flatMap(resolver.resolve),
  );
};

/** BEH-EA-065 through 067/070: fails `Unauthenticated` only once every declared scheme has. */
export const AuthenticationLive: Layer.Layer<
  Api.Authentication,
  never,
  Sessions.Sessions | PrincipalResolver
> = Layer.effect(
  Api.Authentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions.Sessions;
    const resolver = yield* PrincipalResolver;
    const handle: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
      Api.CurrentPrincipal,
      typeof Api.Unauthenticated,
      never
    >["cookie"] = (httpEffect, { credential }) =>
      resolvePrincipal(sessions, resolver, credential).pipe(
        Effect.flatMap((principal) =>
          Effect.provideService(httpEffect, Api.CurrentPrincipal, principal),
        ),
      );
    return { cookie: handle, bearer: handle };
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
    const cookie: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
      Api.CurrentPrincipal,
      typeof Api.Unauthenticated,
      never
    >["cookie"] = (httpEffect, { credential }) =>
      resolvePrincipal(sessions, resolver, credential).pipe(
        Effect.flatMap((principal) =>
          Effect.provideService(httpEffect, Api.CurrentPrincipal, principal),
        ),
      );
    const bearer: typeof cookie = (httpEffect, { credential }) =>
      resolvePrincipal(sessions, resolver, credential).pipe(
        Effect.catchTag("Unauthenticated", () => Effect.succeed(Api.anonymousPrincipal)),
        Effect.flatMap((principal) =>
          Effect.provideService(httpEffect, Api.CurrentPrincipal, principal),
        ),
      );
    return { cookie, bearer };
  }),
);
