// @awthaq/organization — TenantResolver
//
// EP-001/ADR-EA-018: the application-provided port that says which organization
// a request is for. awthaq ships no routing convention (subdomain, path segment,
// header, custom domain) — "which host maps to which tenant" is deployment
// topology, so per ADR-EA-010 this plugin *requires* the port and the
// application provides it. `Organization.tenantMiddleware` calls it once per
// request; an application that never installs the middleware never needs it.
//
// A Host-header / custom-domain recipe (EP-005) needs no table until a real
// consumer wants one:
//
//   TenantResolver.layer((request) =>
//     Effect.map(lookupOrganizationIdByHost(request.headers["host"]), Option.fromNullOr))
//
// where `lookupOrganizationIdByHost` is the application's own data (a domain
// column on its own table, a config map, `organization.metadata`).

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

export interface TenantResolverShape {
  /** The organization id this request acts for, or `None` for an untenanted (platform / single-tenant) request. */
  readonly resolve: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<Option.Option<string>>;
}

export class TenantResolver extends Context.Service<TenantResolver, TenantResolverShape>()(
  "awthaq/organization/TenantResolver",
) {
  /** The visible, deliberate "every request is untenanted" choice — what wiring the middleware without routing means. */
  static readonly layerNone = Layer.succeed(
    TenantResolver,
    TenantResolver.of({ resolve: () => Effect.succeedNone }),
  );

  /** Wraps the application's own resolution function. */
  static readonly layer = (resolve: TenantResolverShape["resolve"]) =>
    Layer.succeed(TenantResolver, TenantResolver.of({ resolve }));
}
