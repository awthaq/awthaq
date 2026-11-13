// @awthaq/test — the verdict machinery `StoreContract` and `RecordsContract` share
//
// Plan 37 (ADR-EA-041 decisions 6 and 9): the core bar and the plugin bar are one bar. A case is data
// (a name and an `Effect` over the store); an operation of a store's interface carries a verdict next
// to its cases (`read`, `write`, `atomic` with at least one `race` case, or `exempt` with a reason);
// `classify` turns a suite's verdicts into the registered entries. Neither contract owns a copy.
import * as Effect from "effect/Effect";

/** One named property of a store. `R` is the store (and whatever the case needs besides). */
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

/** Every case of every operation as a named entry (`<operation> [<verdict>]: <case>`), plus the exemptions. */
export const classify = <R>(operations: Readonly<Record<string, Verdict<R>>>) => {
  const entries: Array<Entry> = [];
  const exempt: Array<{ readonly operation: string; readonly reason: string }> = [];
  const add = (operation: string, verdict: Entry["verdict"], cases: ReadonlyArray<Case<R>>) => {
    for (const contractCase of cases) {
      entries.push({
        operation,
        verdict,
        case: {
          name: `${operation} [${verdict}]: ${contractCase.name}`,
          run: contractCase.run,
        },
      });
    }
  };
  for (const [operation, verdict] of Object.entries<Verdict<R>>(operations)) {
    if ("exempt" in verdict) exempt.push({ operation, reason: verdict.exempt });
    else if ("atomic" in verdict) {
      add(operation, "atomic", verdict.atomic);
      add(operation, "race", verdict.race);
    } else if ("read" in verdict) add(operation, "read", verdict.read);
    else add(operation, "write", verdict.write);
  }
  return { entries, exempt };
};
