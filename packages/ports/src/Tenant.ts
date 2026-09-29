// @awthaq/ports — Tenant
//
// DRS-001/EP-001 (wayfinder ticket 18, ADR-EA-018): the ambient tenant. A
// tenant is an `Organization` row, but core cannot import the organization
// plugin (plugins depend on core, never the reverse), so the key is an opaque,
// app-interpreted string. The reference lives in this stratum — not in
// `@awthaq/core` — because `@awthaq/sql` sits *below* core and its repositories
// are the choke point that stamps every insert; `@awthaq/core` re-exports it as
// `Tenant`, which is where applications import it from.
//
// A `Context.Reference` with a default (ADR-EA-011, the `SessionConfig` shape):
// nothing has to provide it, an unprovided read is `Option.none()`, and every
// write then stamps `NULL` — a single-tenant deployment behaves exactly as it
// did before this module existed.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** The tenant the current fiber acts for, if any. Provided per request by `Organization.tenantMiddleware`, or per job with `withTenant`. */
export const TenantContext: Context.Reference<Option.Option<string>> = Context.Reference<
  Option.Option<string>
>("awthaq/ports/TenantContext", { defaultValue: () => Option.none() });

/** Runs `effect` with `tenantId` as the ambient tenant (background jobs, seed scripts, tests). */
export const withTenant =
  (tenantId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, TenantContext, Option.some(tenantId));

/** Runs `effect` with no ambient tenant, even inside a `withTenant` region (cross-tenant maintenance). */
export const withoutTenant = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, TenantContext, Option.none());

/**
 * EP-007: names the tenant whose configuration layers a request runs under. A plugin's
 * `config(...)` layer provides only a `Context.Reference`, which carries no requirement
 * type, so it is a `Layer<never>` — and `LayerMap`'s constructors, keyed by tenant id, do not
 * accept a lookup whose output is `never`. Adding `configApplied(tenantId)` to a tenant's
 * layers (`Layer.merge(Organization.config(...), Tenant.configApplied(tenantId))`) gives the
 * lookup a real output type, and lets a handler read which tenant's configuration is in force.
 */
export class TenantConfigApplied extends Context.Service<
  TenantConfigApplied,
  { readonly tenantId: string }
>()("awthaq/ports/TenantConfigApplied") {}

export const configApplied = (tenantId: string) =>
  Layer.succeed(TenantConfigApplied, TenantConfigApplied.of({ tenantId }));

/**
 * EP-007 (ADR-EA-018 Decision 8): the configuration in force for one operation. A value
 * provided for `key` in the *calling* fiber (the tenant middleware does this from an
 * application's `TenantConfig`) wins; with none, `built` — what the plugin read when its layer
 * was built — applies, so `Layer.provide(Plugin.config(...))` keeps meaning what it always
 * meant. A plain per-operation `yield* Reference` would silently ignore every build-time
 * `config(...)`, because the layer's provision is not visible to the calling fiber.
 */
export const configInForce = <I, A>(key: Context.Key<I, A>, built: A) =>
  Effect.contextWith((context: Context.Context<never>) =>
    Effect.succeed(Context.getOrUndefined(context, key) ?? built),
  );
