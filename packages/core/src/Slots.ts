// @awthaq/core — Slots
//
// spec/behaviors/03-ports-slots-hooks-registries.md, BEH-EA-017/019/021,
// and spec/decisions/012-slots-exclusive-registries-aggregate.md
// (ADR-EA-012). A slot is a `Context.Reference` with a fail-closed default
// that at most one plugin may override (BEH-EA-021) — `define` gives it a
// literal, introspectable key (`awthaq/slot/${Name}`, the same
// `AuthPlugin`/`HookPoint` convention), and `override` is how a plugin
// claims one, with a real, working conflict check.
//
// **BEH-EA-012's `SlotConflict<P>` is a runtime check here, not the
// compile-time `Auth.make` type error its own illustration shows — a
// confirmed, structural limitation of this effect version, not a
// scoping choice.** `Auth.ts`'s `Validate<P>` catches `DuplicateId`/
// `MissingDep` by walking each plugin's `layer`'s `RIn`/`ROut` types
// pairwise; `SlotConflict<P>` would need the same walk over `ROut` for a
// shared slot identifier. But `Context.Reference<Shape>` is declared
// `extends Service<never, Shape>` — its `Identifier` is fixed to `never` —
// so `Layer.effect(someSlot, impl)`'s own `Layer.Success<...>` (`ROut`) is
// `never`, confirmed empirically (`Layer.Success<typeof
// Layer.effect(MyRef, ...)>` resolves to `never` in this effect version,
// not `MyRef`'s own identity). A `never` vanishes from a union rather than
// appearing in it, so no pairwise walk over two plugins' `ROut` types can
// ever observe that either one overrode a slot — the type-level mechanism
// `SlotConflict<P>` needs simply has nothing to see. (This is *why*
// `Context.Reference` behaves this way: a Reference is designed to be
// resolvable — via its default — with no requirement ever appearing in
// anyone's `RIn` either; the same property that makes it safe to use with
// zero ceremony when no plugin overrides it is what makes an override
// invisible to `ROut`-based type-level conflict detection.)
//
// `override` instead does what `RateLimits.ts`'s `rule` already does for
// BEH-EA-107's own type-level gap: enforce the check at `Layer`-build time,
// through an explicit, `owner`-scoped registration — `SlotsRegistry`, the
// same per-composition-service pattern `RateLimits.ts`'s own header comment
// explains (never module-level state, so unrelated compositions/tests never
// share one registry and one test's read never freezes another's writes).
//
// Unlike `RateLimits.rule`, providing `SlotsRegistry` is optional, not
// required: `override`'s own requirement is only the implementation
// `Effect`'s own `R` — `Effect.serviceOption` looks the registry up without
// ever placing it in `RIn`, so a plugin using `override` (like
// `@awthaq/roles`'s `Roles`) does not force every caller to also
// provide `Slots.layer`. An application that wants the real conflict check
// provides `Slots.layer` once, application-wide, the same way it opts into
// `RateLimits.layer` or `AuthEvents.layer` today; one that doesn't still
// gets the correct default/override *value* semantics (BEH-EA-021's actual
// runtime behavior), just without the conflict check.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/**
 * The only thing `Slots` ever needs from a plugin: its `id`, for naming a
 * claim. Deliberately narrower than `AuthPlugin.Any` (which also declares
 * `layer`): a plugin that claims a slot from inside its own `static
 * readonly layer = Slots.override(Self, ...)` initializer (as
 * `@awthaq/roles`'s `Roles` does) would otherwise force TypeScript to
 * resolve `Self`'s entire structural shape — `layer` included — to check it
 * against the parameter type, while that very `layer` field's type is what
 * the initializer is computing (`TS7022`, a real circularity, not a style
 * question an annotation would paper over). `{ readonly id: string }` never
 * touches `layer`, so no such cycle can arise.
 */
export interface PluginOwner {
  readonly id: string;
}

export type Key<Name extends string> = `awthaq/slot/${Name}`;

/** BEH-EA-021: a `Context.Reference` (fail-closed default, real override semantics) with a literal, introspectable `key`. */
export interface Slot<Name extends string, Shape> extends Context.Reference<Shape> {
  readonly key: Key<Name>;
}

/**
 * BEH-EA-017/019/021: declares a slot. Curried on `Shape` alone (mirroring
 * `AuthPlugin.Service<Self, Shape>()`'s own shape) so `Name` is inferred as
 * a literal from the call site rather than requiring a second explicit type
 * argument.
 */
export const define =
  <Shape>() =>
  <const Name extends string>(
    name: Name,
    options: { readonly defaultValue: () => Shape },
  ): Slot<Name, Shape> => {
    const key: Key<Name> = `awthaq/slot/${name}`;
    const reference = Context.Reference<Shape>(key, options);
    const statics: { readonly key: Key<Name> } = { key };
    return Object.assign(reference, statics);
  };

/** BEH-EA-012/INV-EA-004: two plugins claimed the same slot. */
export class SlotConflict extends Data.TaggedError("SlotConflict")<{
  readonly slot: string;
  readonly firstOwner: string;
  readonly secondOwner: string;
  readonly message: string;
}> {}

/** Reachable only if a slot is claimed after `claimed` has already read (and so frozen) the list once — a composition-order bug, not a normal-flow error (BEH-EA-024's "frozen at first read"). */
export class SlotsFrozen extends Data.TaggedError("SlotsFrozen")<{
  readonly message: string;
}> {}

export interface ClaimedSlot {
  readonly slot: string;
  readonly owner: string;
}

export interface SlotsRegistryShape {
  readonly claim: (
    owner: PluginOwner,
    slot: { readonly key: string },
  ) => Effect.Effect<void, SlotConflict>;
  /** Every slot claimed so far — frozen the first time it is read (BEH-EA-024). */
  readonly claimed: Effect.Effect<ReadonlyArray<ClaimedSlot>>;
}

export class SlotsRegistry extends Context.Service<SlotsRegistry, SlotsRegistryShape>()(
  "awthaq/core/SlotsRegistry",
) {}

export const layer: Layer.Layer<SlotsRegistry> = Layer.effect(
  SlotsRegistry,
  Effect.gen(function* () {
    const claims = yield* Ref.make<ReadonlyArray<ClaimedSlot>>([]);
    const frozen = yield* Ref.make<ReadonlyArray<ClaimedSlot> | undefined>(undefined);

    const claim: SlotsRegistryShape["claim"] = (owner, slot) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(claims)).find((entry) => entry.slot === slot.key);
        if (existing !== undefined) {
          return yield* Effect.fail(
            new SlotConflict({
              slot: slot.key,
              firstOwner: existing.owner,
              secondOwner: owner.id,
              message: `awthaq: slot "${slot.key}" is overridden by both "${existing.owner}" and "${owner.id}"`,
            }),
          );
        }
        if ((yield* Ref.get(frozen)) !== undefined) {
          return yield* Effect.die(
            new SlotsFrozen({
              message:
                "awthaq: slot claims are frozen once read (e.g. by introspection) — every slot must be claimed before that point",
            }),
          );
        }
        yield* Ref.update(claims, (current) => [...current, { slot: slot.key, owner: owner.id }]);
      });

    const claimed: SlotsRegistryShape["claimed"] = Effect.gen(function* () {
      const already = yield* Ref.get(frozen);
      if (already !== undefined) return already;
      const current = yield* Ref.get(claims);
      yield* Ref.set(frozen, current);
      return current;
    });

    return SlotsRegistry.of({ claim, claimed });
  }),
);

/**
 * BEH-EA-021: a plugin overrides a slot by providing its implementation —
 * `override` also registers the claim (best-effort — see this module's own
 * header comment for why `SlotsRegistry` is looked up, never required) so a
 * composition that provides `Slots.layer` gets a real conflict check for
 * free.
 *
 * `owner` is typed `PluginOwner` (`{ readonly id: string }`), not
 * `AuthPlugin.Any` — see that interface's own doc comment for why: a plugin
 * that (like `@awthaq/roles`'s `Roles`) passes itself here, eagerly,
 * from inside its own `static readonly layer = Slots.override(Roles, ...)`
 * initializer, must never need TypeScript to resolve anything beyond `id`
 * to check the argument, since `Roles.layer`'s own type is simultaneously
 * what that initializer is computing.
 */
export const override = <Name extends string, Shape, E, R>(
  owner: PluginOwner,
  slot: Slot<Name, Shape>,
  implementation: Effect.Effect<Shape, E, R>,
): Layer.Layer<never, E | SlotConflict, R> =>
  Layer.effect(slot, implementation).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.flatMap(Effect.serviceOption(SlotsRegistry), (registry) =>
          Option.isSome(registry) ? registry.value.claim(owner, slot) : Effect.void,
        ),
      ),
    ),
  );
