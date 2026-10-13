// @awthaq/sql — TenantScoped
//
// Plan 05 (ADR-EA-018 decision 10): the one tenant interface for a plugin's records. A table
// declares its tenancy (`partitioned` / `keyed` / `derived` / `global`); a Partitioned table's
// store stamps each insert with the ambient tenant and filters reads and writes by one
// index-friendly predicate built here, identically for the memory and the SQL adapter.
// Crossing tenants is a typed act: a `CrossTenant` witness, minted by `crossTenant(reason)`,
// is the only way to ask for "every tenant", and on Postgres it also lifts row-level security
// for the one statement (`lift`), because `Tenant.withoutTenant` only clears the fiber reference
// and not the transaction-local `awthaq.tenant_id` setting the policies read.

import { SqlTransaction, Tenant } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The transaction-local setting the RLS policies read (`TenantScope` re-exports it). */
export const TENANT_SETTING = "awthaq.tenant_id";

// ---- declarations (what a table is) -------------------------------------------------

/** How one table relates to the tenant. */
export type Tenancy = Data.TaggedEnum<{
  /** Nullable tenant column stamped at insert from the ambient tenant; NULL = untenanted (platform). */
  Partitioned: { readonly column: string };
  /** The organization id (= tenant id) is the row's own key column; callers pass it explicitly. */
  Keyed: { readonly column: string };
  /** No own tenant column: scoped through `parent` by `via` -> `parent.parentKey`. */
  Derived: { readonly parent: string; readonly via: string; readonly parentKey: string };
  /** Deliberately tenant-blind; `reason` is printed by `awthaq plugin list` and reviewed. */
  Global: { readonly reason: string };
}>;
export const Tenancy = Data.taggedEnum<Tenancy>();

export const partitioned = (column = "tenantId") => Tenancy.Partitioned({ column });
export const keyed = (column: string) => Tenancy.Keyed({ column });
export const derived = (parent: string, via: string, parentKey = "id") =>
  Tenancy.Derived({ parent, via, parentKey });
export const global = (reason: string) => Tenancy.Global({ reason });

/** One table's declaration. A record, not the bare Tenancy, so a later `retention` can sit beside it. */
export interface TableDeclaration {
  readonly tenancy: Tenancy;
}

// ---- the cross-tenant witness -------------------------------------------------------

/** The one way to lift tenant confinement. Carries why; minted only by `crossTenant`. */
export type CrossTenant = string & Brand.Brand<"awthaq/sql/CrossTenant">;
const mint = Brand.nominal<CrossTenant>();
export const crossTenant = (reason: string) => mint(reason);

// ---- what one statement may see -----------------------------------------------------

export type Visibility = Data.TaggedEnum<{
  Tenant: { readonly tenant: Option.Option<string> };
  Everywhere: { readonly grant: CrossTenant };
}>;
export const Visibility = Data.taggedEnum<Visibility>();

/** The ambient tenant, unless the caller presents a witness (which is recorded on the span). */
export const visibility = (grant?: CrossTenant) =>
  Effect.gen(function* () {
    if (grant === undefined) return Visibility.Tenant({ tenant: yield* Tenant.TenantContext });
    yield* Effect.annotateCurrentSpan("awthaq.tenant.crossTenant", grant);
    return Visibility.Everywhere({ grant });
  });

/** Memory adapters: the same rule as `predicate`. `None` sees only untenanted rows; `Some(t)` only t's. */
export const matches = (row: string | null, seen: Visibility) =>
  Visibility.$match(seen, {
    Everywhere: () => true,
    Tenant: ({ tenant }) => Option.getOrNull(tenant) === row,
  });

/** The tenant-stamp rule (explicit tenant, then ambient, then NULL), owned by `@awthaq/ports`. */
export const stamp = Tenant.stamp;

// ---- SQL ------------------------------------------------------------------------------

/**
 * Index-friendly predicate for a Partitioned column (`qualifier` for joins: `e."tenantId"`).
 * Never `IS NOT DISTINCT FROM`, which Postgres cannot serve from a btree index.
 */
export const predicate = (
  sql: SqlClient.SqlClient,
  column: string,
  seen: Visibility,
  qualifier?: string,
) => {
  const target = qualifier === undefined ? sql(column) : sql`${sql(qualifier)}.${sql(column)}`;
  return Visibility.$match(seen, {
    Everywhere: () => sql.literal("1 = 1"),
    Tenant: ({ tenant }) =>
      Option.match(tenant, {
        onNone: () => sql`${target} IS NULL`,
        onSome: (id) => sql`${target} = ${id}`,
      }),
  });
};

/** Provided by `TenantScope.withTenant` (Postgres): `awthaq.tenant_id` is set on this connection. */
export const InRlsScope = Context.Reference<boolean>("awthaq/sql/InRlsScope", {
  defaultValue: () => false,
});

/**
 * Runs `effect` with RLS lifted for a witnessed cross-tenant statement. Zero cost outside an RLS
 * transaction (SQLite, no `withTenant`, or the background relay). Inside one it uses a savepoint:
 * clear the setting, run, and restore it on success (a rolled-back savepoint reverts it by itself).
 */
export const lift =
  (grant: CrossTenant) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* InRlsScope)) return yield* effect;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.annotateCurrentSpan("awthaq.tenant.rlsLifted", grant);
      return yield* SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly value: string | null;
          }>`SELECT current_setting(${TENANT_SETTING}, true) AS value`;
          yield* sql`SELECT set_config(${TENANT_SETTING}, '', true)`;
          const result = yield* effect;
          yield* sql`SELECT set_config(${TENANT_SETTING}, ${rows[0]?.value ?? ""}, true)`;
          return result;
        }),
      );
    });
