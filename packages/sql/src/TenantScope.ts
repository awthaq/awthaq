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
// Plugin tables (plan 05, ADR-EA-018 decision 10): a plugin declares each table's tenancy and
// `Auth.make` exposes the declarations as `auth.tenancy`; `enableRls({ plugins: auth.tenancy })`
// covers declared Partitioned tables, and Derived tables through their parent's policy. Keyed
// (organization-id) tables are covered on request (`includeKeyed`). A witnessed cross-tenant
// statement lifts the policies for itself (`TenantScoped.lift`).
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

import { SqlTransaction, Tenant } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TenantScoped from "./TenantScoped.ts";

/** The setting the policies read; `withTenant` writes it. */
export const TENANT_SETTING = TenantScoped.TENANT_SETTING;

/** Per-user, per-request tables that partition by tenant. */
export const partitionedTables = [
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
] as const;

/** The global identity directory (DRS-005): unique across tenants, RLS only on request. */
export const directoryTables = ["users", "accounts"] as const;

/** One plugin table and how it relates to the tenant: what `auth.tenancy` lists. */
export interface DeclaredTable {
  readonly plugin: string;
  readonly table: string;
  readonly tenancy: TenantScoped.Tenancy;
}

export interface RlsOptions {
  /** Also cover `users` and `accounts`; only sensible when every read runs inside `withTenant`. */
  readonly includeDirectory?: boolean;
  /** `auth.tenancy`: the plugin tables to cover (Partitioned always; Derived through a covered parent). */
  readonly plugins?: ReadonlyArray<DeclaredTable>;
  /** Also cover Keyed tables (organization-id keyed), and Derived tables beneath them. Default false. */
  readonly includeKeyed?: boolean;
}

const POLICY = "awthaq_tenant";

/** What one covered table's policy compares. */
export type Coverage =
  | { readonly table: string; readonly kind: "column"; readonly column: string }
  | {
      readonly table: string;
      readonly kind: "parent";
      readonly parent: string;
      readonly via: string;
      readonly parentKey: string;
    };

const UNSET = `NULLIF(current_setting('${TENANT_SETTING}', true), '') IS NULL`;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Identifiers reach DDL text, so every one is validated here (`Auth.make` validated them already). */
const identifier = (name: string) => {
  if (!IDENTIFIER.test(name)) throw new Error(`awthaq: ${name} is not a plain SQL identifier`);
  return `"${name}"`;
};

const usingExpression = (cover: Coverage) =>
  cover.kind === "column"
    ? `${UNSET} OR ${identifier(cover.column)} = current_setting('${TENANT_SETTING}', true)`
    : `${UNSET} OR EXISTS (SELECT 1 FROM ${identifier(cover.parent)} p WHERE p.${identifier(cover.parentKey)} = ${identifier(cover.table)}.${identifier(cover.via)})`;

/**
 * Pure: the tables `enableRls(options)` covers, in the order it covers them, and the declared
 * tables it skipped (a Derived table whose parent is not covered, with the reason).
 */
export const coverage = (options: RlsOptions | undefined) => {
  const covered: Array<Coverage> = [
    ...partitionedTables.map((table): Coverage => ({ table, kind: "column", column: "tenantId" })),
    ...(options?.includeDirectory === true
      ? directoryTables.map((table): Coverage => ({ table, kind: "column", column: "tenantId" }))
      : []),
  ];
  const skipped: Array<{ readonly table: string; readonly reason: string }> = [];
  const declared = options?.plugins ?? [];
  for (const entry of declared) {
    if (entry.tenancy._tag === "Partitioned") {
      covered.push({ table: entry.table, kind: "column", column: entry.tenancy.column });
    } else if (entry.tenancy._tag === "Keyed" && options?.includeKeyed === true) {
      covered.push({ table: entry.table, kind: "column", column: entry.tenancy.column });
    }
  }
  // Derived tables, repeatedly: a child can sit beneath another derived table.
  const pending = declared.filter((entry) => entry.tenancy._tag === "Derived");
  let progressed = true;
  const done = new Set<string>();
  while (progressed) {
    progressed = false;
    for (const entry of pending) {
      const tenancy = entry.tenancy;
      if (tenancy._tag !== "Derived" || done.has(entry.table)) continue;
      if (covered.some((cover) => cover.table === tenancy.parent)) {
        covered.push({
          table: entry.table,
          kind: "parent",
          parent: tenancy.parent,
          via: tenancy.via,
          parentKey: tenancy.parentKey,
        });
        done.add(entry.table);
        progressed = true;
      }
    }
  }
  for (const entry of pending) {
    if (!done.has(entry.table)) {
      skipped.push({
        table: entry.table,
        reason: "its parent table is not covered by this call",
      });
    }
  }
  return { covered, skipped };
};

/**
 * Enables (and forces) tenant RLS. Idempotent — safe to run on every deploy — and
 * a no-op off Postgres. Not a numbered migration on purpose: `CoreMigrations`
 * ids are a forward-only ledger every deployment must apply, while this is an
 * operator's choice that can be enabled and disabled again.
 */
export const enableRls = (options?: RlsOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plan = coverage(options);
    yield* sql.onDialectOrElse({
      pg: () =>
        Effect.gen(function* () {
          for (const skipped of plan.skipped) {
            yield* Effect.logInfo("awthaq: RLS skipped a derived table").pipe(
              Effect.annotateLogs({ table: skipped.table, reason: skipped.reason }),
            );
          }
          yield* Effect.forEach(
            plan.covered,
            (cover) =>
              Effect.gen(function* () {
                const table = identifier(cover.table);
                yield* sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
                yield* sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
                yield* sql.unsafe(`DROP POLICY IF EXISTS ${POLICY} ON ${table}`);
                yield* sql.unsafe(
                  `CREATE POLICY ${POLICY} ON ${table} USING (${usingExpression(cover)})`,
                );
              }),
            { discard: true },
          );
        }),
      orElse: () => Effect.void,
    });
  });

/**
 * Removes what `enableRls` installed: the `awthaq_tenant` policy from **every** table that has
 * one (whatever was enabled earlier, plugin tables included), then `NO FORCE` / `DISABLE`.
 * Idempotent, no-op off Postgres.
 */
export const disableRls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        const policies = yield* sql<{
          readonly schemaname: string;
          readonly tablename: string;
        }>`SELECT schemaname, tablename FROM pg_policies
           WHERE policyname = ${POLICY} AND schemaname = current_schema()`;
        yield* Effect.forEach(
          policies,
          ({ tablename }) =>
            Effect.gen(function* () {
              const table = identifier(tablename);
              yield* sql.unsafe(`DROP POLICY IF EXISTS ${POLICY} ON ${table}`);
              yield* sql.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
              yield* sql.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
            }),
          { discard: true },
        );
      }),
    orElse: () => Effect.void,
  });
});

/**
 * Runs `effect` as `tenantId`: provides the ambient `TenantContext` (so every
 * insert inside is stamped) and, on Postgres, runs it in one transaction whose
 * first statement sets `awthaq.tenant_id`, so RLS confines every read and write
 * inside to that tenant (`TenantScoped.InRlsScope` is true inside, so a witnessed
 * cross-tenant statement knows to lift it). Nests inside an outer transaction (savepoint).
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
          SqlTransaction.transactional(sql)(
            Effect.andThen(
              sql`SELECT set_config(${TENANT_SETTING}, ${tenantId}, true)`,
              Effect.provideService(scoped, TenantScoped.InRlsScope, true),
            ),
          ),
        orElse: () => scoped,
      });
    });
