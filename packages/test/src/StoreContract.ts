// @awthaq/test — StoreContract
//
// Plan 02 (ADR-EA-041): the bar any adapter of a core store port must clear. The domain services
// (`Sessions`, `Users`, `Accounts`, `Verification`, `AuditLog`) are written once over a port whose
// primitives are atomic by contract; a store backend (the `Ref` adapters in `@awthaq/ports`, the
// SQL adapters in `@awthaq/sql`, a third party's KV `SessionStore`) is acceptable when every case
// below passes on it, concurrency cases included.
//
// Cases are data: a name and an `Effect` over the port, so this module needs no test runner. A
// runner (`run`) is handed the host's `describe`/`it`, builds a FRESH layer for every case (a new
// `Ref`, a new `:memory:` database or a freshly reset Postgres schema) and fails the case with
// the error the effect failed with. Cases never read the ambient clock for expiry: every store
// primitive takes the instant it judges at, so a case fixes the time itself and passes on any
// runner. A "concurrent" case runs `CONCURRENCY` calls under `Effect.all(..., { concurrency:
// "unbounded" })` and asserts exact counts.
//
// Each port's cases are added with its adapters (`auditLog`, `verification`, `accounts`, `users`,
// `sessions`).

import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { TestFramework } from "./TestFramework.ts";

/** One named property of a store port. `R` is the port (and whatever the case needs besides). */
export interface Case<R> {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, R>;
}

/** How many callers a "concurrent" case races. */
export const CONCURRENCY = 8;

/** Races `CONCURRENCY` copies of `effect` and returns every outcome, in completion-independent order. */
export const race = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.all(
    Array.from({ length: CONCURRENCY }, () => effect),
    { concurrency: "unbounded" },
  );

export interface RunConfig<R> {
  /** The adapter under test, e.g. "SessionStore (Ref)". */
  readonly adapter: string;
  /** Built afresh for every case. */
  readonly layer: Layer.Layer<R, unknown>;
  readonly cases: ReadonlyArray<Case<R>>;
}

/** Registers every case of `config` with the host test framework. */
export const run = <R>(framework: TestFramework, config: RunConfig<R>): void => {
  framework.describe(`StoreContract: ${config.adapter}`, () => {
    for (const contractCase of config.cases) {
      framework.it(contractCase.name, () =>
        Effect.runPromise(Effect.scoped(contractCase.run.pipe(Effect.provide(config.layer)))),
      );
    }
  });
};
