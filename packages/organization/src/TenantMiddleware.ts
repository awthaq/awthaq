// @awthaq/organization — TenantMiddleware
//
// EP-001/EP-007/BEH-EA-229/231 (ADR-EA-018): `Organization.tenantMiddleware`, the opt-in
// global router middleware that turns "which organization is this request for"
// (the application's `TenantResolver`) into the ambient `TenantContext` for
// the rest of the request's fiber. Nothing installs it automatically: an
// application that never wires it sees `Option.none()` everywhere, exactly as before.
//
// An id the resolver returns that names no organization is refused (404, the
// same `{ _tag, message }` body the typed API errors use), never run untenanted:
// a typo'd subdomain must not silently fall through to the platform's own data.
// A *suspended* organization still resolves — its requests reach the plugin's
// own gate, which refuses them (EP-003) — so the sign-in page of a suspended
// tenant can say so.
//
// Two independent options, so four layers (each is a few lines; they cannot share a
// generic wrapper because a router middleware's request type is concrete):
//
// - `…WithRls` also runs each tenanted request inside `TenantScope.withTenant`, so
//   on Postgres with `TenantScope.enableRls()` the whole request is confined to its
//   tenant at the database — one transaction per tenanted request, hence separate.
// - `…WithConfig(TenantConfig)` also provides that tenant's configuration layers
//   for the request (BEH-EA-231, ADR-EA-005's `LayerMap.Service` seam). `TenantConfig`
//   is the application's own `LayerMap.Service` keyed by tenant id, whose `lookup`
//   returns the tenant's `Organization.config(...)`/… layers; a plugin that decides
//   its configuration per operation (`Organization` does) then behaves per tenant
//   inside one composition.

import { Tenant } from "@awthaq/ports";
import { TenantScope } from "@awthaq/sql";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as TenantResolver from "./TenantResolver.ts";

/** The application's per-tenant configuration map: a `LayerMap.Service` keyed by tenant id whose layers provide plugin configuration. */
export type TenantConfigTag<Self> = Context.Service<
  Self,
  LayerMap.LayerMap<string, Tenant.TenantConfigApplied, never>
>;

const unknownTenant = () =>
  HttpServerResponse.jsonUnsafe(
    { _tag: "OrganizationNotFound", message: "awthaq: no such organization" },
    { status: 404 },
  );

/** Resolves the request's organization; fails `"unknown-tenant"` when the resolver names none that exists. */
const resolveTenant = Effect.gen(function* () {
  const resolver = yield* TenantResolver.TenantResolver;
  const orgs = yield* OrganizationRecords.OrganizationRecords;
  return (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const resolved = yield* resolver.resolve(request);
      if (Option.isNone(resolved)) return Option.none<string>();
      const found = yield* orgs.findById(resolved.value);
      return Option.isSome(found) ? resolved : yield* Effect.fail("unknown-tenant" as const);
    });
});

const isUnknownTenant = (failure: unknown): failure is "unknown-tenant" =>
  failure === "unknown-tenant";

export const layer = HttpRouter.middleware(
  Effect.gen(function* () {
    const resolveFor = yield* resolveTenant;
    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const tenant = yield* resolveFor(request);
        return yield* Option.match(tenant, {
          onNone: () => app,
          onSome: (id) => Tenant.withTenant(id)(app),
        });
      }).pipe(Effect.catchIf(isUnknownTenant, () => Effect.succeed(unknownTenant())));
  }),
  { global: true },
);

export const layerWithRls = HttpRouter.middleware(
  Effect.gen(function* () {
    const resolveFor = yield* resolveTenant;
    // Captured at layer build so it is a layer requirement, not a per-request one.
    const sql = yield* SqlClient.SqlClient;
    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const tenant = yield* resolveFor(request);
        return yield* Option.match(tenant, {
          onNone: () => app,
          // An infrastructure failure of the tenant transaction is a defect, not a typed API error.
          onSome: (id) =>
            TenantScope.withTenant(id)(app).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catchTag("SqlError", Effect.die),
            ),
        });
      }).pipe(Effect.catchIf(isUnknownTenant, () => Effect.succeed(unknownTenant())));
  }),
  { global: true },
);

/** As `layer`, plus the tenant's configuration layers from the application's `TenantConfig` for the request. */
export const layerWithConfig = <Self>(tenantConfig: TenantConfigTag<Self>) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const resolveFor = yield* resolveTenant;
      const configs = yield* tenantConfig;
      return (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const tenant = yield* resolveFor(request);
          return yield* Option.match(tenant, {
            onNone: () => app,
            onSome: (id) => Tenant.withTenant(id)(app).pipe(Effect.provide(configs.get(id))),
          });
        }).pipe(Effect.catchIf(isUnknownTenant, () => Effect.succeed(unknownTenant())));
    }),
    { global: true },
  );

/** Both: the request is confined to its tenant at the database and runs under the tenant's configuration. */
export const layerWithConfigAndRls = <Self>(tenantConfig: TenantConfigTag<Self>) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const resolveFor = yield* resolveTenant;
      const configs = yield* tenantConfig;
      const sql = yield* SqlClient.SqlClient;
      return (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const tenant = yield* resolveFor(request);
          return yield* Option.match(tenant, {
            onNone: () => app,
            onSome: (id) =>
              TenantScope.withTenant(id)(app).pipe(
                Effect.provide(configs.get(id)),
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.catchTag("SqlError", Effect.die),
              ),
          });
        }).pipe(Effect.catchIf(isUnknownTenant, () => Effect.succeed(unknownTenant())));
    }),
    { global: true },
  );
