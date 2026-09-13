/**
 * Shared state for the tooling smoke test — not part of the effect-auth
 * specification. Mirrors qadi's World/WorldLive shape (a Context.Service
 * wrapping one Ref, rebuilt fresh per Scenario via a Layer) at the smallest
 * possible scale, so the real spec suite's future World services have a
 * proven, minimal pattern to start from.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface WorldShape {
  readonly count: Ref.Ref<number>;
}

export class World extends Context.Service<World, WorldShape>()("features/SmokeWorld") {}

/** Built fresh per Scenario — no state survives between Scenarios. */
export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({ count: yield* Ref.make(0) });
  }),
);

export const readCount = Effect.fn("features.smoke.readCount")(function* () {
  const { count } = yield* World;
  return yield* Ref.get(count);
});

export const setCount = Effect.fn("features.smoke.setCount")(function* (value: number) {
  const { count } = yield* World;
  yield* Ref.set(count, value);
});

export const addToCount = Effect.fn("features.smoke.addToCount")(function* (amount: number) {
  const { count } = yield* World;
  yield* Ref.update(count, (current) => current + amount);
});
