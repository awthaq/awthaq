// @awthaq/test — TenantConformance
//
// Plan 05 (ADR-EA-018 decision 10): one parameterised tenant-isolation suite for a plugin's
// records, run per table over each adapter (memory, SQLite, and Postgres with RLS under
// `test:pg`). It replaces per-plugin regex guards and hand-written tenant cases:
//
// - every method of a records interface is classified (`scoped`, `crossTenant`, `keyed`,
//   `derived` or `insert`), and the `methods` map is keyed by `keyof Shape`, so a method added
//   to the interface without a classification does not compile;
// - the suite proves each class: a `scoped` method sees and changes only the ambient tenant's
//   rows, a `crossTenant` method sees every tenant's, a `keyed` method never touches another
//   organization's rows;
// - every Partitioned, Keyed and Derived table a plugin declares has a case, and no Global table
//   has one;
// - on Postgres, with RLS enabled for the declarations and a non-owner role, a deliberately
//   unfiltered statement is confined by the database and a witnessed statement is not.
//
// Framework-injected like `runPluginContractTests`, so a third-party plugin runs the same suite.

import { Tenant } from "@awthaq/ports";
import { TenantScope, TenantScoped } from "@awthaq/sql";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TestFramework } from "./TestFramework.ts";

/** Runs against row `id` under whatever tenant the suite set; `true` = it saw or changed that row. */
export interface Probe<Id, R> {
  readonly run: (id: Id) => Effect.Effect<boolean, unknown, R>;
}

/** A keyed table has no ambient tenant: the probe is told whose organization key to present. */
export interface KeyedProbe<Id, R> {
  readonly run: (id: Id, as: "owner" | "other") => Effect.Effect<boolean, unknown, R>;
}

/** How one records method relates to the tenant. */
export type MethodClass<Id, R> =
  /** Must see and change only the ambient tenant's rows. */
  | { readonly scoped: Probe<Id, R> }
  /** Takes a `CrossTenant` witness (the probe mints it); must see every tenant's rows. */
  | { readonly crossTenant: Probe<Id, R> }
  /** Scoped by an explicit organization key: must not touch another organization's rows. */
  | { readonly keyed: KeyedProbe<Id, R> }
  /** Keyed by a parent key the caller already resolved through a scoped read; the reason says why. */
  | { readonly derived: string }
  /** An insert; covered by the stamp cases. */
  | { readonly insert: true };

export interface TableCase<Shape, Id, R> {
  readonly table: string;
  /**
   * Inserts one row as the ambient tenant (the suite wraps it in `Tenant.withTenant` /
   * `Tenant.withoutTenant`). A Keyed table's insert uses the ambient tenant id as the row's
   * organization key, so the suite's tenants A and B are two organizations. A Derived table's
   * insert creates the parent and the child under the ambient tenant.
   */
  readonly insert: Effect.Effect<Id, unknown, R>;
  /** Every member of the records interface, classified. A new, unclassified method does not compile. */
  readonly methods: { readonly [K in keyof Shape]: MethodClass<Id, R> };
}

export interface TenantIsolationConfig<Shape, Id, R> {
  /** Its `tenancy` drives the coverage check (`AuthPlugin.Any` satisfies this). */
  readonly plugin: {
    readonly id: string;
    readonly tenancy?: Readonly<Record<string, TenantScoped.TableDeclaration>> | undefined;
  };
  readonly adapters: ReadonlyArray<{
    readonly name: string;
    readonly layer: Layer.Layer<R, unknown>;
  }>;
  readonly cases: ReadonlyArray<TableCase<Shape, Id, R>>;
  /**
   * The declared tables this call is responsible for (the tables of one records interface, so a
   * plugin with several records modules makes one call per module). Defaults to every declared table.
   */
  readonly covers?: ReadonlyArray<string>;
  /**
   * Postgres only: the plugin's SQL adapter, which must also provide the `SqlClient` it runs on
   * (migrations already applied). The suite creates a non-owner role, enables RLS for the plugin's
   * declarations, and checks the backstop. Off Postgres the RLS cases pass without doing anything.
   */
  readonly rls?: { readonly layer: Layer.Layer<R | SqlClient.SqlClient, unknown> };
}

const A = "tenant-a";
const B = "tenant-b";
const PROBE_ROLE = "awthaq_conformance_probe";

const declaredTables = (config: {
  readonly plugin: TenantIsolationConfig<never, never, never>["plugin"];
}): ReadonlyArray<TenantScope.DeclaredTable> =>
  Object.entries(config.plugin.tenancy ?? {}).map(([table, declaration]) => ({
    plugin: config.plugin.id,
    table,
    tenancy: declaration.tenancy,
  }));

const crossTenantWitness = TenantScoped.crossTenant("tenant conformance suite");

/** Rows are inserted and probed under a named tenant, or none. */
const asTenant = <A2, E, R2>(tenant: string | undefined, effect: Effect.Effect<A2, E, R2>) =>
  tenant === undefined ? Tenant.withoutTenant(effect) : Tenant.withTenant(tenant)(effect);

const run = <A2, R>(layer: Layer.Layer<R, unknown>, effect: Effect.Effect<A2, unknown, R>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));

export const runTenantIsolationTests = <Shape, Id, R>(
  framework: TestFramework,
  config: TenantIsolationConfig<Shape, Id, R>,
): void => {
  const declarations = declaredTables(config).filter(
    (declared) => config.covers === undefined || config.covers.includes(declared.table),
  );

  framework.describe(`runTenantIsolationTests: ${config.plugin.id}`, () => {
    // ---- coverage -------------------------------------------------------------------
    framework.it(
      "every Partitioned, Keyed and Derived table has a case, and no Global table does",
      () => {
        const cased = new Set(config.cases.map((tableCase) => tableCase.table));
        for (const declared of declarations) {
          const needsCase = declared.tenancy._tag !== "Global";
          if (needsCase && !cased.has(declared.table)) {
            framework.fail(
              `table "${declared.table}" is declared ${declared.tenancy._tag} but has no tenant-isolation case`,
            );
          }
          if (!needsCase && cased.has(declared.table)) {
            framework.fail(`table "${declared.table}" is declared Global and must not have a case`);
          }
        }
        for (const tableCase of config.cases) {
          if (!declarations.some((declared) => declared.table === tableCase.table)) {
            framework.fail(`case for "${tableCase.table}", which the plugin does not declare`);
          }
        }
      },
    );

    for (const adapter of config.adapters) {
      for (const tableCase of config.cases) {
        const label = `${adapter.name} / ${tableCase.table}`;
        const methods = Object.entries<MethodClass<Id, R>>(tableCase.methods);

        for (const [method, classification] of methods) {
          if ("scoped" in classification) {
            const probe = classification.scoped;
            framework.it(
              `${label}.${method}: sees and changes only the ambient tenant's rows`,
              async () => {
                const outcome = await run(
                  adapter.layer,
                  Effect.gen(function* () {
                    const id = yield* asTenant(A, tableCase.insert);
                    // A mutation under another tenant, or none, must leave A's row alone.
                    const underB = yield* asTenant(B, probe.run(id));
                    const underNone = yield* asTenant(undefined, probe.run(id));
                    const underA = yield* asTenant(A, probe.run(id));
                    return { underB, underNone, underA };
                  }),
                );
                if (outcome.underB)
                  framework.fail(`${label}.${method} reached tenant A's row under tenant B`);
                if (outcome.underNone)
                  framework.fail(`${label}.${method} reached tenant A's row under no tenant`);
                if (!outcome.underA)
                  framework.fail(`${label}.${method} did not reach tenant A's own row`);
              },
            );
            framework.it(
              `${label}.${method}: an untenanted row is the platform's, not a tenant's`,
              async () => {
                const outcome = await run(
                  adapter.layer,
                  Effect.gen(function* () {
                    const id = yield* asTenant(undefined, tableCase.insert);
                    const underA = yield* asTenant(A, probe.run(id));
                    const underNone = yield* asTenant(undefined, probe.run(id));
                    return { underA, underNone };
                  }),
                );
                if (outcome.underA)
                  framework.fail(`${label}.${method} reached an untenanted row under tenant A`);
                if (!outcome.underNone)
                  framework.fail(`${label}.${method} did not reach the untenanted row`);
              },
            );
          } else if ("crossTenant" in classification) {
            const probe = classification.crossTenant;
            for (const owner of [A, B, undefined]) {
              framework.it(
                `${label}.${method}: a witnessed call reaches ${owner ?? "an untenanted"} row from another tenant`,
                async () => {
                  const reached = await run(
                    adapter.layer,
                    Effect.gen(function* () {
                      const id = yield* asTenant(owner, tableCase.insert);
                      return yield* asTenant(owner === B ? A : B, probe.run(id));
                    }),
                  );
                  if (!reached) {
                    framework.fail(
                      `${label}.${method} did not reach a row of ${owner ?? "no tenant"}`,
                    );
                  }
                },
              );
            }
          } else if ("keyed" in classification) {
            const probe = classification.keyed;
            framework.it(
              `${label}.${method}: never touches another organization's rows`,
              async () => {
                const outcome = await run(
                  adapter.layer,
                  Effect.gen(function* () {
                    const id = yield* asTenant(A, tableCase.insert);
                    const other = yield* probe.run(id, "other");
                    const owner = yield* probe.run(id, "owner");
                    return { other, owner };
                  }),
                );
                if (outcome.other)
                  framework.fail(`${label}.${method} reached another organization's row`);
                if (!outcome.owner)
                  framework.fail(`${label}.${method} did not reach the owner's row`);
              },
            );
          }
        }

        const classes = methods.map(([, classification]) => classification);
        framework.it(`${label}: at least one method is classified as tenant-aware`, () => {
          if (classes.length > 0 && classes.every((classification) => "insert" in classification)) {
            framework.fail(
              `${label}: every method is classified as an insert, so nothing is probed`,
            );
          }
        });
      }
    }

    // ---- RLS backstop (Postgres only) ---------------------------------------------------
    const rls = config.rls;
    if (rls !== undefined) {
      const rlsTables = config.cases.filter((tableCase) =>
        declarations.some((declared) => declared.table === tableCase.table),
      );
      for (const tableCase of rlsTables) {
        framework.it(
          `rls / ${tableCase.table}: the database confines an unfiltered statement, and a witness lifts it`,
          async () => {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const isPg = yield* sql.onDialectOrElse({
                    pg: () => Effect.succeed(true),
                    orElse: () => Effect.succeed(false),
                  });
                  if (!isPg) return;
                  yield* Effect.acquireUseRelease(
                    Effect.gen(function* () {
                      yield* sql.unsafe(
                        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN CREATE ROLE ${PROBE_ROLE} NOLOGIN; END IF; END $$`,
                      );
                      yield* sql.unsafe(
                        `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`,
                      );
                      yield* TenantScope.enableRls({
                        plugins: declaredTables(config),
                        includeKeyed: true,
                      });
                    }),
                    () =>
                      Effect.gen(function* () {
                        yield* asTenant(A, tableCase.insert);
                        yield* asTenant(B, tableCase.insert);
                        const count = (lifted: boolean) =>
                          Effect.gen(function* () {
                            yield* sql.unsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
                            const counted = sql.unsafe<{ readonly n: string }>(
                              `SELECT count(*)::text AS n FROM "${tableCase.table}"`,
                            );
                            const rows = yield* lifted
                              ? counted.pipe(TenantScoped.lift(crossTenantWitness))
                              : counted;
                            return Number(rows[0]?.n ?? "0");
                          }).pipe(TenantScope.withTenant(B));
                        const confined = yield* count(false);
                        const lifted = yield* count(true);
                        if (!(confined > 0 && confined < lifted)) {
                          framework.fail(
                            `rls / ${tableCase.table}: tenant B saw ${confined} rows confined and ${lifted} lifted; expected 0 < confined < lifted`,
                          );
                        }
                        // A forged insert for tenant A inside tenant B's scope is refused by the database.
                        const forged = yield* Effect.exit(
                          Effect.gen(function* () {
                            yield* sql.unsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
                            return yield* asTenant(A, tableCase.insert);
                          }).pipe(TenantScope.withTenant(B)),
                        );
                        if (Exit.isSuccess(forged)) {
                          framework.fail(
                            `rls / ${tableCase.table}: an insert for tenant A succeeded inside tenant B's scope`,
                          );
                        }
                      }),
                    () => Effect.orDie(TenantScope.disableRls),
                  );
                }).pipe(Effect.provide(rls.layer)),
              ),
            );
          },
        );
      }
    }
  });
};
