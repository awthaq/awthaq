// @awthaq/ports — RateLimiter
//
// spec/behaviors/14-rate-limiting.md, BEH-EA-105/106/109/112. No BEH-EA
// range is allocated for the Ports stratum's own package location yet
// (spec/traceability.md doesn't cross-reference stratum-to-package this
// finely), but BEH-EA-105 itself is explicit that `RateLimiter` "sits at
// stratum 2 alongside Crypto, KeyValueStore and PasswordHasher" — a
// capability an application provides, never a feature a plugin bundles
// (ADR-EA-010) — so it lives here, next to `Mailer`/`PasswordHasher`, not in
// `@awthaq/core`. `AuthRateLimits`, the per-plugin rule registry that
// will call into this port (BEH-EA-107/108/110/111), is the domain-stratum
// half and lives in `@awthaq/core`'s `RateLimits.ts`; this module has
// no dependency on it and knows nothing about plugins.
//
// `layerStoreMemory` implements a fixed-window counter — BEH-EA-105's
// documented default algorithm, "the simplest algorithm to implement
// correctly across every backing store... at the cost of allowing up to
// 2 × limit requests across a window boundary". A single `Ref.modify` per
// `increment` call makes the check (is this bucket still live?) and the
// write (record this attempt) one atomic step, closing the check-then-act
// race BEH-EA-105 calls out by name — the same reasoning `Verification.ts`'s
// in-memory `reserve` already relies on for its own "first caller wins"
// claim over a single `Ref`.
//
// BEH-EA-105's fail-open default belongs to `layer` (the `consume` logic),
// not to a store: `layerStoreMemory` is a plain in-process `Ref` and cannot
// itself become unreachable, so there is no outage for it to fail open
// against today. A store that legitimately can go unreachable (Redis, a SQL
// pool) is a documented future `RateLimiterStore` implementation — its
// `increment` would carry a real error channel for `layer` to catch and
// fail open (or, per BEH-EA-105's opt-out, reject) against; nothing about
// `layer`'s own shape needs to change to add one.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/** BEH-EA-106: exceeding a configured limit fails with this, never a generic or untyped error. */
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly key: string;
  readonly retryAfterMillis: number;
}> {}

export interface ConsumeInput {
  readonly key: string;
  readonly limit: number;
  readonly window: Duration.Input;
}

/** BEH-EA-105: the port a plugin requires and the application provides — never bundled by a plugin (ADR-EA-010). */
export interface RateLimiterShape {
  readonly consume: (input: ConsumeInput) => Effect.Effect<void, RateLimited>;
}

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()(
  "awthaq/ports/RateLimiter",
) {}

export interface Bucket {
  readonly count: number;
  readonly resetAt: DateTime.Utc;
}

/** The atomic primitive BEH-EA-105 requires of any backing store: one round trip both reads and advances a bucket. */
export interface RateLimiterStoreShape {
  readonly increment: (key: string, window: Duration.Input) => Effect.Effect<Bucket>;
}

export class RateLimiterStore extends Context.Service<RateLimiterStore, RateLimiterStoreShape>()(
  "awthaq/ports/RateLimiterStore",
) {}

/**
 * BEH-EA-105/109: the swappable half — `consume`'s logic (compare to
 * `limit`, compute `retryAfterMillis`) never changes; only the store
 * underneath changes, by providing a different `RateLimiterStore` Layer
 * (BEH-EA-109: a second `Layer.provide` for the same port shadows the
 * first, it does not merge with it).
 */
export const layer: Layer.Layer<RateLimiter, never, RateLimiterStore> = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const store = yield* RateLimiterStore;
    const consume: RateLimiterShape["consume"] = (input) =>
      Effect.gen(function* () {
        const bucket = yield* store.increment(input.key, input.window);
        if (bucket.count <= input.limit) return;
        const now = yield* DateTime.now;
        const retryAfterMillis = Math.max(
          0,
          DateTime.toEpochMillis(bucket.resetAt) - DateTime.toEpochMillis(now),
        );
        return yield* Effect.fail(new RateLimited({ key: input.key, retryAfterMillis }));
      });
    return RateLimiter.of({ consume });
  }),
);

/**
 * BEH-EA-105: fixed-window counter. `Ref.modify` reads and advances each
 * key's bucket in one step — under concurrent callers, every caller sees a
 * distinct, already-incremented count, never a stale pre-increment read
 * (the check-then-act race BEH-EA-105 rules out).
 */
export const layerStoreMemory: Layer.Layer<RateLimiterStore> = Layer.effect(
  RateLimiterStore,
  Effect.gen(function* () {
    const buckets = yield* Ref.make(HashMap.empty<string, Bucket>());
    const increment: RateLimiterStoreShape["increment"] = (key, window) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(buckets, (state) => {
          const existing = HashMap.get(state, key);
          const next: Bucket =
            Option.isSome(existing) && DateTime.isLessThan(now, existing.value.resetAt)
              ? { count: existing.value.count + 1, resetAt: existing.value.resetAt }
              : { count: 1, resetAt: DateTime.addDuration(now, window) };
          return [next, HashMap.set(state, key, next)];
        });
      });
    return RateLimiterStore.of({ increment });
  }),
);

/**
 * BEH-EA-112: a limiter that never rejects, under any iteration count —
 * `TestAuth.layer`'s own default, so a test that signs in fifty times in a
 * loop doesn't fail for a reason that has nothing to do with what it tests.
 */
export const layerPermissive: Layer.Layer<RateLimiter> = Layer.succeed(
  RateLimiter,
  RateLimiter.of({ consume: () => Effect.void }),
);
