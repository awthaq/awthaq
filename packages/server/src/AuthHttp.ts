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
import type {
  Accounts,
  AuthEvents,
  DataExport,
  Erasure,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import type { RateLimiter, SqlTransaction } from "@awthaq/ports";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";
import * as Account from "./Account.ts";
import * as Authentication from "./Authentication.ts";
import * as Csrf from "./Csrf.ts";
import * as Session from "./Session.ts";

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
 * The domain services `coreHandlers` needs, beside the `Api.Authentication`/
 * `Api.CsrfProtection` implementations the two groups' middleware declare.
 * Named so `coreHandlers`'s inferred type stays portable for declaration emit
 * (TS2883), the way `Account.AccountPrincipal` does for its module. Account
 * erasure and export (CSG-001/CSG-005) are core services the `account` group's
 * handlers call, and the export endpoint is rate limited per account.
 */
export type CoreHandlerServices =
  | Accounts.Accounts
  | AuthEvents.AuthEvents
  | Sessions.Sessions
  | Users.Users
  | Verification.Verification
  | DataExport.AccountExport
  | Erasure.AccountErasure
  | RateLimiter.RateLimiter
  | RateLimits.RateLimitsRegistry
  | SqlTransaction.SqlTransaction;

/**
 * MW-002 (wayfinder ticket 26): the handlers for the `session` and `account`
 * groups `Auth.make(...).api` always carries. Merge this beside the composed
 * `layer` wherever `routes(built.api)` is served; a composition that leaves it
 * out fails at layer build (missing group service), not as a silent 404.
 */
export const coreHandlers = Layer.mergeAll(Session.SessionHandlers, Account.AccountHandlers);

/**
 * Plan 08 (BEH-EA-T1): the five host middleware `@awthaq/server` implements. A plugin's contract declares
 * which of them its groups need (`.middleware(Api.Authentication)`); `middlewareFor` builds exactly those.
 */
export type HostMiddleware =
  | Api.Authentication
  | Api.OptionalAuthentication
  | Api.MachineAuthentication
  | Api.AdminAuthentication
  | Api.CsrfProtection;

/** Plan 08: the host middleware the groups of a contract declare (group and endpoint middleware, merged). */
export type DeclaredMiddleware<Groups extends HttpApiGroup.Constraint> = Extract<
  HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<Groups>>,
  HostMiddleware
>;

export interface MiddlewareOptions<CE, CR, PR> {
  /** The CSRF secret and allowed origins (`Csrf.layerConfig` in production, a fixed test config in `TestAuth`). */
  readonly csrf: Layer.Layer<Csrf.CsrfConfig, CE, CR>;
  /** Defaults to `Authentication.PrincipalResolverLive`; `PrincipalResolverWithUserFactsLive` opts into `emailVerified`. */
  readonly principalResolver?: Layer.Layer<Authentication.PrincipalResolver, never, PR>;
}

/**
 * Plan 08 (BEH-EA-T1): the host middleware a composed api declares, as one layer. The type and the runtime
 * agree: `ROut` is exactly the declared host middleware, and the walk over the api builds exactly those, so
 * a plugin layer needing host middleware for some other reason stays in `RIn` and fails to compile instead
 * of being silently absent. Plugin-owned middleware (`ScimAuthentication`, qadi's `AuthorizedSubject`) is not
 * host middleware and is never derived. `AdminAuthentication` gets its own `Authentication` internally, so an
 * admin-only composition works. `CredentialResolvers` is not built here: `Authentication` reads it through
 * `Effect.serviceOption`, so the host provides one registry beneath both the plugins that contribute and the
 * middleware that reads.
 */
export function middlewareFor<
  Groups extends HttpApiGroup.Constraint,
  CE = never,
  CR = never,
  PR = never,
>(
  api: HttpApi.HttpApi<"auth", Groups>,
  options: MiddlewareOptions<CE, CR, PR>,
): Layer.Layer<DeclaredMiddleware<Groups>, CE, Sessions.Sessions | Crypto.Crypto | CR | PR>;
export function middlewareFor(
  api: HttpApi.HttpApi<"auth", HttpApiGroup.Constraint>,
  options: MiddlewareOptions<unknown, unknown, unknown>,
): Layer.Layer<never, unknown, unknown> {
  const declared = new Set<string>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ middleware }) => {
      for (const service of middleware) declared.add(service.key);
    },
  });
  const resolver = options.principalResolver ?? Authentication.PrincipalResolverLive;
  // `Layer.fresh`: the module-level `...Live` constants are memoized by reference, so a host (or a test) that
  // builds one itself, over its own config, in the same composition would otherwise share whichever instance
  // was built first. The derived middleware is its own instance, and what a `services` layer provides wins
  // for the plugins by position, not by an accident of build order.
  const user = Layer.fresh(Authentication.AuthenticationLive).pipe(Layer.provide(resolver));
  // `Layer`'s `ROut` is contravariant, so `never` is what the slot accepts from any one middleware layer.
  const entry = (key: string, layer: Layer.Layer<never, unknown, unknown>) => ({ key, layer });
  const table = [
    entry(Api.Authentication.key, user),
    entry(
      Api.OptionalAuthentication.key,
      Layer.fresh(Authentication.OptionalAuthenticationLive).pipe(Layer.provide(resolver)),
    ),
    entry(
      Api.MachineAuthentication.key,
      Layer.fresh(Authentication.MachineAuthenticationLive).pipe(Layer.provide(resolver)),
    ),
    entry(
      Api.AdminAuthentication.key,
      Layer.fresh(Authentication.AdminAuthenticationLive).pipe(Layer.provide(user)),
    ),
    entry(
      Api.CsrfProtection.key,
      Layer.fresh(Csrf.CsrfProtectionLive).pipe(Layer.provide(options.csrf)),
    ),
  ];
  return table.reduce<Layer.Layer<never, unknown, unknown>>(
    (acc, entry) => (declared.has(entry.key) ? Layer.merge(acc, entry.layer) : acc),
    Layer.empty,
  );
}

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
