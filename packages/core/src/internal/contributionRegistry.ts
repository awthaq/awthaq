// The aggregating-registry mechanism `Erasure` and `DataExport` share (ADR-EA-012 style):
// contributions are collected in any order, sorted by declared `order` then id, and the
// first read freezes the registry — registering afterwards is a composition-order bug and
// a defect, never a silent no-op.

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export interface Contribution {
  readonly id: string;
  /** Lower runs first; ties break by id. */
  readonly order?: number | undefined;
}

export interface Store<C extends Contribution> {
  readonly register: (contribution: C) => Effect.Effect<void>;
  /** Every registered contribution in run order; the first read freezes the registry. */
  readonly contributions: Effect.Effect<ReadonlyArray<C>>;
}

/** `frozenDefect` builds the defect raised for a late registration. */
export const make = <C extends Contribution>(
  frozenDefect: (id: string) => unknown,
): Effect.Effect<Store<C>> =>
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<C>>([]);
    const frozen = yield* Ref.make(false);
    const register: Store<C>["register"] = (contribution) =>
      Effect.gen(function* () {
        if (yield* Ref.get(frozen)) {
          return yield* Effect.die(frozenDefect(contribution.id));
        }
        yield* Ref.update(entries, (current) => [...current, contribution]);
      });
    const contributions: Store<C>["contributions"] = Effect.gen(function* () {
      yield* Ref.set(frozen, true);
      return (yield* Ref.get(entries)).toSorted(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    });
    return { register, contributions };
  });
