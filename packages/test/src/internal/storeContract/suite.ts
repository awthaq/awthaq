// @awthaq/test — the suite builder of StoreContract (plan 37)
//
// Lives apart from `StoreContract.ts` so the per-port files can build their suites without importing
// the module that re-exports them (no import cycle).
import type * as Context from "effect/Context";
import type * as SqlClient from "effect/sql/SqlClient";
import { type Case, classify, type Entry, type Operations, type Verdict } from "../contract.ts";

/** A core store port's suite. Invariant in `Id`, as `RecordsContract.Suite` is: a suite built for one port cannot stand for another. */
export interface Suite<in out Id> {
  readonly store: Context.Key<Id, unknown>;
  readonly entries: ReadonlyArray<Entry>;
  readonly exempt: ReadonlyArray<{
    readonly operation: string;
    readonly reason: string;
  }>;
  /** Adapter-level cases that read rows or the schema directly. SQL and sealed modes only. */
  readonly sql: ReadonlyArray<Case<unknown>>;
}

/**
 * Builds a port's suite. `operations` is keyed by the port interface's operations: every one carries a
 * verdict, and a new operation without one does not compile. `R` is what a case needs besides the port.
 */
export const suite = <Id, Shape, R = never>(
  store: Context.Key<Id, Shape>,
  definition: {
    readonly operations: {
      readonly [K in keyof Operations<NoInfer<Shape>>]: Verdict<Id | R>;
    };
    readonly sql?: ReadonlyArray<Case<Id | R | SqlClient.SqlClient>>;
  },
): Suite<Id> => ({
  store,
  ...classify<Id | R>(definition.operations),
  sql: definition.sql ?? [],
});
