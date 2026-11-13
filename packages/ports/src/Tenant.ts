// @awthaq/ports — Tenant
//
// DRS-001/EP-001 (wayfinder ticket 18, ADR-EA-018): the ambient tenant. A
// tenant is an `Organization` row, but core cannot import the organization
// plugin (plugins depend on core, never the reverse), so the key is an opaque,
// app-interpreted string. The reference lives in this stratum — not in
// `@awthaq/core` — because `@awthaq/sql` sits *below* core and its store adapters
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
 * The one tenant-stamp rule (plan 05 / plan 02): an explicit `tenantId` on the input wins, then
 * the ambient `TenantContext`, then `NULL`. It lives here, below `@awthaq/sql`, so memory and SQL
 * adapters of core and of every plugin stamp rows identically.
 */
export const stamp = <A extends { readonly tenantId: string | null }>(
  input: A,
): Effect.Effect<A> =>
  input.tenantId !== null
    ? Effect.succeed(input)
    : Effect.map(TenantContext, (tenant) => ({ ...input, tenantId: Option.getOrNull(tenant) }));

/**
 * The same rule over an optional explicit tenant, for the store adapters whose rows carry
 * `Option<string>` (the memory adapters of plan 02): an explicit `Some` wins, else the ambient
 * `TenantContext`, else none.
 */
export const resolve = (explicit: Option.Option<string>): Effect.Effect<Option.Option<string>> =>
  Option.isSome(explicit)
    ? Effect.succeed(explicit)
    : Effect.map(TenantContext, (tenant) => tenant);

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
 * ADR-EA-018 decision 8, BEH-EA-355: where a configuration key's value comes from. A **tenant**-scoped key is
 * resolved per operation (the calling fiber's value, else the build value); a **deployment**-scoped key is the build
 * value, always.
 */
export type ConfigScope = "tenant" | "deployment";

/**
 * Provided by every deployment-scoped `config(...)` layer (BEH-EA-355). It carries no information a handler needs; it
 * exists so the layer has an output type. A tenant's `LayerMap` output is invariant (`LayerMap<K, I, E>`), so a
 * `TenantConfig` lookup that merges a deployment-scoped layer does not type-check at
 * `TenantMiddleware.layerWithConfig`: a setting that cannot vary per tenant is refused at the composition.
 */
export class DeploymentConfigApplied extends Context.Service<
  DeploymentConfigApplied,
  { readonly key: string }
>()("awthaq/ports/DeploymentConfigApplied") {}

/** A key resolved per operation. `boot` fields are read only from the build value; a tenant's value for them is never read. */
export interface PerTenant<I, A, K extends Context.Key<I, A> = Context.Key<I, A>> {
  readonly scope: "tenant";
  readonly reference: K;
  readonly boot: ReadonlyArray<Extract<keyof A, string>>;
  readonly layer: (value: A) => Layer.Layer<I>;
}

/** A key that is the build value, always. Its layer also provides `DeploymentConfigApplied`. */
export interface PerDeployment<I, A, K extends Context.Key<I, A> = Context.Key<I, A>> {
  readonly scope: "deployment";
  readonly reference: K;
  readonly layer: (value: A) => Layer.Layer<I | DeploymentConfigApplied>;
}

export type Declared<I, A, K extends Context.Key<I, A> = Context.Key<I, A>> =
  | PerTenant<I, A, K>
  | PerDeployment<I, A, K>;

/** Declares `reference` tenant-scoped (BEH-EA-355). `boot` names the fields no operation reads from the tenant's value. */
export const perTenant = <K extends Context.Key<unknown, unknown>>(
  reference: K,
  options?: { readonly boot?: ReadonlyArray<Extract<keyof K["Service"], string>> },
) => {
  const declared: PerTenant<K["Identifier"], K["Service"], K> = {
    scope: "tenant",
    reference,
    boot: options?.boot ?? [],
    layer: (value) => Layer.succeed(reference, value),
  };
  return declared;
};

/** Declares `reference` deployment-scoped (BEH-EA-355): its `config(...)` layer is not usable in a tenant lookup. */
export const perDeployment = <K extends Context.Key<unknown, unknown>>(reference: K) => {
  const declared: PerDeployment<K["Identifier"], K["Service"], K> = {
    scope: "deployment",
    reference,
    layer: (value) =>
      Layer.merge(
        Layer.succeed(reference, value),
        Layer.succeed(DeploymentConfigApplied, DeploymentConfigApplied.of({ key: reference.key })),
      ),
  };
  return declared;
};

/**
 * The one rule (ADR-EA-018 decision 8), pure: shared by the accessor and the views. A deployment-scoped key is the
 * build value. A tenant-scoped key is the calling context's value, with each `boot` field taken from the build
 * value; with no calling value, the build value.
 */
export const resolveConfig = <I, A>(
  declared: Declared<I, A>,
  built: A,
  calling: Context.Context<never>,
): A => {
  if (declared.scope === "deployment") return built;
  const tenant = Context.getOrUndefined(calling, declared.reference);
  if (tenant === undefined) return built;
  if (declared.boot.length === 0) return tenant;
  const fromBuild = Object.fromEntries(declared.boot.map((field) => [field, built[field]]));
  return { ...tenant, ...fromBuild };
};

/**
 * The one accessor: yield it once where the module is built, yield the result per operation. A plain
 * per-operation `yield* Reference` would silently ignore every build-time `config(...)`, because the layer's
 * provision is not visible to the calling fiber.
 */
export const inForce = <I, A>(declared: Declared<I, A>) =>
  Effect.map(Effect.service(declared.reference), (built) =>
    Effect.contextWith((calling: Context.Context<never>) =>
      Effect.succeed(resolveConfig(declared, built, calling)),
    ),
  );
