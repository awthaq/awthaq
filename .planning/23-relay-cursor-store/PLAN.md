# Plan 23: `RelayCursorStore` is a store port with matched adapters

| Property | Value |
|---|---|
| Strength | Worth exploring (batch index). This plan finds it a small, sure win: one ADR-EA-028 violation, one documented composition that does not compile, and the last core store outside the plan 02 seam |
| Dependency category | ports & adapters (a new port in `@awthaq/ports`, a `Ref` adapter beside it, a SQL adapter in `@awthaq/sql`, both in the `Persistence` bundles, cases in `StoreContract`) |
| Wave / order | **Before plan 16.** It is the warm-up for 16: it builds the first SQL store adapter that owns its statements with no repository behind it, and it removes the one core importer of `Repositories` that is not `Persistence.ts` (`core/src/EventRelay.ts:45`). See §8 for why 23 → 16 and not the reverse |
| Fixes live bugs | A relay cursor outage is a defect, not `StoreUnavailable` (ADR-EA-028), and a transient `SQLITE_BUSY` on the cursor write is never retried, so the whole batch is redelivered · the composition `README.md:390` and `packages/webhooks/README.md:19` document (`EventRelay.layerCursorSql` beside `Persistence.sql()`) does not compile, because `layerCursorSql` needs `Repositories.RelayCursorRepository`, which nothing documents and no bundle provides |
| Execution tickets | `.scratch/relay-cursor-store/issues/NN-*.md`, one per phase (`docs/agents/issue-tracker.md`) |

Every file:line below was checked against the tree at `fc990c88` (2026-10-17). Re-check them before editing; no earlier plan of this batch is expected to touch these files, but plan 15 (host composition) may land first and move composition code.

---

## 1. Summary, goals, non-goals

### Summary

Plan 02 (ADR-EA-041) put every core store behind a port in `@awthaq/ports`, with a `Ref` adapter beside it, a SQL adapter in `@awthaq/sql`, both in the matched `Persistence` bundles, and the contract in `@awthaq/test`'s `StoreContract`. It left one store out on purpose ("No move of `RelayCursorStore` … aligning it is a follow-up", plan 02 §1 non-goals). That store is the event relay's persisted position:

- The port is declared inside the domain module that uses it (`packages/core/src/EventRelay.ts:63-71`), with both adapters inline (`:73-85` memory, `:87-98` SQL).
- The SQL adapter is a shallow pass-through over a repository in `@awthaq/sql` (`packages/sql/src/Repositories.ts:2490-2552`), so core imports `Repositories` (`EventRelay.ts:45`).
- `get`/`set` declare no error and `orDie` every `SqlError` (`EventRelay.ts:93`, `:95`). ADR-EA-028 says an infrastructure failure is the typed `StoreUnavailable`, never a defect.
- It is in neither bundle. Every composition provides it separately, and a SQL composition must also provide the repository (`core/test/EventRelay.test.ts:65-66` is the only place that does).
- It has no adapter contract: one repository-level case in `packages/sql/test/contract.ts:819-830`, and the relay suite (`EventRelay.test.ts`) over each adapter.

This plan makes it a store port like the other five. `RelayCursorStore` moves to `@awthaq/ports` with a `Ref` adapter, `RelayCursorStoreSql` in `@awthaq/sql` owns its two statements, both join `Persistence.memory`/`Persistence.sql()`, its cases join `StoreContract`, and both primitives fail with `StoreUnavailable`. It also makes `advance` monotonic (the stored position only moves forward in byte order), so two relays that share a name (the webhooks worker in every replica) can no longer move each other's cursor backwards.

### Goals

1. One port, `RelayCursorStore` in `@awthaq/ports`, with `get` and a monotonic `advance`, each atomic and failing only with `StoreUnavailable`.
2. `RelayCursorStore.layerMemory` beside it; `RelayCursorStoreSql.layer` in `@awthaq/sql` with its statements in the adapter (no repository).
3. Both bundles provide it, so `EventRelay.layer` and `Webhooks.Webhooks.background()` compose over `Persistence.sql()` with nothing else to provide for the position.
4. `StoreContract.relayCursor` runs on the `Ref` adapter, SQLite `:memory:`, SQLite WAL and Postgres (`pnpm test:pg`).
5. `EventRelay` no longer imports `@awthaq/sql`; `drainOnce` surfaces a cursor outage as `StoreUnavailable`.

### Non-goals

- A lease or lock giving one relay per name exclusive delivery (ADR-EA-030 decision 4 accepts duplicates; §10 Q2).
- Advancing the cursor in the same transaction as a SQL transport's enqueue (exactly-once enqueue for `@awthaq/webhooks`). The webhooks queue is already idempotent per `(endpoint, event)`.
- Rewinding a cursor (an operator replay). It has no caller; `startAfter` seeds a relay with no stored position (§10 Q3).
- Any change to `drainOnce`'s settle, batching, backoff or decode-stop behaviour.
- Moving the rest of `Repositories.ts`. That is plan 16, which runs after this plan.

---

## 2. Verified current state

### 2.1 The port, its adapters and its repository

| What | Where | Notes |
|---|---|---|
| Port shape | `core/src/EventRelay.ts:63-67` | `get: (name) => Effect<Option<string>>`, `set: (name, lastEventId) => Effect<void>`: no error channel |
| Service key | `EventRelay.ts:69-71` | `"awthaq/core/RelayCursorStore"` |
| Memory adapter | `EventRelay.ts:73-85` (`layerCursorMemory`) | a `Ref<ReadonlyMap>`, blind overwrite |
| SQL adapter | `EventRelay.ts:87-98` (`layerCursorSql`) | requires `SqlRepositories.RelayCursorRepository` (`:91`); `repo.get(name).pipe(Effect.orDie)` (`:93`); reads `DateTime.now` and `repo.set(...)` then `Effect.orDie` (`:95`) |
| Repository | `sql/src/Repositories.ts:2496-2552` | `getQuery` `SELECT "lastEventId" FROM auth_relay_cursor WHERE name = ?` (`:2521-2525`); `setQuery` a blind upsert `INSERT … ON CONFLICT (name) DO UPDATE SET "lastEventId" = excluded."lastEventId", "updatedAt" = excluded."updatedAt"` (`:2527-2539`); spans `RelayCursor.get`/`RelayCursor.set` (`:2541-2548`) |
| Table | `sql/src/CoreMigrations.ts:600-621` (migration 27) | `name TEXT PRIMARY KEY, "lastEventId" TEXT NOT NULL, "updatedAt"` (`TIMESTAMPTZ` / `TEXT`); no `tenantId`, not in `TenantScope`'s RLS table list (`TenantScope.ts:44-50`) |
| The only consumer | `EventRelay.drainOnce`, `EventRelay.ts:130-171` | `store.get(options.name)` (`:140`), `store.set(options.name, last.id)` (`:165`) after `transport.deliver` (`:164`) |
| The background loop | `EventRelay.layer`, `EventRelay.ts:179-218` | `Effect.catchCause` (`:190-202`) absorbs every failure, defects included, logs `auth.relay.failed`, counts `awthaq_relay_failures_total`, backs off |

### 2.2 Every composition that provides it

`grep -rn "layerCursorSql\|layerCursorMemory\|RelayCursorStore\|RelayCursorRepository" packages examples features spec docs README.md` (excluding `lib/` and the untracked `Repositories.ts-E`):

| Site | Uses | This plan |
|---|---|---|
| `packages/core/test/EventRelay.test.ts:55-58` | `EventRelay.layerCursorMemory` beside `AuditLog.layer` over `Persistence.memory` | bundle |
| `packages/core/test/EventRelay.test.ts:65-71` | `EventRelay.layerCursorSql` + `Layer.provide(Repositories.RelayCursorRepositoryLive)` (`:66`) | bundle |
| `packages/core/test/EventRelay.test.ts:93`, `:277` | type `EventRelay.RelayCursorStore`; `yield* EventRelay.RelayCursorStore` | port |
| `packages/webhooks/src/WebhookDelivery.ts:137-148` | `relayLayer`'s explicit `Layer` type names `EventRelay.RelayCursorStore` (the TS2883 exception) | port |
| `packages/webhooks/src/Webhooks.ts:852-858` | doc comment: "Requires `AuditLog`, a `RelayCursorStore`, …" | wording |
| `packages/webhooks/test/WebhooksBackground.test.ts:76`, `:187` | `EventRelay.layerCursorMemory` | `RelayCursorStore.layerMemory` |
| `packages/webhooks/test/WebhookDelivery.test.ts:184` | `EventRelay.layerCursorMemory` | same |
| `features/step-definitions/WebhooksWorld.ts:199`, `:210` | `EventRelay.layerCursorMemory` in `TestAuth.layer`'s `services`; `EventRelay.RelayCursorStore` in `AppServices` | `TestAuth` exposes it (§3.5) |
| `packages/sql/test/contract.ts:68`, `:819-830` | `Repositories.RelayCursorRepositoryLive` in `repositoriesLayer`; the one cursor case | moves to `StoreContract.relayCursor` |
| `README.md:390` | "provide `EventRelay.layerCursorSql` for a durable position (core migration 27) or `layerCursorMemory` for tests" | reworded |
| `packages/webhooks/README.md:19` | `Layer.provide(EventRelay.layerCursorSql)` | reworded |
| `spec/decisions/030-event-delivery-outbox-relay.md:26` | decision 4: "`RelayCursorStore.layerCursorSql`" (the name is wrong: it is `EventRelay.layerCursorSql`) | revised |
| `spec/overview.md:161-162` | core-API rows; `:161` cites ADR-EA-032 for the outbox (wrong: ADR-EA-030) | revised |
| `spec/behaviors/13-events.md:79` | BEH-EA-100's cross-process paragraph | revised |

No example (`examples/*`) composes the relay. No production composition in `packages/*/src` provides a cursor store; it is always the host's.

### 2.3 Live bugs, with repro sketches

**B1. A cursor outage is a defect (ADR-EA-028).** `EventRelay.ts:93` and `:95` `orDie` the repository's `SqlError | SchemaError`. Consequences:
- `drainOnce` is public. A host that schedules it itself (instead of `EventRelay.layer`) sees a defect for a database that is down, and cannot `catchTag("StoreUnavailable")` it to answer or retry.
- In the background loop, `describeFailure` (`core/src/Observability.ts:175-187`) logs `errorTag: "SqlError"` with the driver's message, where every other store logs `StoreUnavailable` once at the seam with the cause (ADR-EA-028 decision 1). Alerting keyed on the tag sees a different failure for the same outage.
- No transient retry. Every other SQL store write runs through `SqlStore.make(sql).write`, which retries a retryable `SqlError` (`SQLITE_BUSY`, deadlock) at the top level (`sql/src/SqlStore.ts:56-64`). The cursor write is not retried, so a busy database right after a successful `deliver` fails the tick, and the next tick redelivers the whole batch.

Repro (Phase 0 test, SQLite): migrate, rename the table (`ALTER TABLE auth_relay_cursor RENAME TO auth_relay_cursor_down`; SQLite reports "no such table", `classifySqliteError` makes it an `UnknownError`, which `StoreFailure` maps to `StoreUnavailable`), run `EventRelay.drainOnce`, and assert the exit is a typed failure tagged `StoreUnavailable` with `operation === "RelayCursorStore.get"`. Today the exit is a defect (`Cause.hasDies`).

**B2. The documented SQL composition does not compile.** `README.md:390` and `packages/webhooks/README.md:13-21` tell a host to provide `EventRelay.layerCursorSql`. Its requirement is `RelayCursorRepository | SqlClient` (it yields `SqlRepositories.RelayCursorRepository`, `EventRelay.ts:91`). `Persistence.sql()` provides only the five store repositories (`core/src/Persistence.ts:77-89`), and neither README mentions `Repositories.RelayCursorRepositoryLive`. A host that follows either README gets a missing-service type error naming an internal repository. Repro: a test module that builds `Webhooks.Webhooks.background().pipe(Layer.provide(EventRelay.layerCursorSql), …)` over `Persistence.sql()` fails `tsc`. After this plan, `Persistence.sql()` provides the cursor store and the README block is the whole composition.

**B3 (hardening, not a bug by ADR-EA-030). The cursor can move backwards.** `setQuery` is a blind upsert (`Repositories.ts:2533-2538`) and the memory `set` a blind overwrite (`EventRelay.ts:81-82`). ADR-EA-030 decision 4 accepts two processes running one name ("both deliver: safe, but run one per name"). But `@awthaq/webhooks` makes that the normal deployment: `Webhooks.background()` is part of the application layer, so every replica runs a relay named `"webhooks"` (`WebhookDelivery.ts` `RELAY_NAME`). A slower replica that delivered up to id 5 overwrites a faster one's id 10, and the next tick of every replica redelivers 6 to 10. The queue deduplicates, so nothing is sent twice, but each regression costs a full batch read and insert attempt per replica. A monotonic `advance` removes it (§3.1); §10 Q1 can keep the blind write.

**Doc drift found on the way:** `core/test/EventRelay.test.ts:1` and `spec/overview.md:161` cite ADR-EA-032 for the outbox relay; it is ADR-EA-030 (ADR-EA-032 is the observability substrate).

### 2.4 Tests today

| File | What | This plan |
|---|---|---|
| `packages/core/test/EventRelay.test.ts` (288 lines) | `suite(name, base)` over memory (`:267`) and SQLite (`:268`): 7 relay cases; one SQL-only durability case (`:270-288`) | stays a domain suite; both legs compose the bundles; one new outage case |
| `packages/sql/test/contract.ts:819-830` | "RelayCursor: get is empty until set, set upserts, and names are independent", on the four dialect suites | deleted; becomes `StoreContract.relayCursor` cases 1-3 |
| `packages/webhooks/test/*`, `features/…/34-webhooks.feature:289-298` (REQ for "the relay's cursor advances once the batch is queued") | the cursor through the relay | unchanged in meaning |

---

## 3. Target design

### 3.1 The port (`packages/ports/src/RelayCursorStore.ts`)

```ts
// @awthaq/ports — RelayCursorStore
//
// ADR-EA-030 decision 4, ADR-EA-041 (plan 23): where an event relay stopped. One position per relay
// `name`: the id of the last audit event its transport accepted. Every primitive is atomic and fails
// only with `StoreUnavailable` (ADR-EA-028). The bar for an adapter is `StoreContract.relayCursor`.
//
// `advance` only ever moves a position forward, in the byte order `AuditLogStore.pageAfter` replays
// in, so two relays that share a name (a worker in every replica) cannot pull each other back.
// The `Ref` adapter is single-process and test-grade (TRBS-005): a restarted relay begins again.

import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { StoreUnavailable } from "./Store.ts";

export interface RelayCursorStoreShape {
  /** The stored position of `name`; `None` before its first `advance`. Always authoritative. */
  readonly get: (name: string) => Effect.Effect<Option.Option<string>, StoreUnavailable>;
  /**
   * ATOMIC and MONOTONIC: stores `lastEventId` for `name` when there is no position yet or it is
   * after the stored one (byte order, `AuditLogStore.byIdAscending`); otherwise changes nothing.
   * `at` is the caller's clock reading. Idempotent, so an adapter may retry it.
   */
  readonly advance: (input: {
    readonly name: string;
    readonly lastEventId: string;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<void, StoreUnavailable>;
}

export class RelayCursorStore extends Context.Service<RelayCursorStore, RelayCursorStoreShape>()(
  "awthaq/ports/RelayCursorStore",
) {}

/** The ordering every adapter uses: code units, which for the ASCII ids the audit log mints are bytes. */
export const isAfter = (candidate: string, stored: string) => candidate > stored;

export const layerMemory = Layer.effect(
  RelayCursorStore,
  Effect.gen(function* () {
    const positions = yield* Ref.make(HashMap.empty<string, string>());
    return RelayCursorStore.of({
      get: (name) => Effect.map(Ref.get(positions), HashMap.get(name)),
      advance: ({ name, lastEventId }) =>
        Ref.update(positions, (all) => {
          const stored = HashMap.get(all, name);
          return Option.isSome(stored) && !isAfter(lastEventId, stored.value)
            ? all
            : HashMap.set(all, name, lastEventId);
        }),
    });
  }),
);
```

- `advance` answers `void`, not "did it move". The relay has no use for the answer, and a `boolean` would stop being exact once the SQL adapter retries a lost acknowledgement. No speculative return value.
- `isAfter` is the same code-unit comparison `AuditLogStore.byIdAscending` (`ports/src/AuditLogStore.ts:114-116`) documents. Reuse that module's helper if the executor prefers one definition (`byIdAscending({ id: a }, { id: b }) > 0`); either way the ordering is defined once per port file and stated in the contract.
- `RelayCursorStore.of({...})` checks the members against the shape; the arrow functions get their parameter types from it. No `as`, no annotation on the layer.
- Export it from `packages/ports/src/index.ts` (`export * as RelayCursorStore from "./RelayCursorStore.ts";`, alphabetical).

### 3.2 The SQL adapter (`packages/sql/src/RelayCursorStoreSql.ts`)

This is the first core SQL store with no repository behind it. It is the shape plan 16 gives the other five.

```ts
// @awthaq/sql — RelayCursorStoreSql
//
// Plan 23 (ADR-EA-041, ADR-EA-030 decision 4): the SQL adapter of `RelayCursorStore` over
// `auth_relay_cursor` (core migration 27). It owns its statements; there is no repository.
// - `get`: one primary read (a relay must never resume from a replica's stale position).
// - `advance`: one conditional upsert. `DO UPDATE … WHERE` the stored id sorts before the new one
//   (`COLLATE "C"` on Postgres, SQLite's default BINARY), so concurrent relays of one name only
//   move it forward. Idempotent, so it is retried on a transient failure at the top level.

import { RelayCursorStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { dialectFields, resolveDialect } from "./Models.ts";
import * as SqlStore from "./SqlStore.ts";

export const layer = Layer.effect(
  RelayCursorStore.RelayCursorStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* resolveDialect(sql);
    const wire = dialectFields(dialect);
    const { write, read } = SqlStore.make(sql);

    const getQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ lastEventId: Schema.String }),
      execute: (name) => sql`SELECT "lastEventId" FROM auth_relay_cursor WHERE name = ${name}`,
    });

    const advanceQuery = SqlSchema.void({
      Request: Schema.Struct({
        name: Schema.String,
        lastEventId: Schema.String,
        updatedAt: wire.dateTime,
      }),
      execute: (r) =>
        dialect === "pg"
          ? sql`INSERT INTO auth_relay_cursor (name, "lastEventId", "updatedAt")
                VALUES (${r.name}, ${r.lastEventId}, ${r.updatedAt})
                ON CONFLICT (name) DO UPDATE
                  SET "lastEventId" = excluded."lastEventId", "updatedAt" = excluded."updatedAt"
                  WHERE auth_relay_cursor."lastEventId" COLLATE "C" < excluded."lastEventId" COLLATE "C"`
          : sql`INSERT INTO auth_relay_cursor (name, "lastEventId", "updatedAt")
                VALUES (${r.name}, ${r.lastEventId}, ${r.updatedAt})
                ON CONFLICT (name) DO UPDATE
                  SET "lastEventId" = excluded."lastEventId", "updatedAt" = excluded."updatedAt"
                  WHERE auth_relay_cursor."lastEventId" < excluded."lastEventId"`,
    });

    return RelayCursorStore.RelayCursorStore.of({
      get: (name) =>
        getQuery(name).pipe(
          Effect.map(Option.map((row) => row.lastEventId)),
          Effect.withSpan("RelayCursor.get", {}, { captureStackTrace: false }),
          read("RelayCursorStore.get"),
        ),
      advance: ({ name, lastEventId, at }) =>
        advanceQuery({ name, lastEventId, updatedAt: at }).pipe(
          Effect.withSpan("RelayCursor.advance", {}, { captureStackTrace: false }),
          write("RelayCursorStore.advance"),
        ),
    });
  }),
);
```

- `Models.dialectFields(dialect)` is the record-store codec helper plugins already use (`sql/README.md:9`, BEH-EA-033); check its exact field name for the timestamp codec (`dateTime`) when writing the adapter.
- The span names keep the repository's `RelayCursor.<op>` convention (EOTS-008); attributes stay empty (a relay name is not personal, but nothing needs it).
- `read` is `SqlStore`'s classify-never-retry; `write` retries a transient failure at the top level only and is safe because `advance` is idempotent.
- Export from `packages/sql/src/index.ts` (`export * as RelayCursorStoreSql from "./RelayCursorStoreSql.ts";`) and add one sentence to its header comment.
- Under Postgres RLS nothing changes: the table carries no tenant and is not covered by `TenantScope.enableRls`.

### 3.3 The bundles (`packages/core/src/Persistence.ts`)

```ts
export const memory = Layer.mergeAll(
  UserStore.layerMemory,
  AccountStore.layerMemory,
  SessionStore.layerMemory,
  VerificationStore.layerMemory,
  AuditLogStore.layerMemory,
  RelayCursorStore.layerMemory,
  SqlTransaction.layerNoop,
);

export const sql = (options?: SqlOptions) =>
  Layer.mergeAll(
    UserStoreSql.layer,
    AccountStoreSql.layer,
    SessionStoreSql.layer,
    VerificationStoreSql.layer,
    AuditLogStoreSql.layer,
    RelayCursorStoreSql.layer,
    SqlTransaction.layerSql,
  ).pipe(Layer.provide(/* the repository layers, unchanged until plan 16 */));
```

`RelayCursorStoreSql.layer` needs only `SqlClient`, so `Persistence.sql()`'s requirement stays `SqlClient | Encryption` (`SqlRequirements`, `Persistence.ts:61`). Update the module header (`:1-16`): "the six stores".

**Why the cursor belongs in the bundle although the relay is opt-in.** The bundle's point is that a composition cannot pair stores and a transaction from two worlds (ADR-EA-041 decision 4). The cursor has the same hazard: `layerCursorMemory` beside `Persistence.sql()` silently loses the position on every restart. A cursor store costs nothing until a relay reads it (no state in memory beyond an empty `HashMap`; migration 27 is part of `coreMigrations` already). A host that swaps it does so as for any store (`Layer.merge(Persistence.sql(), MyCursor.layer)`).

### 3.4 `EventRelay` (`packages/core/src/EventRelay.ts`)

- Delete `RelayCursorStoreShape`, `RelayCursorStore`, `layerCursorMemory` and `layerCursorSql` (`:63-98`) and the `@awthaq/sql` import (`:45`). Import `RelayCursorStore` from `@awthaq/ports`.
- `drainOnce` (`:130-171`): `const store = yield* RelayCursorStore.RelayCursorStore;` and replace `:165` with

  ```ts
  yield* store.advance({ name: options.name, lastEventId: last.id, at: yield* DateTime.now });
  ```

  Its error channel is unchanged in type (`transport.deliver`'s `unknown` already absorbs the union); a cursor outage now arrives as `StoreUnavailable` instead of a defect. Update the doc comment (`:124-129`) to name it.
- `layer` (`:179-218`): no change. Its `catchCause` still logs and backs off; it now logs `errorTag: "StoreUnavailable"` for a cursor outage.
- Header comment (`:23-27`): "The position lives in `RelayCursorStore` (`@awthaq/ports`; `Persistence.memory` and `Persistence.sql()` both provide one, SQL: `auth_relay_cursor`, core migration 27). `advance` only moves forward, so relays sharing a name cannot pull each other back; they still both deliver (run one per name)."
- Line `:177`: "Requires `AuditLog`, an `EventTransport` and a `RelayCursorStore` (both `Persistence` bundles provide one)."

After this phase `grep -n "@awthaq/sql" packages/core/src/EventRelay.ts` returns nothing.

### 3.5 `TestAuth` exposes the cursor store

`packages/test/src/TestAuth.ts` provides the stores of `Persistence.memory` / `Persistence.sql()` to the domain layers with `Layer.provide`, so they are not in its output (plan 02 "Decisions taken", phase 7). A relay is an application layer, so a host that tests `Webhooks.background()` through `TestAuth.layer` needs the position in the output. Add `RelayCursorStore` to the base's output in both record modes, from the same bundle value the base already uses (so it is the one instance), the way `SqlTransaction` is kept in the output today. `features/step-definitions/WebhooksWorld.ts:199` then drops `EventRelay.layerCursorMemory`, and `AppServices` (`:210`) names `RelayCursorStore.RelayCursorStore`. If a projection of one service out of the merged bundle needs more than `Layer.provideMerge` of the bundle, keep the memory leg as `RelayCursorStore.layerMemory` and the SQL leg as `RelayCursorStoreSql.layer`, both merged into the base output.

### 3.6 What stays outside

- `EventTransport` stays in `core/src/EventRelay.ts`. It is an application-provided port with one consumer and no store semantics (`deliver`'s `E` is `unknown` by design, ADR-EA-030 decision 2).
- `startAfter`, `settleDelay`, batching and the decode stop stay in `drainOnce`.
- Erasure and export: the cursor holds an audit event id, no personal data. It joins neither registry.

---

## 4. Phased migration

Phase gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`; phases 2 and 3 also `pnpm test:pg` (a SQL adapter is added). Plan gate: `pnpm check && pnpm test:pg`. One ticket per phase under `.scratch/relay-cursor-store/issues/`.

### Phase 0: pin B1 (failing test first)

1. `packages/core/test/EventRelay.test.ts`: add, after the durability `describe` (`:270-288`):

   ```ts
   describe("EventRelay over SQLite: a cursor-store outage (ADR-EA-028)", () => {
     it.effect("drainOnce fails with StoreUnavailable naming the cursor read, never a defect", () =>
       withTransport(() =>
         Effect.gen(function* () {
           const sql = yield* SqlClient.SqlClient;
           yield* sql`ALTER TABLE auth_relay_cursor RENAME TO auth_relay_cursor_down`;
           const exit = yield* Effect.exit(EventRelay.drainOnce(options("down")));
           assert.isTrue(Exit.isFailure(exit));
           if (Exit.isFailure(exit)) {
             assert.isFalse(Cause.hasDies(exit.cause));
             const failure = Cause.squash(exit.cause);
             assert.strictEqual(Predicate.isTagged(failure, "StoreUnavailable"), true);
           }
         }).pipe(Effect.provide(SqlBase)),
       ),
     );
   });
   ```

   It fails today (the `orDie` makes it a defect). Use `Cause`/`Predicate` helpers as available in rc.116 (`Cause.hasDies` or `Cause.isDie`; check `node_modules/effect/src/Cause.ts`); assert `operation === "RelayCursorStore.get"` once the port exists (Phase 3). Commit it with Phase 3 if the repo forbids a red commit; write it first either way.

### Phase 1: the port, the `Ref` adapter and the contract (additive)

Files:
1. `packages/ports/src/RelayCursorStore.ts` (§3.1); `packages/ports/src/index.ts` export.
2. `packages/test/src/StoreContract.ts`: a `relayCursor` section (cases in §5.1), header comment ("`auditLog`, `verification`, `accounts`, `users`, `sessions` and `relayCursor`").
3. `packages/test/test/support/storeContract.ts`: `runOnMemory` runs `StoreContract.relayCursor` on `RelayCursorStore.layerMemory`.
4. `packages/ports/test/RelayCursorStore.test.ts` only if a `Ref`-specific case exists (none is planned; skip the file).
5. `spec/overview.md`: a Ports-surface row for `RelayCursorStore` (check 13 of `spec/scripts/check-drift.mjs` diffs the Ports inventory against source).
6. `.changeset/relay-cursor-store-port.md` (§6.4).

### Phase 2: the SQL adapter and the bundles (additive)

Files:
1. `packages/sql/src/RelayCursorStoreSql.ts` (§3.2); `packages/sql/src/index.ts` export and header line.
2. `packages/test/test/support/storeContract.ts`: `runOnSql` runs `relayCursor` over `sqlStores(client)` plus `RelayCursorStoreSql.layer` (so `StoreContract.sql.test.ts` covers SQLite and, under `test:pg`, Postgres; `StoreContract.file.test.ts` covers the WAL file).
3. `packages/core/src/Persistence.ts` (§3.3).
4. `packages/sql/test/RelayCursorStoreSql.test.ts`: the adapter-only cases (§5.2).

### Phase 3: `EventRelay` onto the port; remove the old store (breaking)

Files:
1. `packages/core/src/EventRelay.ts` (§3.4).
2. `packages/sql/src/Repositories.ts`: delete the RelayCursor section (`:2490-2552`).
3. `packages/sql/test/contract.ts`: drop `Repositories.RelayCursorRepositoryLive` from `repositoriesLayer` (`:68`) and delete the case at `:818-830`.
4. `packages/core/test/EventRelay.test.ts`: `MemoryBase` = `AuthEvents.layer` and `AuditLog.layer` over `Persistence.memory`, with the bundle's `RelayCursorStore` in the output (`Layer.provideMerge(Persistence.memory)` beneath `AuditLog.layer`, or merge `RelayCursorStore.layerMemory` if the base must stay a provide); `SqlBase` likewise over `SqlStores` (`:25`), dropping `layerCursorSql` and `RelayCursorRepositoryLive` (`:65-66`). The `suite` type (`:93`) and `:277` name `RelayCursorStore.RelayCursorStore`. Fix the header's ADR id (`:1`, ADR-EA-030). Add the §5.3 cases; finish the Phase 0 assertion on `operation`.
5. `packages/webhooks/src/WebhookDelivery.ts:147`: `RelayCursorStore.RelayCursorStore` (import from `@awthaq/ports`); `Webhooks.ts:852-858` doc: "a `RelayCursorStore` (both `Persistence` bundles provide one)".
6. `packages/webhooks/test/WebhooksBackground.test.ts:76`, `:187`, `WebhookDelivery.test.ts:184`: `RelayCursorStore.layerMemory`.
7. `packages/test/src/TestAuth.ts` (§3.5); `features/step-definitions/WebhooksWorld.ts:199`, `:210`.
8. Docs: `README.md:390` ("the position is `RelayCursorStore`, which `Persistence.sql()` (durable, core migration 27) and `Persistence.memory` (tests) already provide"); `packages/webhooks/README.md:19` (delete the `Layer.provide(EventRelay.layerCursorSql)` line; the comment under `background()` lists "`AuditLog` and the `RelayCursorStore` (both from `Persistence.sql()`)"); `packages/core/README.md` if it lists `EventRelay`'s exports.
9. Spec, ADR, traceability (§6). Changeset `.changeset/relay-cursor-store-bundles.md` (breaking, §6.4).

Gate: phase gate, `pnpm test:bdd` (the webhooks scenarios at `34-webhooks.feature:289-298` must pass unchanged), `pnpm spec:verify:strict`, `pnpm check:readmes`, `pnpm test:pg`.

---

## 5. Test plan

Replace, don't layer: the cursor's own behaviour is tested once, at the port, on every adapter. `EventRelay.test.ts` keeps only relay behaviour.

### 5.1 `StoreContract.relayCursor` (`packages/test/src/StoreContract.ts`)

Run on the `Ref` adapter, SQLite `:memory:`, Postgres (`test:pg`) and the WAL file:

1. "get is None for a name that was never advanced" (replaces half of `contract.ts:819`).
2. "advance stores the first position, and a later id replaces it" (`event-1` then `event-2` → `Some("event-2")`).
3. "names are independent: advancing one leaves another untouched" (the rest of `contract.ts:819`).
4. "advance never moves a position backwards: an earlier id, or the same id again, changes nothing" (B3).
5. "advance compares ids as bytes: of two uuidv7-shaped ids differing only in a later hex digit, the larger wins whatever the arrival order" (catches a locale collation on Postgres; mirrors the `pageAfter` byte-order case of `StoreContract.auditLog`).
6. "advance under concurrency: 8 racing advances of one name with ids `e-1` … `e-8` leave the largest" (`StoreContract.race`).

Cases fix `at` themselves (`StoreContract`'s `at(minutes)`), never the ambient clock.

### 5.2 `packages/sql/test/RelayCursorStoreSql.test.ts` (new, SQLite)

1. "a SqlError is StoreUnavailable naming the primitive that failed": rename the table, then `get` → `operation === "RelayCursorStore.get"`, `advance` → `"RelayCursorStore.advance"`; `assert.notProperty(failure, "cause")`.
2. "advance writes updatedAt from the caller's clock": read the raw row.

### 5.3 `packages/core/test/EventRelay.test.ts`

- Keep the seven `suite` cases and the durability case, over the bundles.
- New: the Phase 0 outage case (now asserting the operation label).
- New: "a relay that redelivers an older batch (a second relay of the same name) does not pull the position back": two `drainOnce` runs of one name with a transport that delays the first; assert `store.get` ends at the larger id. One case, over memory and SQLite through `suite`.
- New (type-level, in the same file): `EventRelay.layer({ name: "x" })` provided `Persistence.sql()`, `AuthEvents.layer`, an `EventTransport` and a `SqlClient` builds with no further layer. It does not compile before Phase 3 (B2) and is the regression for it.

### 5.4 Deleted, by name

- `packages/sql/test/contract.ts`: "RelayCursor: get is empty until set, set upserts, and names are independent" (replaced by §5.1 cases 1-3, on more adapters than before, but not libSQL: plan 16 adds the libSQL runner for every `StoreContract` port).

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour spec

- `spec/behaviors/13-events.md` → rev 1.8. BEH-EA-100's cross-process paragraph (`:79`): "… from a persisted position (`RelayCursorStore`, a store port in `@awthaq/ports` with a `Ref` adapter and `RelayCursorStoreSql` over `auth_relay_cursor`, both provided by the `Persistence` bundles; `advance` only moves forward, in byte order) …; a cursor-store outage is `StoreUnavailable` (ADR-EA-028)". Change-history line.

### 6.2 Decisions

- **ADR-EA-030 rev 1.2.** Decision 4: "The position is a store port, `RelayCursorStore` (`@awthaq/ports`; `RelayCursorStoreSql` over `auth_relay_cursor`, core migration 27; a `Ref` adapter for tests), provided by `Persistence.memory` and `Persistence.sql()`. `advance` is monotonic (byte order): two processes running one name both deliver, safe but wasteful, and neither moves the other's position back." Fix the `RelayCursorStore.layerCursorSql` name.
- **ADR-EA-041 rev 1.2.** Decision 4: the bundles provide `RelayCursorStore` too. Decision 6: `StoreContract.relayCursor`. Decision 3 (placement) unchanged. A revision note: "Plan 23: the relay's position joins the seam: plan 02's non-goal is closed."
- **ADR-EA-028 rev 1.6.** Rollout: "`EventRelay`'s cursor store (`RelayCursorStore`) is converted: no `orDie` remains on it, and its write is retried on a transient failure (plan 23)."

### 6.3 Overview and traceability

- `spec/overview.md` rev 1.10: Ports table row `RelayCursorStore` ("the relay's persisted position (`get`, monotonic `advance`); `layerMemory`; the SQL adapter is `@awthaq/sql`'s `RelayCursorStoreSql`; the bar is `StoreContract.relayCursor` (ADR-EA-030, ADR-EA-041)"); core row `:162` becomes "`EventRelay`, `EventTransport` | opt-in outbox relay over the audit log and its transport port; the position is `RelayCursorStore` (Ports)"; `:161` ADR-EA-032 → ADR-EA-030.
- `spec/traceability.md` (new revision): the ADR-EA-030 row (`:183`) adds `packages/test/test/StoreContract.*.test.ts` (`relayCursor`) and `packages/sql/test/RelayCursorStoreSql.test.ts`; the ADR-EA-041 row (`:179`) lists `relayCursor`; the ADR-EA-028 row (`:170`) adds `EventRelay.test.ts` (the cursor outage).

### 6.4 Changesets (ADR-EA-034)

- Phase 1, `.changeset/relay-cursor-store-port.md`, `"@awthaq/ports": minor`, `"@awthaq/test": minor`:
  > `RelayCursorStore` is a store port in `@awthaq/ports` (`get`, a monotonic `advance`, both failing with `StoreUnavailable`), with `layerMemory`; `StoreContract.relayCursor` is the bar for an adapter (ADR-EA-030, ADR-EA-041).
- Phases 2-3, `.changeset/relay-cursor-store-bundles.md`, `"@awthaq/core": minor`, `"@awthaq/sql": minor`, `"@awthaq/webhooks": minor`, `"@awthaq/test": minor`:
  > `Persistence.memory` and `Persistence.sql()` provide the event relay's position, so `EventRelay.layer` and `Webhooks.Webhooks.background()` need nothing else for it; a cursor-store outage is `StoreUnavailable` instead of a defect, and a busy cursor write is retried instead of redelivering the batch (ADR-EA-028). The position only moves forward, so relays sharing a name no longer pull each other back (ADR-EA-030 rev 1.2).
  >
  > Migration: delete `EventRelay.layerCursorSql` / `EventRelay.layerCursorMemory` and `Repositories.RelayCursorRepositoryLive` from your composition (the bundle provides the store); `EventRelay.RelayCursorStore` is now `RelayCursorStore.RelayCursorStore` from `@awthaq/ports`, and its `set(name, id)` is `advance({ name, lastEventId, at })`. A custom implementation must make `advance` monotonic and pass `StoreContract.relayCursor`.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| A host that rewinds a cursor by calling `set` with an older id loses that ability | No caller in the repository does it; ADR-EA-030 offers `startAfter` for a relay with no position. §10 Q3 adds a `reset` primitive if the user wants one |
| `COLLATE "C"` on a non-"C" Postgres database changes the comparison relative to a stored value written before | The stored values are uuidv7 ids (ASCII hex and hyphens), whose order is the same under any collation of ASCII-only text in practice, and identical under `"C"`. Contract case 5 runs on Postgres under `test:pg` |
| The bundle now builds a cursor store in compositions that never relay | One `Ref` (memory) or one layer that prepares two statements (SQL). No query runs until a relay asks |
| `TestAuth`'s output gains a service; a test that provided its own cursor store gets two | `Layer.merge` order: the later wins. The only such site is `WebhooksWorld.ts:199`, edited in Phase 3 |
| TS2883 (declaration emit cannot name a type) on `Persistence.sql`'s widened output | The new service is a named public `Context.Service`; if emit still complains, follow the explicit-type exception `WebhookDelivery.relayLayer` documents (`:141-143`) |

**Rollback.** Phases 1 and 2 are additive and revert alone. Phase 3 reverts as one commit (the old `EventRelay` exports, the repository section and the contract case come back). No migration is added or changed.

---

## 8. Interactions with other plans

- **Order with plan 16 (sql-store-adapters): 23 first.** 16 makes `Repositories` private and folds it into the store adapters. With 23 still open, 16 would have to either leave one public repository (`RelayCursorRepository`, imported by `core/src/EventRelay.ts:45`), which defeats its goal, or move the cursor itself, which is this plan. 23 is also the small warm-up 16 wants: the first SQL adapter that owns its statements with no repository (§3.2), the first new `StoreContract` port since plan 02, and a bundle edit, all on a two-statement store. 16 then folds `RelayCursorStoreSql.layer` into its `CoreStoresSql` bundle and adds the libSQL runner that covers `relayCursor` too.
- **Plan 15 (host-composition):** the derived servable layer composes `Persistence.*`; it gets the cursor store for free. If 15 lands first and builds `TestAuth.layer` on its module, §3.5's "expose the cursor store" moves to wherever 15 decides the base output.
- **Plan 24 (memory-records-over-sqlite):** if it ever replaces core `Ref` adapters, `RelayCursorStore.layerMemory` is one more; the contract makes that swap safe.
- **Plan 02 (done):** this closes its §1 non-goal ("No move of `RelayCursorStore`").
- **Plan 09 (done) / its Q4:** whether the relay scrubs declared `pii` before a custom transport is unaffected; the cursor holds only an id.
- **Plans 11-14, 17-22:** no overlap.

---

## 9. Acceptance checklist

- [ ] `packages/ports/src/RelayCursorStore.ts` exists with `get`, a monotonic `advance` and `layerMemory`; exported from `@awthaq/ports`.
- [ ] `packages/sql/src/RelayCursorStoreSql.ts` owns its two statements; no `RelayCursorRepository` remains (`grep -rn RelayCursorRepository packages features` is empty).
- [ ] `Persistence.memory` and `Persistence.sql()` provide `RelayCursorStore`; `TestAuth`'s base exposes it.
- [ ] `grep -n "@awthaq/sql\|orDie" packages/core/src/EventRelay.ts` returns nothing; `layerCursorMemory`/`layerCursorSql` are gone.
- [ ] `StoreContract.relayCursor` (6 cases) passes on `Ref`, SQLite `:memory:`, WAL file and Postgres.
- [ ] The Phase 0 outage test passes with `operation === "RelayCursorStore.get"`; the bundle-only relay composition compiles.
- [ ] READMEs (root `:390`, webhooks `:19`) show the composition that compiles; `pnpm check:readmes` passes.
- [ ] BEH-EA-100, ADR-EA-030 rev 1.2, ADR-EA-041 rev 1.2, ADR-EA-028 rev 1.6, overview rev 1.10 and traceability are updated; `pnpm spec:verify:strict` passes.
- [ ] No `as`, no return-type annotation on a new Effect/Layer const.
- [ ] Two changesets with the `Migration:` text in §6.4.
- [ ] `pnpm check && pnpm test:pg` green.

---

## 10. Open questions only the user can answer

1. **Monotonic `advance`.** Make the position only move forward (recommended: it costs one `WHERE` clause and removes repeated batch re-reads when every replica runs the webhooks relay), or keep the blind upsert ADR-EA-030 shipped? Default: monotonic.
2. **A lease per relay name.** Should a relay take a lease (`claim(name, holder, ttl)`) so only one process delivers per name, instead of every replica delivering and the transport deduplicating? It is a real capability for multi-replica webhooks, but a new primitive, a heartbeat and a failover story. Default: no lease in this plan; ADR-EA-030 decision 4 ("run one per name, or accept the duplicates") stands, and a lease is its own plan if wanted.
3. **An operator rewind.** Add `reset(name, to: Option<string>)` for replaying from an earlier event? No caller exists. Default: not added (an operator can `DELETE FROM auth_relay_cursor WHERE name = …` and restart with `startAfter`).
4. **A deprecation alias.** Keep `EventRelay.RelayCursorStore` as a re-export of the port for one release? Default: no (pre-1.0, ADR-EA-034 allows the break; the `Migration:` line covers it).

---

## Decisions taken (implementation, 2026-10-18)

- **Open questions, defaults taken.** Q1 monotonic `advance`: yes. Q2 no lease per relay name. Q3 no `reset` primitive. Q4 no deprecation alias: `EventRelay.RelayCursorStore`, `layerCursorMemory` and `layerCursorSql` are removed (the changeset's `Migration:` line covers it).
- **Phases and commits.** Phase 1 (port, `Ref` adapter, `StoreContract.relayCursor`), Phase 2 (`RelayCursorStoreSql`, both bundles) and Phase 3 (`EventRelay` onto the port, repository and old store deleted, `TestAuth`, docs, spec) are three commits. Phase 0's failing outage test was written and seen red first, and ships with Phase 3 (no red commit); it asserts `operation === "RelayCursorStore.get"` and `Store.StoreUnavailable`.
- **Changesets.** `relay-cursor-store-port.md` with Phase 1; `relay-cursor-store-bundles.md` with Phase 3 (the `Migration:` text is only true once the old store is gone).
- **`TestAuth` exposes the cursor store** by merging `RelayCursorStore.layerMemory` (memory base) and `RelayCursorStoreSql.layer` (SQL base) beside `SqlTransaction` in the base's output; they are the same layer values the bundles contain, so the build shares one instance. `WebhooksWorld` drops its own cursor layer.
- **Tests.** The cursor's own behaviour is tested once, at the port (`StoreContract.relayCursor`, 6 cases, on `Ref`, SQLite `:memory:`, WAL file, Postgres); `contract.ts`'s repository case was deleted. `EventRelay.test.ts` gains the outage case, a late-finishing-older-batch case (over memory and SQLite, via `suite`) and the bundle-only composition type check.
- **Spec revisions.** BEH 13-events 1.10, ADR-EA-030 1.2, ADR-EA-041 1.2, ADR-EA-028 1.7 (the plan said 1.6; 1.6 was taken by plan 11), overview 1.11 (Ports row, Phase 1) and 1.12 (core row, Phase 3), traceability 1.42.
- **Not done.** The per-phase tickets under `.scratch/relay-cursor-store/issues/` were not written.
