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
import * as Headers from "effect/unstable/http/Headers";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";
import * as Csrf from "./Csrf.ts";

/** BEH-EA-083/084: registers `api`'s routes with the ambient `HttpRouter`. */
export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;

/**
 * MW-001/EOTS-006 (wayfinder ticket 27 §1): Effect's own HTTP request tracer
 * (a W3C-`traceparent`-aware server span per request) and request logger
 * (structured `http.method`/`http.url`/`http.status` per request), re-exported
 * rather than re-implemented: the decision leaves logging and metrics backends
 * to the host. Wrap the served app once, at the composition point:
 * `AuthHttp.tracer(AuthHttp.requestLogger(app))`. An app already running its
 * own tracer/logger over the whole router must not add these (it would trace
 * and log every request twice). Pair with `layerRedactedHeaders` so no
 * credential header is logged.
 */
export const tracer: typeof HttpMiddleware.tracer = HttpMiddleware.tracer;
export const requestLogger: typeof HttpMiddleware.logger = HttpMiddleware.logger;

/**
 * BEH-EA-084: serves generated OpenAPI/Scalar documentation from the same
 * `api` value `routes` registers — the two can never diverge, since both
 * read from the one `HttpApi` value a caller passes to each.
 */
export const docs: typeof HttpApiScalar.layer = HttpApiScalar.layer;

/**
 * MAPS-008: Effect's default redacted header names (`authorization`,
 * `cookie`, `set-cookie`, `x-api-key`) do not include the rotated session
 * token (`Api.ROTATED_TOKEN_HEADER`, a long-lived secret) or `x-jwt-token`, so
 * any request logger or tracer built on `Headers.CurrentRedactedNames` would
 * log them verbatim. Provide this layer wherever HTTP requests/responses are
 * logged or traced; a host-supplied logger that does not read that reference
 * must redact these names itself.
 */
export const layerRedactedHeaders = Layer.succeed(Headers.CurrentRedactedNames, [
  ...Headers.CurrentRedactedNames.defaultValue(),
  Api.ROTATED_TOKEN_HEADER,
  "x-jwt-token",
]);

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
          exposedHeaders: [Api.ROTATED_TOKEN_HEADER, ...(options?.exposedHeaders ?? [])],
          maxAge: options?.maxAge,
        }),
        { global: true },
      ),
    ),
  );
