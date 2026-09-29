// @awthaq/qadi — RequestDecisionCache
//
// Wayfinder ticket 12 (PCS-001/RZS-002), default half: qadi's `DecisionCache`
// is "safe against token downgrade and unsafe against backend revocation"
// when provided above request scope (see its own doc comment), and per-request
// scope is safe against both. qadi cannot pick that scope — it has no request
// boundary — but awthaq does: this middleware gives every request its own
// fresh cache, so a membership revoked between two requests is visible on the
// next one with no invalidation code to forget to wire. The opt-in
// alternative for an application-scoped cache is
// `DecisionCacheInvalidation.ts`.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { decisionCacheLayer } from "@qadi/core";

/**
 * Provides a fresh `DecisionCache` around each request's whole handler
 * pipeline ("around the unit of work" — `Effect.provide` at each evaluation
 * would build an empty cache every time and cache nothing). Works for both
 * bridge paths: declare it **last** on the group so it is outermost and
 * wraps `AuthorizedSubject` (Path A) or `RequirePermission` (Path B):
 *
 * ```ts
 * group
 *   .middleware(AuthorizedSubject)
 *   .middleware(Api.OptionalAuthentication)
 *   .middleware(RequestDecisionCache)
 * ```
 */
export class RequestDecisionCache extends HttpApiMiddleware.Service<RequestDecisionCache>()(
  "awthaq/qadi/RequestDecisionCache",
) {}

/**
 * `capacity` bounds a single request's cache; it is almost never needed, but
 * a request that evaluates thousands of distinct questions is bounded rather
 * than unbounded when it is set (`decisionCacheLayer` validates it).
 */
export const RequestDecisionCacheLive = (options?: { readonly capacity?: number }) => {
  const middleware: HttpApiMiddleware.HttpApiMiddleware<never, never, never> = (httpEffect) =>
    Effect.provide(httpEffect, decisionCacheLayer(options));
  return Layer.succeed(RequestDecisionCache, middleware);
};
