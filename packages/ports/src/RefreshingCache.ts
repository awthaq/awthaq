// @awthaq/ports — RefreshingCache
//
// ECF-002 / JJS-002 / KRS-010: the caching policy every remote-JWKS consumer
// needs and was each getting wrong in its own way (a lite verifier that
// cached forever and refetched once per request on an unknown `kid`; an
// id_token verifier with a TTL but no single-flight). One small,
// transport-free helper so they share one policy:
//
// - **Single-flight.** Concurrent cold or expired reads share one load; the
//   loser of the race re-checks freshness after it gets the permit instead of
//   fetching again.
// - **TTL.** A loaded value is served for `ttl`, then reloaded on the next
//   read, so material removed from the source stops being trusted without a
//   restart.
// - **Rate-limited refresh on a miss.** `refreshOnMiss` is for "the caller
//   holds a token naming a key we do not have": it reloads at most once per
//   `minRefetchInterval` (only such forced reloads count, so the first miss
//   after a cold load is always honoured), so a flood of tokens with garbage
//   `kid`s costs one outbound request per interval, not one per request.
// - **Negative caching.** A failed load is remembered for `minRefetchInterval`
//   so an unreachable source is not hammered either; the failure is replayed
//   until the interval elapses.
//
// Time comes from `Clock`, so `TestClock` drives it in tests. The helper is
// deliberately unaware of HTTP or key formats: `load` is any effect.

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface RefreshingCacheOptions {
  /** How long a successfully loaded value is served before the next read reloads it. */
  readonly ttl: Duration.Input;
  /** The minimum gap between two loads triggered by `refreshOnMiss`, and how long a failed load is replayed. */
  readonly minRefetchInterval: Duration.Input;
}

export interface RefreshingCache<A, E> {
  /** The cached value, loading (single-flight) when absent or older than `ttl`. */
  readonly get: Effect.Effect<A, E>;
  /**
   * Reload because a caller could not find what it needed in the cached value.
   * Performs the load only if the last *forced* reload is at least
   * `minRefetchInterval` old; otherwise returns what the last load produced.
   */
  readonly refreshOnMiss: Effect.Effect<A, E>;
}

interface Attempt<A, E> {
  readonly at: number;
  readonly exit: Exit.Exit<A, E>;
}

export const make = <A, E>(
  load: Effect.Effect<A, E>,
  options: RefreshingCacheOptions,
): Effect.Effect<RefreshingCache<A, E>> =>
  Effect.gen(function* () {
    const ttl = Duration.toMillis(options.ttl);
    const minRefetch = Duration.toMillis(options.minRefetchInterval);
    const last = yield* Ref.make(Option.none<Attempt<A, E>>());
    const lastForcedAt = yield* Ref.make(Option.none<number>());
    const permit = yield* Semaphore.make(1);

    const reload = Effect.gen(function* () {
      const exit = yield* Effect.exit(load);
      const at = yield* Clock.currentTimeMillis;
      yield* Ref.set(last, Option.some({ at, exit }));
      return yield* exit;
    });

    const usable = (attempt: Attempt<A, E>, now: number) =>
      now - attempt.at < (Exit.isSuccess(attempt.exit) ? ttl : minRefetch);

    const get = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const seen = yield* Ref.get(last);
      if (Option.isSome(seen) && usable(seen.value, now)) return yield* seen.value.exit;
      return yield* permit.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(last);
          const later = yield* Clock.currentTimeMillis;
          if (Option.isSome(current) && usable(current.value, later)) {
            return yield* current.value.exit;
          }
          return yield* reload;
        }),
      );
    });

    const refreshOnMiss = permit.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(last);
        const forcedAt = yield* Ref.get(lastForcedAt);
        const now = yield* Clock.currentTimeMillis;
        if (
          Option.isSome(current) &&
          Option.isSome(forcedAt) &&
          now - forcedAt.value < minRefetch
        ) {
          return yield* current.value.exit;
        }
        yield* Ref.set(lastForcedAt, Option.some(now));
        return yield* reload;
      }),
    );

    return { get, refreshOnMiss };
  });
