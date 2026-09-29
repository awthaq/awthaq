// @awthaq/core — ErasureRegistry
//
// The registry half of `Erasure.ts` (CSG-001, wayfinder ticket 30), split into a
// leaf module so `Hooks.HooksLive` — the layer every composition already
// provides — can carry the registry (`Hooks.ts` cannot import `Erasure.ts`, which
// imports it for `BeforeUserDelete`). See `Erasure.ts` for the design.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type { UserId } from "./Users.ts";

/** What a contribution is told about the user being erased. The email is carried so a plugin can sweep rows keyed by address (an invitation addressed to the user). */
export interface ErasureSubject {
  readonly userId: UserId;
  readonly email: string;
}

export interface ErasureContribution {
  /** The contributing plugin's id (or `<plugin>.<part>`). */
  readonly id: string;
  /** Lower runs first; ties break by id. */
  readonly order?: number;
  /**
   * Deletes this plugin's rows for the user. It must fail (or die) if it cannot
   * — that aborts the erasure and rolls it back — and must be idempotent.
   */
  readonly erase: (subject: ErasureSubject) => Effect.Effect<void>;
}

/** A contribution registered after the registry was first read — a composition-order bug. */
export class ErasureRegistryFrozen extends Data.TaggedError("ErasureRegistryFrozen")<{
  readonly id: string;
  readonly message: string;
}> {}

export interface ErasureRegistryShape {
  readonly register: (contribution: ErasureContribution) => Effect.Effect<void>;
  /** Every registered contribution in run order; the first read freezes the registry. */
  readonly contributions: Effect.Effect<ReadonlyArray<ErasureContribution>>;
}

export class ErasureRegistry extends Context.Service<ErasureRegistry, ErasureRegistryShape>()(
  "awthaq/core/ErasureRegistry",
) {}

/** The registry, one per composition (like a hook point's, ADR-EA-028). */
export const registryLayer: Layer.Layer<ErasureRegistry> = Layer.effect(
  ErasureRegistry,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<ErasureContribution>>([]);
    const frozen = yield* Ref.make(false);
    const register: ErasureRegistryShape["register"] = (contribution) =>
      Effect.gen(function* () {
        if (yield* Ref.get(frozen)) {
          return yield* Effect.die(
            new ErasureRegistryFrozen({
              id: contribution.id,
              message: `awthaq: erasure contribution "${contribution.id}" registered after the first erasure — every contribution must be installed before the registry is first read`,
            }),
          );
        }
        yield* Ref.update(entries, (current) => [...current, contribution]);
      });
    const contributions: ErasureRegistryShape["contributions"] = Effect.gen(function* () {
      yield* Ref.set(frozen, true);
      return (yield* Ref.get(entries)).toSorted(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    });
    return ErasureRegistry.of({ register, contributions });
  }),
);

/**
 * A plugin's erasure, as a `Layer` its own `layer` includes (`AuthPlugin.layer`'s
 * `contributes` option). `make` resolves the plugin's own record stores once, at
 * build, and returns the closure that erases one user — so the closure carries no
 * further requirement. The layer requires `ErasureRegistry`: a composition that
 * installs the plugin without providing it fails to compile.
 */
export const contribute = <E, R>(options: {
  readonly id: string;
  readonly order?: number;
  readonly make: Effect.Effect<ErasureContribution["erase"], E, R>;
}): Layer.Layer<never, E, ErasureRegistry | Exclude<R, Scope.Scope>> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ErasureRegistry;
      const erase = yield* options.make;
      yield* registry.register({
        id: options.id,
        ...(options.order === undefined ? {} : { order: options.order }),
        erase,
      });
    }),
  );
