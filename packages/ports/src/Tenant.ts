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
