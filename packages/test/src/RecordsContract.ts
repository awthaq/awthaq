// @awthaq/test — RecordsContract
//
// Plan 25 (ADR-EA-041 decision 9): the bar every adapter of a plugin's record store must clear, the
// plugin-side twin of `StoreContract`. A plugin's domain is already written once, in its system modules
// (ADR-EA-040); its records modules are the adapters (`layerMemory` over a `Ref`, `layerSql` over the
// ambient `SqlClient`), bundled as `Plugin.records` (BEH-EA-334). What keeps them honest is this:
//
// - one suite per store, keyed by the store's `/records/` key (`Suites<P>`: a missing or surplus key
//   does not compile);
// - every operation of the store's interface carries a verdict next to its cases (`read`, `write`,
//   `atomic` with at least one `race` case, or `exempt` with a reason); an operation added without one
//   does not compile;
// - the runner reads the adapters from `Plugin.records`, never from a hand-built layer, and runs every
//   case on memory and on SQL (SQLite `:memory:` in `pnpm test`, a Postgres schema under
//   `AWTHAQ_POSTGRES_URL`), building a fresh adapter for every case.
//
// Cases are data (`StoreContract.Case`): a name and an `Effect` over the store. They run under a
// `TestClock`, so a case fixes time with `TestClock.adjust`. A `race` case races
// `CONCURRENCY` callers and asserts exact counts: on memory it pins the reference semantics, on
// Postgres it is the point (READ COMMITTED lets a transaction alone skew), on SQLite it is a smoke test.
//
// `runPluginContractTests` requires `records: { suite, suites }` for every plugin whose bundle provides a
// store, and calls `run` with it.

import { Auth, type AuthPlugin, Migrations } from "@awthaq/core";
import { CoreMigrations } from "@awthaq/sql";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { recordsFoundation } from "./internal/foundation.ts";
import * as StoreContract from "./StoreContract.ts";
import * as TenantConformance from "./TenantConformance.ts";
import type { TestFramework } from "./TestFramework.ts";
import * as TestSql from "./TestSql.ts";

export type Case<R> = StoreContract.Case<R>;
export const race = StoreContract.race;
export const CONCURRENCY = StoreContract.CONCURRENCY;

/** What every adapter of a mode is built over, and what a case may read besides the stores. */
export { recordsFoundation };

/** The services `recordsFoundation` provides. */
export type Base = Layer.Success<typeof recordsFoundation>;

type NonEmpty<A> = readonly [A, ...Array<A>];

/** The audit's verdict on one operation, written where its cases are (ADR-EA-041 decision 9). */
export type Verdict<R> =
  /** Reads; no write. */
  | { readonly read: NonEmpty<Case<R>> }
  /** One row, one statement or one `Ref.update`, no condition anyone relies on (last writer wins). */
  | { readonly write: NonEmpty<Case<R>> }
  /** A read-modify-write the domain relies on: atomic by contract, and at least one `race` case proves it. */
  | { readonly atomic: NonEmpty<Case<R>>; readonly race: NonEmpty<Case<R>> }
  /** Not driven here, and why (a test seam, a method only a cascade calls and another suite covers). */
  | { readonly exempt: string };

/**
 * The operations of a store interface: its functions and its `Effect`-valued members
 * (`WebhookRecords.listEndpoints`), not its data (`ChallengeStore.guarantees`).
 */
export type Operations<Shape> = {
  readonly [
    K in keyof Shape as Shape[K] extends
      | ((...args: never) => unknown)
      | Effect.Effect<unknown, unknown, unknown>
      ? K
      : never
  ]: Shape[K];
};

/** One registered case: which operation it proves, under which verdict. */
export interface Entry {
  readonly operation: string;
  readonly verdict: "read" | "write" | "atomic" | "race";
  readonly case: Case<unknown>;
}

/** Runs one effect on a fresh adapter of one mode (memory, SQL, an extra adapter). */
type Runner = TenantConformance.Runner<unknown>;

/** What the runner reads off a suite, whatever store it is for. */
export interface SuiteData {
  readonly entries: ReadonlyArray<Entry>;
  readonly exempt: ReadonlyArray<{ readonly operation: string; readonly reason: string }>;
  readonly sql: ReadonlyArray<Case<unknown>>;
  readonly tenancy?: (
    framework: TestFramework,
    plugin: AuthPlugin.Any,
    adapters: ReadonlyArray<{ readonly name: string; readonly run: Runner }>,
    rls: Runner,
  ) => void;
}

/**
 * A store's suite. `Id` (the store's identifier type) ties it to its key in `Suites`: invariant, so a
 * suite built for one store cannot sit under another's key.
 */
export interface Suite<in out Id> extends SuiteData {
  readonly store: Context.Key<Id, unknown>;
}

/**
 * Builds a store's suite. `operations` is keyed by the store interface's operations: every one carries
 * a verdict, and a new operation without one does not compile. Cases may read the store, `Base`, and the
 * stores named in `R` (a sibling or host store the runner provides beside it, to arrange rows).
 */
export const suite = <Id, Shape, RowId = never, R = never>(
  store: Context.Key<Id, Shape>,
  definition: {
    readonly operations: {
      readonly [K in keyof Operations<NoInfer<Shape>>]: Verdict<Id | Base | R>;
    };
    /** Adapter-level cases that read rows directly (atomicity under `TestSql.injectFailure`, a dialect codec). SQL mode only. */
    readonly sql?: ReadonlyArray<Case<Id | Base | R | SqlClient.SqlClient>>;
    /** Plan 05's tenant-isolation cases for this store's tables, run over the same adapters (with RLS on Postgres). */
    readonly tenancy?: {
      /** The declared tables this store owns (each needs a case unless Global). */
      readonly covers: ReadonlyArray<string>;
      readonly cases: ReadonlyArray<TenantConformance.TableCase<Shape, RowId, Id | Base | R>>;
    };
  },
): Suite<Id> => {
  const entries: Array<Entry> = [];
  const exempt: Array<{ readonly operation: string; readonly reason: string }> = [];
  const verdicts: ReadonlyArray<readonly [string, Verdict<Id | Base | R>]> = Object.entries<
    Verdict<Id | Base | R>
  >(definition.operations);
  const add = (
    operation: string,
    verdict: Entry["verdict"],
    cases: ReadonlyArray<Case<Id | Base | R>>,
  ) => {
    for (const contractCase of cases) {
      entries.push({
        operation,
        verdict,
        case: { name: `${operation} [${verdict}]: ${contractCase.name}`, run: contractCase.run },
      });
    }
  };
  for (const [operation, verdict] of verdicts) {
    if ("exempt" in verdict) exempt.push({ operation, reason: verdict.exempt });
    else if ("atomic" in verdict) {
      add(operation, "atomic", verdict.atomic);
      add(operation, "race", verdict.race);
    } else if ("read" in verdict) add(operation, "read", verdict.read);
    else add(operation, "write", verdict.write);
  }
  const tenancy = definition.tenancy;
  return {
    store,
    entries,
    exempt,
    sql: definition.sql ?? [],
    ...(tenancy === undefined
      ? {}
      : {
          tenancy: (framework, plugin, adapters, rls) =>
            TenantConformance.runTenantIsolationWith(framework, {
              plugin,
              adapters,
              cases: tenancy.cases,
              covers: tenancy.covers,
              rls: { run: rls },
            }),
        }),
  };
};

/** One suite per store the plugin's bundle provides, keyed by its `/records/` key. A missing or surplus key does not compile. */
export type Suites<P> = {
  readonly [S in AuthPlugin.RecordsOut<P> as AuthPlugin.RecordKeysOf<S>]: Suite<S>;
};

/**
 * Plan 25 ticket 08: the stand-in for a plugin whose stores have not been given suites yet. It registers
 * one passing test per store, naming the ticket that will replace it; ticket 25 removes it.
 */
export interface Pending {
  readonly _tag: "RecordsContract/Pending";
  readonly ticket: string;
}

export const pending = (ticket: string): Pending => ({ _tag: "RecordsContract/Pending", ticket });

const isPending = <S extends object>(suites: S | Pending): suites is Pending =>
  "_tag" in suites && suites._tag === "RecordsContract/Pending";

export interface RunConfig<P> {
  readonly suites: Suites<P> | Pending;
  /** Names the Postgres schema (`TestSql.layer`); one per test file. */
  readonly suite: string;
  /** Another adapter of some of the stores (passkey's `ChallengeStore.layerCookie`), run on the suites of the keys it provides. */
  readonly adapters?: ReadonlyArray<{
    readonly name: string;
    readonly layer: Layer.Layer<never, unknown, unknown>;
  }>;
}

/** Runs an effect whose requirements a layer it provided covers at runtime (the records bundles are typed `AuthPlugin.AnyRecords`). */
const runClosed = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
  Effect.runPromiseWith(Context.makeUnsafe<unknown>(new Map()))(effect);

const runnerOf =
  (layer: Layer.Layer<never, unknown, unknown>): Runner =>
  (effect) =>
    runClosed(Effect.scoped(Effect.provide(effect, layer)));

/** A client migrated with core's migrations and then `migrations` (the composition's), `SqlClient` in the output. */
const migratedClient = (
  migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"],
  suiteName: string,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Migrator.make({})({
        loader: CoreMigrations.coreMigrations,
        table: "effect_sql_migrations",
      });
      yield* Migrations.run(migrations);
    }),
  ).pipe(Layer.provideMerge(TestSql.layer(suiteName)));

/**
 * The base every adapter of a mode is built over: `recordsFoundation`, and in SQL mode a client migrated
 * with core's migrations and then the composition's (SQLite `:memory:`, or this suite's Postgres schema
 * under `AWTHAQ_POSTGRES_URL`). Built afresh by every case.
 */
export const recordsBase = (
  mode: "memory" | "sql",
  migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"],
  suiteName: string,
): Layer.Layer<Base | SqlClient.SqlClient, unknown> | Layer.Layer<Base, unknown> =>
  mode === "memory"
    ? recordsFoundation
    : Layer.merge(recordsFoundation, migratedClient(migrations, suiteName));

/** The service keys a built context holds. */
const keysOf = (context: Context.Context<never>): ReadonlyArray<string> =>
  Array.from(context.mapUnsafe.keys()).sort();

const isRecordKey = (key: string) => key.includes("/records/");

/** Registers every case of every suite, on memory and on SQL, plus the coverage, exemption and tenancy checks. */
export const run = <P extends AuthPlugin.Any>(
  framework: TestFramework,
  plugin: P,
  host: ReadonlyArray<AuthPlugin.Any>,
  config: RunConfig<P>,
): void => {
  const composed: ReadonlyArray<AuthPlugin.Any> = [...host, plugin];
  const [first, ...rest] = composed;
  if (first === undefined) return;
  const migrations = Auth.make([first, ...rest]).migrations;
  const records = (mode: "memory" | "sql") =>
    Layer.mergeAll(
      Layer.empty,
      ...[...host, plugin].map((installed) => installed.records?.[mode] ?? Layer.empty),
    );
  /** Every store of the composition over a fresh base; the base stays in the output for the cases. */
  const bundle = (mode: "memory" | "sql", key: string): Layer.Layer<never, unknown, unknown> =>
    records(mode).pipe(
      Layer.provideMerge(
        recordsBase(mode, migrations, `${config.suite}_${key.split("/").pop() ?? key}`),
      ),
    );
  /** The keys of the stores the plugin's own bundle provides, read off a built memory bundle. */
  const providedKeys = () =>
    plugin.records === undefined
      ? Promise.resolve<ReadonlyArray<string>>([])
      : runClosed(
          Layer.build(plugin.records.memory.pipe(Layer.provide(recordsFoundation))).pipe(
            Effect.map((context) => keysOf(context).filter(isRecordKey)),
            Effect.scoped,
          ),
        );

  framework.describe(`RecordsContract: ${plugin.id}`, () => {
    const suites = config.suites;
    if (isPending(suites)) {
      const ticket = suites.ticket;
      framework.it(`every store: contract pending (plan 25 ticket ${ticket})`, async () => {
        const keys = await providedKeys();
        if (keys.length === 0)
          framework.fail(`plugin "${plugin.id}" provides no store, so nothing is pending`);
      });
      return;
    }
    const listed: ReadonlyArray<readonly [string, SuiteData]> = Object.entries<SuiteData>(suites);

    framework.it(
      "every store the bundle provides has a suite, and every suite names a store it provides",
      async () => {
        const keys = await providedKeys();
        const missing = keys.filter((key) => !listed.some(([named]) => named === key));
        const surplus = listed.map(([named]) => named).filter((named) => !keys.includes(named));
        if (missing.length > 0)
          framework.fail(`stores without a RecordsContract suite: ${missing.join(", ")}`);
        if (surplus.length > 0)
          framework.fail(`suites for stores the bundle does not provide: ${surplus.join(", ")}`);
      },
    );

    for (const [key, storeSuite] of listed) {
      const modes: ReadonlyArray<{
        readonly mode: string;
        readonly layer: () => Layer.Layer<never, unknown, unknown>;
        readonly sql: boolean;
      }> = [
        { mode: "memory", layer: () => bundle("memory", key), sql: false },
        { mode: "sql", layer: () => bundle("sql", key), sql: true },
        ...(config.adapters ?? []).map((adapter) => ({
          mode: adapter.name,
          layer: () => adapter.layer.pipe(Layer.provideMerge(recordsFoundation)),
          sql: false,
        })),
      ];
      for (const { mode, layer, sql } of modes) {
        const cases = [
          ...storeSuite.entries.map((entry) => entry.case),
          ...(sql ? storeSuite.sql : []),
        ];
        framework.describe(`RecordsContract: ${key} (${mode})`, () => {
          for (const contractCase of cases) {
            framework.it(contractCase.name, async () => {
              const exit = await runClosed(
                Effect.exit(Effect.scoped(Effect.provide(contractCase.run, layer()))),
              );
              if (Exit.isFailure(exit)) {
                framework.fail(
                  `${key} (${mode}) ${contractCase.name}: ${Cause.pretty(exit.cause)}`,
                );
              }
            });
          }
        });
      }
      for (const exemption of storeSuite.exempt) {
        framework.it(`${key}.${exemption.operation} is exempt: ${exemption.reason}`, () => {});
      }
      storeSuite.tenancy?.(
        framework,
        plugin,
        [
          { name: `${key} (memory)`, run: (effect) => runnerOf(bundle("memory", key))(effect) },
          { name: `${key} (sql)`, run: (effect) => runnerOf(bundle("sql", key))(effect) },
        ],
        (effect) => runnerOf(bundle("sql", key))(effect),
      );
    }
  });
};
