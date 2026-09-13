// @effect-auth/server — AuthHttp
//
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-085.
//
// `AuthHttp.routes`/`AuthHttp.docs` are direct re-exports of
// `HttpApiBuilder.layer`/`HttpApiScalar.layer` (not re-declared wrapper
// functions — re-declaring their generics independently loses the literal
// group-identifier precision `HttpApiGroup.ToService<Id, Groups>` needs,
// widening a group's own service type until `Layer.provide` can no longer
// match it) — effect-auth's own composed `api` is registered and
// documented the same way any application's own `HttpApi` would be,
// requiring "no additional wiring step" (BEH-EA-083) beyond merging one
// more `Layer` into the same list an application already builds
// (`Layer.mergeAll(AuthHttp.routes(api, {openapiPath: "/openapi.json"}), AuthHttp.docs(api), AppRoutes)`).
// BEH-EA-085's two serving paths (`HttpRouter.serve`, `HttpRouter.toWebHandler`)
// and BEH-EA-087's `ManagedRuntime` escape hatch need no wrapper at all —
// they are ordinary `effect`/`effect/unstable/http` calls made against
// whatever `Layer` `AuthHttp.routes` (and an application's own handlers)
// produce; see `test/AuthHttp.test.ts` for both exercised end to end.

import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";

/** BEH-EA-083/084: registers `api`'s routes with the ambient `HttpRouter`. */
export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;

/**
 * BEH-EA-084: serves generated OpenAPI/Scalar documentation from the same
 * `api` value `routes` registers — the two can never diverge, since both
 * read from the one `HttpApi` value a caller passes to each.
 */
export const docs: typeof HttpApiScalar.layer = HttpApiScalar.layer;
