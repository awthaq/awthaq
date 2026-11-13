// @awthaq/test — StoreContract
//
// Plan 02 (ADR-EA-041): the bar any adapter of a core store port must clear. The domain services
// (`Sessions`, `Users`, `Accounts`, `Verification`, `AuditLog`) are written once over a port whose
// primitives are atomic by contract; a store backend (the `Ref` adapters in `@awthaq/ports`, the
// SQL adapters in `@awthaq/sql`, a third party's KV `SessionStore`) is acceptable when every case
// below passes on it, concurrency cases included.
//
// Cases are data: a name and an `Effect` over the port, so this module needs no test runner. `run`
// (plan 37) owns the modes: it is handed the host's `describe`/`it` and runs every suite on the
// shipped bundles (`Persistence.memory`, or `CoreStoresSql.layer` over a migrated client, sealed
// or not), a FRESH bundle and `TestClock` for every case. A third party runs one suite on its own
// adapter with `runSuite`. Cases never read the ambient clock for expiry: every store primitive
// takes the instant it judges at. A "concurrent" case runs `CONCURRENCY` calls under
// `Effect.all(..., { concurrency: "unbounded" })` and asserts exact counts.

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Persistence } from "@awthaq/core";
import {
  type AccountStore,
  type AuditLogStore,
  RateLimiter,
  type RelayCursorStore,
  type SessionStore,
  SqlTransaction,
  type UserStore,
  type VerificationStore,
} from "@awthaq/ports";
import { CoreMigrations, CoreStoresSql, RateLimiterStoreSql } from "@awthaq/sql";
import {
  type Case,
  CONCURRENCY,
  type Operations,
  race,
  type Verdict,
} from "./internal/contract.ts";
import { accounts } from "./internal/storeContract/accounts.ts";
import { auditLog } from "./internal/storeContract/auditLog.ts";
import { rateLimiterStore } from "./internal/storeContract/rateLimiterStore.ts";
import { relayCursor } from "./internal/storeContract/relayCursor.ts";
import { sessions } from "./internal/storeContract/sessions.ts";
import { type Suite } from "./internal/storeContract/suite.ts";
import { userFieldColumns, users } from "./internal/storeContract/users.ts";
import { verification } from "./internal/storeContract/verification.ts";
import * as TestEncryption from "./TestEncryption.ts";
import type { TestFramework } from "./TestFramework.ts";

export { CONCURRENCY, type Case, type Operations, race, type Verdict };
export { type Suite, suite } from "./internal/storeContract/suite.ts";

/** The parts of a suite the runners read (a suite is invariant in its port, so the runners take its shape). */
interface Registrable {
  readonly store: { readonly key: string };
  readonly entries: Suite<unknown>["entries"];
  readonly exempt: Suite<unknown>["exempt"];
  readonly sql: Suite<unknown>["sql"];
}

/** One case on a layer and a `TestClock` built afresh, failing the host test with the case's cause. */
const registerCase = (
  framework: TestFramework,
  adapter: string,
  contractCase: Case<unknown>,
  layer: Layer.Layer<never, unknown, unknown>,
): void => {
  framework.it(contractCase.name, async () => {
    const exit = await Effect.runPromiseWith(Context.makeUnsafe<unknown>(new Map()))(
      Effect.exit(
        Effect.scoped(
          Effect.provide(contractCase.run, Layer.provideMerge(layer, TestClock.layer())),
        ),
      ),
    );
    if (Exit.isFailure(exit))
      framework.fail(`${adapter} ${contractCase.name}: ${Cause.pretty(exit.cause)}`);
  });
};

const registerSuite = (
  framework: TestFramework,
  adapter: string,
  registrable: Registrable,
  layer: Layer.Layer<never, unknown, unknown>,
  withSql: boolean,
): void => {
  framework.describe(`StoreContract: ${adapter}`, () => {
    for (const { case: contractCase } of registrable.entries)
      registerCase(framework, adapter, contractCase, layer);
    if (withSql)
      for (const contractCase of registrable.sql)
        registerCase(framework, adapter, contractCase, layer);
    for (const exemption of registrable.exempt) {
      framework.it(`${exemption.operation} is exempt: ${exemption.reason}`, () => {});
    }
  });
};

/**
 * Any adapter of one port (a third party's KV `SessionStore`): the suite's entries, on a layer and a
 * `TestClock` built afresh per case. Not its `sql` cases: those read the shipped schema.
 */
export const runSuite = <Id>(
  framework: TestFramework,
  config: {
    readonly adapter: string;
    readonly suite: Suite<Id>;
    /** Provides the port and whatever the cases need. */
    readonly layer: Layer.Layer<never, unknown, unknown>;
  },
): void => registerSuite(framework, config.adapter, config.suite, config.layer, false);

/** One suite per core store port. */
export interface Suites {
  readonly auditLog: Suite<AuditLogStore.AuditLogStore>;
  readonly verification: Suite<VerificationStore.VerificationStore>;
  readonly accounts: Suite<AccountStore.AccountStore>;
  readonly users: Suite<UserStore.UserStore>;
  readonly sessions: Suite<SessionStore.SessionStore>;
  readonly relayCursor: Suite<RelayCursorStore.RelayCursorStore>;
  readonly rateLimiterStore: Suite<RateLimiter.RateLimiterStore>;
}

export const suites = {
  auditLog,
  verification,
  accounts,
  users,
  sessions,
  relayCursor,
  rateLimiterStore,
} satisfies Suites;

export type Mode =
  | { readonly mode: "memory" }
  | {
      /** `sql`: every suite and its sql cases on `CoreStoresSql.layer()`. `sealed`: users and sessions on `{ encryptPii: true }`. */
      readonly mode: "sql" | "sealed";
      readonly label: string;
      readonly client: Layer.Layer<SqlClient.SqlClient, unknown>;
    };

/** The ports `encryptPii` changes (`CoreStoresSql.layer`): the only ones the sealed bundle re-runs. */
const sealed = [users, sessions];

/** The core and rate-limiter migrations and the three user-field columns `Auth.make`'s linker would add, over `client`. */
const migratedClient = (client: Layer.Layer<SqlClient.SqlClient, unknown>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      yield* addUserFieldColumns;
      yield* RateLimiterStoreSql.migrate;
    }),
  ).pipe(Layer.provide(client));

/** What `Auth.make`'s linker generates for a plugin's declared user fields: nullable scalar columns on `users`. */
const addUserFieldColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql.onDialectOrElse({
    pg: () => Effect.succeed({ text: "TEXT", real: "DOUBLE PRECISION", flag: "BOOLEAN" }),
    orElse: () => Effect.succeed({ text: "TEXT", real: "REAL", flag: "INTEGER" }),
  });
  yield* sql.unsafe(`ALTER TABLE users ADD COLUMN contract_text ${columns.text}`);
  yield* sql.unsafe(`ALTER TABLE users ADD COLUMN contract_real ${columns.real}`);
  yield* sql.unsafe(`ALTER TABLE users ADD COLUMN contract_flag ${columns.flag}`);
});

/** Every core store of the `Ref` bundle, plus the rate limiter's (which `Persistence` does not carry). */
const memoryBundle = Layer.merge(Persistence.memory, RateLimiter.layerStoreMemory);

const portName = (registrable: Registrable): string =>
  registrable.store.key.slice(registrable.store.key.lastIndexOf("/") + 1);

/** Every suite's registration, on the shipped bundles: `Persistence.memory`, or `CoreStoresSql.layer` over a migrated client. */
export const run = (framework: TestFramework, mode: Mode): void => {
  if (mode.mode === "memory") {
    for (const registrable of Object.values(suites))
      registerSuite(framework, `${portName(registrable)} (Ref)`, registrable, memoryBundle, false);
    framework.describe("StoreContract: coverage", () => {
      framework.it("every core store Persistence.memory provides has a suite", async () => {
        const provided = await Effect.runPromiseWith(Context.makeUnsafe<unknown>(new Map()))(
          Layer.build(memoryBundle).pipe(
            Effect.map((context) => Array.from(context.mapUnsafe.keys())),
            Effect.scoped,
          ),
        );
        // The transaction, the memory limiter's stats and the layer build's own memo map are not stores.
        const notStores: ReadonlyArray<string> = [
          SqlTransaction.SqlTransaction.key,
          RateLimiter.RateLimiterMemoryStats.key,
          Layer.CurrentMemoMap.key,
        ];
        const stores = provided.filter((key) => !notStores.includes(key)).sort();
        const named = Object.values(suites)
          .map((registrable) => registrable.store.key)
          .sort();
        if (stores.join() !== named.join())
          framework.fail(
            `Persistence.memory provides [${stores.join(", ")}], the suites cover [${named.join(", ")}]`,
          );
      });
    });
    return;
  }
  const migrated = migratedClient(mode.client);
  const bundle = (options: CoreStoresSql.Options) =>
    Layer.merge(CoreStoresSql.layer(options), RateLimiterStoreSql.layerStoreSql).pipe(
      Layer.provide(TestEncryption.layer),
      Layer.provideMerge(mode.client),
      Layer.provideMerge(migrated),
    );
  if (mode.mode === "sealed") {
    for (const registrable of sealed)
      registerSuite(
        framework,
        `${portName(registrable)} (${mode.label})`,
        registrable,
        bundle({ encryptPii: true }),
        true,
      );
    return;
  }
  for (const registrable of Object.values(suites))
    registerSuite(
      framework,
      `${portName(registrable)} (${mode.label})`,
      registrable,
      bundle({}),
      true,
    );
};

export { auditLog, verification, accounts, users, sessions, relayCursor, rateLimiterStore };
export { userFieldColumns };
