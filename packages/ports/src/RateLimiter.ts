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
// not to a store. `layerStoreMemory` is a plain in-process `Ref` and cannot
// itself become unreachable, but a store that can (a SQL pool, Redis) carries
// a real error channel, `RateLimiterStoreUnavailable` (RBS-004), which
// `layer` catches and, per `RateLimiterConfig.onStoreUnavailable`, either
// fails open (the default) or rejects, so an outage of this defense-in-depth
// mechanism never surfaces as an unrelated 5xx.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/**
 * BEH-EA-106: exceeding a configured limit fails with this, never a generic or untyped error.
 *
 * RBS-010: named apart from the wire-level `Api.RateLimited` (two classes
 * sharing one `_tag` made `catchTag("RateLimited")` ambiguous), and carries
 * no bucket key — keys embed emails and IPs, and must not travel to whatever
 * logs the error.
 */
export class RateLimitExceeded extends Data.TaggedError("RateLimitExceeded")<{
  readonly retryAfterMillis: number;
}> {}

/**
 * RBS-004: a shared store (SQL, Redis) could not be reached or answered
 * unusably. `RateLimiter.layer` handles it per `RateLimiterConfig`; it never
 * reaches a caller of `consume`.
 */
export class RateLimiterStoreUnavailable extends Data.TaggedError("RateLimiterStoreUnavailable")<{
  readonly cause: unknown;
}> {}

/**
 * RBS-009: opt-in escalation for a rule. Each window in which the limit is
 * exceeded is a strike; the caller is then refused for
 * `window × factor^(strikes − 1)`, capped at `maxPenalty`, so an attacker who
 * simply waits out the fixed window pays more each time. Strikes are counted
 * over a `maxPenalty`-long window, so a caller who stays quiet that long
 * starts again from the plain window. Without it, a rule is the plain fixed
 * window BEH-EA-105 documents.
 */
export interface Escalation {
  readonly factor: number;
  readonly maxPenalty: Duration.Input;
}

export interface ConsumeInput {
  readonly key: string;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: Escalation | undefined;
}

/** BEH-EA-105: the port a plugin requires and the application provides — never bundled by a plugin (ADR-EA-010). */
export interface RateLimiterShape {
  readonly consume: (input: ConsumeInput) => Effect.Effect<void, RateLimitExceeded>;
  /**
   * BCR-006: the read half of a budget that only *failures* spend. Fails with the same
   * `RateLimitExceeded` `consume` would once the bucket for `key` already holds `limit` or more,
   * but never counts this call — so a caller can refuse an attempt *before* evaluating it (a
   * locked second factor must not get a free guess), and `consume` only on the failures it
   * should charge. An escalating rule's active block is honoured too. Fails open when the store
   * is unavailable, per `RateLimiterConfig` exactly like `consume`.
   */
  readonly check: (input: ConsumeInput) => Effect.Effect<void, RateLimitExceeded>;
  /**
   * NHS-005/BEH-EA-201: set by `layerPermissive`, which disables every rule, so
   * `awthaq doctor --build` can flag it left in a production composition.
   */
  readonly permissive?: true;
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
  readonly increment: (
    key: string,
    window: Duration.Input,
  ) => Effect.Effect<Bucket, RateLimiterStoreUnavailable>;
  /** RBS-009: read a bucket without advancing it — `None` when absent or its window has elapsed. */
  readonly peek: (key: string) => Effect.Effect<Option.Option<Bucket>, RateLimiterStoreUnavailable>;
}

export class RateLimiterStore extends Context.Service<RateLimiterStore, RateLimiterStoreShape>()(
  "awthaq/ports/RateLimiterStore",
) {}

export interface RateLimiterConfigShape {
  /**
   * BEH-EA-105: what `consume` does when the store is unavailable. `"allow"`
   * (the default) proceeds unthrottled and logs a warning; `"reject"` fails
   * closed with `RateLimitExceeded`.
   */
  readonly onStoreUnavailable: "allow" | "reject";
  /** The `retryAfterMillis` a fail-closed rejection carries — there is no bucket to derive one from. */
  readonly unavailableRetryAfter: Duration.Input;
}

const defaultRateLimiterConfig: RateLimiterConfigShape = {
  onStoreUnavailable: "allow",
  unavailableRetryAfter: "1 second",
};

/** BEH-EA-017's `Context.Reference`-with-default pattern: fail-open unless an application says otherwise. */
export const RateLimiterConfig = Context.Reference("awthaq/ports/RateLimiterConfig", {
  defaultValue: () => defaultRateLimiterConfig,
});

export const config = (partial: Partial<RateLimiterConfigShape>) =>
  Layer.succeed(RateLimiterConfig, { ...defaultRateLimiterConfig, ...partial });

// RBS-009: the strike and block buckets live in the same store as ordinary
// ones; this namespace keeps a caller-chosen key (an email ending in "#block")
// from ever naming another key's block row.
const escalationKeyPrefix = "ratelimit-escalation:";

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
    const policy = yield* RateLimiterConfig;
    // RBS-004: only the failure cause is logged, never the bucket key (BEH-EA-108).
    const onUnavailable = (error: RateLimiterStoreUnavailable) =>
      Effect.logWarning("awthaq: rate-limit store unavailable", error.cause).pipe(
        Effect.andThen(
          policy.onStoreUnavailable === "allow"
            ? Effect.succeed(undefined)
            : Effect.fail(
                new RateLimitExceeded({
                  retryAfterMillis: Duration.toMillis(policy.unavailableRetryAfter),
                }),
              ),
        ),
      );
    const untilMillis = (resetAt: DateTime.Utc, now: DateTime.Utc) =>
      Math.max(0, DateTime.toEpochMillis(resetAt) - DateTime.toEpochMillis(now));

    // Only the escalating path reaches these: a block is a bucket whose window is the penalty.
    const blockKey = (key: string) => `${escalationKeyPrefix}block:${key}`;
    const strikesKey = (key: string) => `${escalationKeyPrefix}strikes:${key}`;

    const consumeEscalating = (input: ConsumeInput, escalation: Escalation) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const block = yield* store.peek(blockKey(input.key));
        // Refused without touching the plain bucket: a blocked caller's retries must not extend anything.
        if (Option.isSome(block)) {
          return yield* new RateLimitExceeded({
            retryAfterMillis: untilMillis(block.value.resetAt, now),
          });
        }
        const bucket = yield* store.increment(input.key, input.window);
        if (bucket.count <= input.limit) return;
        const remaining = untilMillis(bucket.resetAt, now);
        // One strike per window: only the request that first crosses the limit counts.
        if (bucket.count > input.limit + 1) {
          return yield* new RateLimitExceeded({ retryAfterMillis: remaining });
        }
        const strikes = yield* store.increment(strikesKey(input.key), escalation.maxPenalty);
        const penalty = Math.min(
          Duration.toMillis(input.window) * escalation.factor ** (strikes.count - 1),
          Duration.toMillis(escalation.maxPenalty),
        );
        if (penalty > remaining) {
          yield* store.increment(blockKey(input.key), Duration.millis(penalty));
        }
        return yield* new RateLimitExceeded({ retryAfterMillis: Math.max(remaining, penalty) });
      });

    const consumePlain = (input: ConsumeInput) =>
      Effect.gen(function* () {
        const bucket = yield* store.increment(input.key, input.window);
        if (bucket.count <= input.limit) return;
        const now = yield* DateTime.now;
        return yield* new RateLimitExceeded({
          retryAfterMillis: untilMillis(bucket.resetAt, now),
        });
      });

    const consume: RateLimiterShape["consume"] = (input) =>
      (input.escalation === undefined
        ? consumePlain(input)
        : consumeEscalating(input, input.escalation)
      ).pipe(Effect.catchTag("RateLimiterStoreUnavailable", onUnavailable), Effect.asVoid);

    // BCR-006: peek, never increment. A block (escalation) is a bucket whose window is the penalty.
    const check: RateLimiterShape["check"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        if (input.escalation !== undefined) {
          const block = yield* store.peek(blockKey(input.key));
          if (Option.isSome(block)) {
            return yield* new RateLimitExceeded({
              retryAfterMillis: untilMillis(block.value.resetAt, now),
            });
          }
        }
        const bucket = yield* store.peek(input.key);
        if (Option.isSome(bucket) && bucket.value.count >= input.limit) {
          return yield* new RateLimitExceeded({
            retryAfterMillis: untilMillis(bucket.value.resetAt, now),
          });
        }
      }).pipe(Effect.catchTag("RateLimiterStoreUnavailable", onUnavailable), Effect.asVoid);
    return RateLimiter.of({ consume, check });
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

      const peek: RateLimiterStoreShape["peek"] = (key) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const existing = HashMap.get(yield* Ref.get(buckets), key);
          return Option.filter(existing, (bucket) => DateTime.isLessThan(now, bucket.resetAt));
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

      return Context.make(RateLimiterStore, RateLimiterStore.of({ increment, peek })).pipe(
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
 * RBS-007: the one-line real limiter for a single process — `layer` over the bounded memory
 * store. The documented default for anything that is not a test; multi-replica deployments
 * still need a shared store (`RateLimiterStoreSql.layerStoreSql`).
 */
export const layerMemory = layer.pipe(Layer.provide(layerStoreMemory));

/**
 * BEH-EA-112: a limiter that never rejects, under any iteration count —
 * `TestAuth.layer`'s own default, so a test that signs in fifty times in a
 * loop doesn't fail for a reason that has nothing to do with what it tests.
 *
 * Tests only, never production (NHS-005): it disables every rate-limit rule
 * every plugin registers. Production wiring is `layerMemory` or `layer` over a store.
 * RBS-007: the first `consume` — a rule actually running against it — logs one warning
 * saying so, so a test composition copied into production is not silently unprotected.
 */
export const layerPermissive = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const warned = yield* Ref.make(false);
    const warnOnce = Effect.flatMap(Ref.getAndSet(warned, true), (already) =>
      already
        ? Effect.void
        : Effect.logWarning(
            "awthaq: RateLimiter.layerPermissive is active — every registered rate-limit rule is disabled (tests only; use RateLimiter.layerMemory or a shared store in production)",
          ),
    );
    return RateLimiter.of({ consume: () => warnOnce, check: () => Effect.void, permissive: true });
  }),
);
