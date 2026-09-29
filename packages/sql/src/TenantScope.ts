// @awthaq/sql — TenantScope
//
// DRS-001/SAM-006 (wayfinder ticket 18, ADR-EA-018): the opt-in, database-level
// backstop under the `"tenantId"` column. Application code that forgets a tenant
// filter fails closed here instead of leaking another tenant's rows.
//
// Postgres only. Row-level security policies compare each row's `"tenantId"` to
// the transaction-local setting `awthaq.tenant_id`, which `withTenant` sets with
// `set_config(..., true)` (transaction-local, so pool-safe: a pooled connection
// never carries one request's tenant into the next). SQLite has no RLS; there
// `withTenant` only provides the ambient `TenantContext` and WHERE-discipline is
// the whole story (a SQLite deployment is typically embedded and single-tenant).
//
// Deliberately fail-open when *no* tenant is set (`awthaq.tenant_id` unset or
// empty): a single-tenant deployment, a migration and a maintenance script all
// run without a tenant and must keep working with RLS enabled. Isolation is
// enforced for exactly the work that runs inside `withTenant`.
//
// Which tables: the *partitioned* tables (sessions, verification tokens and
// reservations, the audit log). `users` and `accounts` are the global identity
// directory (DRS-005, ADR-EA-018): sign-in resolves an email or a provider
// subject before any tenant is known, and one person may belong to several
// tenants, so RLS on them is opt-in through `includeDirectory`.
//
// Deployment notes (README "Data location & residency"): RLS is bypassed by
// superusers and by roles with `BYPASSRLS`, and — unless `FORCE` is set, which
// `enableRls` does — by the table owner. Run the application as a plain
// non-owner role for the guarantee to hold without depending on `FORCE`.

import { Tenant } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The setting the policies read; `withTenant` writes it. */
export const TENANT_SETTING = "awthaq.tenant_id";

/** Per-user, per-request tables that partition by tenant. */
export const partitionedTables = [
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
] as const;

/** The global identity directory (DRS-005): unique across tenants, RLS only on request. */
export const directoryTables = ["users", "accounts"] as const;

export interface RlsOptions {
  /** Also cover `users` and `accounts`; only sensible when every read runs inside `withTenant`. */
  readonly includeDirectory?: boolean;
}

const POLICY = "awthaq_tenant";

const tablesFor = (options: RlsOptions | undefined): ReadonlyArray<string> =>
  options?.includeDirectory === true
    ? [...partitionedTables, ...directoryTables]
    : partitionedTables;

/**
 * Enables (and forces) tenant RLS. Idempotent — safe to run on every deploy — and
 * a no-op off Postgres. Not a numbered migration on purpose: `CoreMigrations`
 * ids are a forward-only ledger every deployment must apply, while this is an
 * operator's choice that can be enabled and disabled again.
 */
export const enableRls = (options?: RlsOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.onDialectOrElse({
      pg: () =>
        Effect.forEach(
          tablesFor(options),
          (table) =>
            Effect.gen(function* () {
              yield* sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
              yield* sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
              yield* sql.unsafe(`DROP POLICY IF EXISTS ${POLICY} ON ${table}`);
              yield* sql.unsafe(
                `CREATE POLICY ${POLICY} ON ${table} USING (
                   NULLIF(current_setting('${TENANT_SETTING}', true), '') IS NULL
                   OR "tenantId" = current_setting('${TENANT_SETTING}', true)
                 )`,
              );
            }),
          { discard: true },
        ),
      orElse: () => Effect.void,
    });
  });

/** Removes what `enableRls` installed (every table it can cover). Idempotent, no-op off Postgres. */
export const disableRls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.forEach(
        [...partitionedTables, ...directoryTables],
        (table) =>
          Effect.gen(function* () {
            yield* sql.unsafe(`DROP POLICY IF EXISTS ${POLICY} ON ${table}`);
            yield* sql.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
            yield* sql.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
          }),
        { discard: true },
      ),
    orElse: () => Effect.void,
  });
});

/**
 * Runs `effect` as `tenantId`: provides the ambient `TenantContext` (so every
 * insert inside is stamped) and, on Postgres, runs it in one transaction whose
 * first statement sets `awthaq.tenant_id`, so RLS confines every read and write
 * inside to that tenant. Nests inside an outer transaction (savepoint).
 *
 * The transaction is the cost of the guarantee: `set_config(..., true)` is
 * transaction-local. Wrap the work that touches tenant data, not a whole process.
 */
export const withTenant =
  (tenantId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const scoped = Tenant.withTenant(tenantId)(effect);
      return yield* sql.onDialectOrElse({
        pg: () =>
          sql.withTransaction(
            Effect.andThen(sql`SELECT set_config(${TENANT_SETTING}, ${tenantId}, true)`, scoped),
          ),
        orElse: () => scoped,
      });
    });
