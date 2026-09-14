// @awthaq/qadi — AuthorizedSubject (Path A)
//
// spec/behaviors/19-qadi-bridge-path-a.md, BEH-EA-145.
//
// The entire Path A bridge: one middleware that hands every handler in its
// group qadi's `CurrentSubject` — resolved via `SubjectResolver` from
// `CurrentPrincipal` — without the handler doing any resolution itself.
// BEH-EA-146 through 152 (`check`/`decide`/`assert`/`enforce`/
// `enforceProjected`/`filter`/`filterStream`/`guard`/`addGuardedRoute`, the
// "hide denied as 404"/"outages stay 5xx" handler patterns) are all
// `@qadi/core`/`@qadi/http` calls a handler makes once `CurrentSubject` is in
// its environment — nothing in this package reimplements them; there is
// nothing awthaq-specific to build for those behaviors beyond this one
// middleware providing the subject they all read.
//
// **Group `.middleware()` call order — verified empirically, and the
// opposite of what a naive reading of "list Authentication before it"
// suggests.** `HttpApiGroup.middleware`/`HttpApiBuilder`'s own
// `applyMiddleware` folds an endpoint's middlewares in *declaration* order,
// each one wrapping the effect accumulated so far — so the *last*-declared
// middleware ends up *outermost* and runs *first*, calling into the
// previously-accumulated (now inner) effect only once its own body reaches
// that point. A first attempt at `AuthorizedSubject.test.ts` wrote
// `.middleware(Authentication).middleware(AuthorizedSubject)` — the textual
// order BEH-EA-145's own prose reads most naturally — and failed at runtime
// with "Service not found: CurrentPrincipal", because that declaration order
// makes `AuthorizedSubject` outermost, running *before* `Authentication` has
// provided anything. The correct call order to get `Authentication` to run
// first is `.middleware(AuthorizedSubject).middleware(Authentication)` —
// `Authentication`/`OptionalAuthentication` declared *last*, so it wraps
// (and therefore runs *before*) `AuthorizedSubject`. `AuthorizedSubject.test.ts`
// uses this order, confirmed passing.
import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { CurrentSubject } from "@qadi/core";
import { SubjectResolver } from "./SubjectResolver.ts";

/**
 * BEH-EA-145: requires `CurrentPrincipal`, provides qadi's `CurrentSubject`.
 * `requires` is declared explicitly (unlike `@qadi/http`'s own
 * `RequirePermission`, which sets `requires: never` and resolves its
 * standing dependencies at layer-build time instead — see that class's own
 * doc comment on why a self-referential middleware's `requires` field is
 * otherwise unreadable through `HttpApiMiddleware.ApplyServices`): here the
 * dependency is `CurrentPrincipal`, a genuinely *per-request* value
 * `Authentication`/`OptionalAuthentication` provide earlier in the same
 * chain, not a build-time service `AuthorizedSubjectLive` could resolve once
 * and close over — so it has to be declared, not hidden.
 */
export class AuthorizedSubject extends HttpApiMiddleware.Service<
  AuthorizedSubject,
  { provides: CurrentSubject; requires: Api.CurrentPrincipal }
>()("awthaq/qadi/AuthorizedSubject") {}

/**
 * `SubjectResolver` is a `Context.Reference` (a slot with a fail-closed
 * default, ADR-EA-012) — like `Sessions.ts`'s own `SessionConfig`, it is
 * satisfied by its default the moment it is yielded and never appears in a
 * consuming `Layer`'s `RIn`, so this layer's only real requirement is none
 * at all unless some other plugin (`@awthaq/roles`) overrides it.
 */
export const AuthorizedSubjectLive: Layer.Layer<AuthorizedSubject> = Layer.effect(
  AuthorizedSubject,
  Effect.gen(function* () {
    const resolver = yield* SubjectResolver;
    const middleware: HttpApiMiddleware.HttpApiMiddleware<
      CurrentSubject,
      never,
      Api.CurrentPrincipal
    > = Effect.fnUntraced(function* (httpEffect) {
      const principal = yield* Api.CurrentPrincipal;
      const subject = yield* resolver.resolve(principal);
      return yield* Effect.provideService(httpEffect, CurrentSubject, subject);
    });
    return middleware;
  }),
);
