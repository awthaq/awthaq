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
 * RBS-003: the memory store's observable size — tests and saturation
 * metrics read it, and `layerStoreMemoryWith` provides it next to the store.
 */
export interface RateLimiterMemoryStatsShape {
  readonly size: Effect.Effect<number>;
}

export class RateLimiterMemoryStats extends Context.Service<
  RateLimiterMemoryStats,
  RateLimiterMemoryStatsShape
>()("awthaq/ports/RateLimiterMemoryStats") {}

export interface MemoryStoreOptions {
  /** Hard cap on live buckets. Bucket keys embed attacker-chosen input (emails, identifiers), so the map must not grow with it. */
  readonly maxBuckets: number;
  /** How often expired buckets are reclaimed even if their key never comes back. */
  readonly sweepInterval: Duration.Input;
}

// At the cap, eviction frees a tenth of the room in one pass instead of one
// bucket per insert: a key spray against a full map would otherwise pay a
// full O(n) scan on every request.
const evictionRetainRatio = 0.9;

/**
 * BEH-EA-105: fixed-window counter. `Ref.modify` reads and advances each
 * key's bucket in one step — under concurrent callers, every caller sees a
 * distinct, already-incremented count, never a stale pre-increment read
 * (the check-then-act race BEH-EA-105 rules out).
 *
 * RBS-003: bounded. A scoped sweeper drops buckets whose window has elapsed,
 * and inserting a new key into a full map first drops the expired buckets,
 * then the earliest-expiring live ones. Evicting a live bucket forgives that
 * key's count; that is the price of a hard memory bound, and picking the
 * earliest `resetAt` keeps it to the buckets that were closest to forgiving
 * themselves anyway. Single-process only: a multi-replica deployment needs a
 * shared store.
 */
export const layerStoreMemoryWith = (options: MemoryStoreOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const buckets = yield* Ref.make(HashMap.empty<string, Bucket>());
      const retained = Math.floor(options.maxBuckets * evictionRetainRatio);

      const dropExpired = (state: HashMap.HashMap<string, Bucket>, now: DateTime.Utc) =>
        HashMap.filter(state, (bucket) => DateTime.isLessThan(now, bucket.resetAt));

      const makeRoom = (state: HashMap.HashMap<string, Bucket>, now: DateTime.Utc) => {
        const live = dropExpired(state, now);
        if (HashMap.size(live) < options.maxBuckets) return live;
        const byResetAt = Array.from(live).sort(
          ([, a], [, b]) => DateTime.toEpochMillis(a.resetAt) - DateTime.toEpochMillis(b.resetAt),
        );
        return HashMap.fromIterable(byResetAt.slice(byResetAt.length - retained));
      };

      const increment: RateLimiterStoreShape["increment"] = (key, window) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return yield* Ref.modify(buckets, (state) => {
            const existing = HashMap.get(state, key);
            if (Option.isSome(existing) && DateTime.isLessThan(now, existing.value.resetAt)) {
              const next: Bucket = {
                count: existing.value.count + 1,
                resetAt: existing.value.resetAt,
              };
              return [next, HashMap.set(state, key, next)];
            }
            const next: Bucket = { count: 1, resetAt: DateTime.addDuration(now, window) };
            // A stale row for this very key is replaced, not a reason to evict others.
            const room = HashMap.remove(state, key);
            const base = HashMap.size(room) < options.maxBuckets ? room : makeRoom(room, now);
            return [next, HashMap.set(base, key, next)];
          });
        });

      const sweep = Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* Ref.update(buckets, (state) => dropExpired(state, now));
      });
      yield* Effect.sleep(options.sweepInterval).pipe(
        Effect.andThen(sweep),
        Effect.forever,
        Effect.forkScoped,
      );

      return Context.make(RateLimiterStore, RateLimiterStore.of({ increment })).pipe(
        Context.add(
          RateLimiterMemoryStats,
          RateLimiterMemoryStats.of({ size: Effect.map(Ref.get(buckets), HashMap.size) }),
        ),
      );
    }),
  );

/** RBS-003: the default bounded memory store — 100k buckets, swept every minute. */
export const layerStoreMemory = layerStoreMemoryWith({
  maxBuckets: 100_000,
  sweepInterval: "1 minute",
});

/**
 * BEH-EA-112: a limiter that never rejects, under any iteration count —
 * `TestAuth.layer`'s own default, so a test that signs in fifty times in a
 * loop doesn't fail for a reason that has nothing to do with what it tests.
 */
export const layerPermissive: Layer.Layer<RateLimiter> = Layer.succeed(
  RateLimiter,
  RateLimiter.of({ consume: () => Effect.void }),
);
