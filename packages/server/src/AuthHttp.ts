// @awthaq/server — AuthHttp
//
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-085.
//
// `AuthHttp.routes`/`AuthHttp.docs` are direct re-exports of
// `HttpApiBuilder.layer`/`HttpApiScalar.layer` (not re-declared wrapper
// functions — re-declaring their generics independently loses the literal
// group-identifier precision `HttpApiGroup.ToService<Id, Groups>` needs,
// widening a group's own service type until `Layer.provide` can no longer
// match it) — awthaq's own composed `api` is registered and
// documented the same way any application's own `HttpApi` would be,
// requiring "no additional wiring step" (BEH-EA-083) beyond merging one
// more `Layer` into the same list an application already builds
// (`Layer.mergeAll(AuthHttp.routes(api, {openapiPath: "/openapi.json"}), AuthHttp.docs(api), AppRoutes)`).
// BEH-EA-085's two serving paths (`HttpRouter.serve`, `HttpRouter.toWebHandler`)
// and BEH-EA-087's `ManagedRuntime` escape hatch need no wrapper at all —
// they are ordinary `effect`/`effect/unstable/http` calls made against
// whatever `Layer` `AuthHttp.routes` (and an application's own handlers)
// produce; see `test/AuthHttp.test.ts` for both exercised end to end.

import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";
import * as Csrf from "./Csrf.ts";

/** BEH-EA-083/084: registers `api`'s routes with the ambient `HttpRouter`. */
export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;

/**
 * BEH-EA-084: serves generated OpenAPI/Scalar documentation from the same
 * `api` value `routes` registers — the two can never diverge, since both
 * read from the one `HttpApi` value a caller passes to each.
 */
export const docs: typeof HttpApiScalar.layer = HttpApiScalar.layer;

// The header `Authentication.ts` sets a rotated bearer token on. It is repeated
// here until the contract stratum owns one shared constant (CSS-007); a browser
// only lets a cross-origin caller read it if it is listed in `exposedHeaders`.
const ROTATED_TOKEN_HEADER = "set-auth-token";

export interface CorsOptions {
  /** Extra request headers a cross-origin caller may send, beyond `content-type`, the CSRF header and `authorization`. */
  readonly allowedHeaders?: ReadonlyArray<string>;
  /** Extra response headers a cross-origin caller may read, beyond the rotated-token header. */
  readonly exposedHeaders?: ReadonlyArray<string>;
  /** Seconds a browser may cache a preflight answer. */
  readonly maxAge?: number;
}

/**
 * AGA-002: awthaq ships **no CORS by default**. Without this layer no
 * cross-origin response carries an `Access-Control-Allow-Origin` header, so a
 * browser refuses to let another origin read any response: same-origin,
 * default-deny. `cors` is the supported way to open access to a separate SPA
 * origin, and its allowlist *is* `CsrfConfig.allowedOrigins`, the value the CSRF
 * origin check reads, so the edge policy and the CSRF policy cannot drift.
 *
 * Opening CORS never relaxes `CsrfProtection`: a cross-site mutation still
 * needs the double-submit pair. An empty allowlist opens nothing (Effect's own
 * `cors` would answer `*` for an empty list; a credentialed API must never).
 */
export const cors = (options?: CorsOptions) =>
  Layer.unwrap(
    Effect.map(Csrf.CsrfConfig, ({ allowedOrigins }) =>
      // `HttpMiddleware.cors` rather than `HttpRouter.cors`: only the former takes a
      // predicate, and given exactly one origin as a list Effect echoes it on every
      // response, allowed caller or not.
      HttpRouter.middleware(
        HttpMiddleware.cors({
          allowedOrigins: (origin) => allowedOrigins.includes(origin),
          credentials: true,
          allowedMethods: ["GET", "POST", "PATCH", "DELETE"],
          allowedHeaders: [
            "content-type",
            Api.CSRF_HEADER_NAME,
            "authorization",
            ...(options?.allowedHeaders ?? []),
          ],
          exposedHeaders: [ROTATED_TOKEN_HEADER, ...(options?.exposedHeaders ?? [])],
          maxAge: options?.maxAge,
        }),
        { global: true },
      ),
    ),
  );
