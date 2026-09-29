// @awthaq/core — RateLimits
//
// spec/behaviors/14-rate-limiting.md, BEH-EA-107/108/110/111 — the
// domain-stratum half of rate limiting: which of a plugin's own endpoints
// it may throttle, and how those rules are aggregated and ordered for
// introspection. The port itself (`RateLimiter`, `RateLimitExceeded`, the
// fixed-window memory store) lives in `@awthaq/ports`'s
// `RateLimiter.ts` — see that module's own header comment for why the two
// halves are split this way.
//
// The registry is a real, scoped service (`RateLimitsRegistry`), not
// module-level mutable state: BEH-EA-111 aggregates rules from every
// installed plugin into one list *per application composition* — a bare
// module-level array would instead share one registry across every
// `Auth.make` call in the same process (two unrelated test suites, or two
// tenants, polluting each other's rule list, and one test's `registered()`
// read permanently freezing every later test's registrations, since
// BEH-EA-024 requires freezing at first read). Providing a fresh
// `RateLimits.layer` per composition — the same reason `AuthEvents.ts`'s
// `PubSub` and `HookPoint.ts`'s per-point registries are both scoped to a
// built service/closure rather than a module-level global — gives each
// composition (and each test) its own registry.
//
// BEH-EA-107 (`AuthRateLimits.rule({ group, endpoint, ... })` "MUST be
// rejected... unless `group` is one of P's own contract groups") is
// enforced when the rule's `Layer` actually runs, not at the type level: a
// plugin's own `contract.groups` (`AuthPlugin.Any["contract"]`) is a record
// keyed by group identifier, which is real, checkable data — but
// recovering that record's literal key union as a type (to make an
// out-of-scope `group` value a compile error the way `Auth.ts`'s
// `Validate<P>` makes a duplicate id one) would need `HttpApiGroup`'s own
// identifier parameter threaded through a second, parallel type-level
// plumbing exercise this module does not yet do. The check still runs at
// "compose time" in the sense BEH-EA-107 means — when the registry's Layer
// is built, before any request is served — a real, enforced guard, just
// not a type error at the call site the way `Validate<P>` gives for plugin
// composition itself.
//
// BEH-EA-111's "dependency order, then declared `order`, then rule id"
// resolved-order rule has the same gap `HookPoint.ts`'s own header comment
// documents for tap ordering, for the identical reason (a plugin's
// topological position isn't known at the point its own `layer` calls
// `rule`) — this module orders by declared `order` then registration
// sequence instead. A real `awthaq plugin list --graph` CLI command
// (BEH-EA-111's own example) is `@awthaq/cli`'s job, not built yet;
// `registered` is this module's own introspection primitive for it to call.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as AuthPlugin from "./AuthPlugin.ts";

/** BEH-EA-108: the built-in bucket-key strategies, plus an escape hatch for a plugin author who has already reasoned through the risk a fixed string key would otherwise carry (a caller-chosen value collectively locking out a NATed office, or an attacker-controlled bucket). */
export type RateLimitKey = "principal" | "ip" | ((input: unknown) => string);

export interface RuleInput {
  readonly group: string;
  readonly endpoint: string;
  readonly key: RateLimitKey;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly order?: number;
}

/** BEH-EA-107: `AuthRateLimits.rule` refuses a `group` outside the calling plugin's own contract. */
export class RateLimitScopeViolation extends Data.TaggedError("RateLimitScopeViolation")<{
  readonly plugin: string;
  readonly group: string;
  readonly message: string;
}> {}

/** Reachable only if a rule is registered after `registered()` has already read (and so frozen) the list once — a composition-order bug, not a normal-flow error (BEH-EA-024's "frozen at first read"). */
export class RateLimitsFrozen extends Data.TaggedError("RateLimitsFrozen")<{
  readonly message: string;
}> {}

export interface RegisteredRule extends RuleInput {
  readonly plugin: string;
  readonly sequence: number;
}

export interface RateLimitsRegistryShape {
  readonly register: (
    owner: AuthPlugin.Any,
    input: RuleInput,
  ) => Effect.Effect<void, RateLimitScopeViolation>;
  /** BEH-EA-111: every rule registered so far, ordered by declared `order` then registration sequence (see this module's own header comment for the full dependency-aware rule this stands in for) — frozen the first time it is read. */
  readonly registered: Effect.Effect<ReadonlyArray<RegisteredRule>>;
}

export class RateLimitsRegistry extends Context.Service<
  RateLimitsRegistry,
  RateLimitsRegistryShape
>()("awthaq/core/RateLimitsRegistry") {}

export const layer: Layer.Layer<RateLimitsRegistry> = Layer.effect(
  RateLimitsRegistry,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<RegisteredRule>>([]);
    const frozen = yield* Ref.make<ReadonlyArray<RegisteredRule> | undefined>(undefined);

    const register: RateLimitsRegistryShape["register"] = (owner, input) =>
      Effect.gen(function* () {
        if (!Object.hasOwn(owner.contract.groups, input.group)) {
          return yield* Effect.fail(
            new RateLimitScopeViolation({
              plugin: owner.id,
              group: input.group,
              message: `awthaq: plugin "${owner.id}" cannot rate-limit group "${input.group}", which is not one of its own contract groups`,
            }),
          );
        }
        if ((yield* Ref.get(frozen)) !== undefined) {
          return yield* Effect.die(
            new RateLimitsFrozen({
              message:
                "awthaq: rate-limit rules are frozen once read (e.g. by introspection) — every rule must be registered before that point",
            }),
          );
        }
        yield* Ref.update(entries, (current) => [
          ...current,
          { ...input, plugin: owner.id, sequence: current.length },
        ]);
      });

    const registered: RateLimitsRegistryShape["registered"] = Effect.gen(function* () {
      const already = yield* Ref.get(frozen);
      if (already !== undefined) return already;
      const sorted = (yield* Ref.get(entries)).toSorted(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.sequence - b.sequence,
      );
      yield* Ref.set(frozen, sorted);
      return sorted;
    });

    return RateLimitsRegistry.of({ register, registered });
  }),
);

/**
 * BEH-EA-107/108/110: a plugin contributes a rate-limit rule scoped to one
 * of its own contract groups. Returns a `Layer` (a registry contribution,
 * the same shape as a hook tap) so a plugin includes it in its own `layer`
 * composition the way it would any other capability — the composition must
 * also provide `RateLimits.layer` itself (once, application-wide) for these
 * contributions to land anywhere.
 */
export const rule = (
  owner: AuthPlugin.Any,
  input: RuleInput,
): Layer.Layer<never, RateLimitScopeViolation, RateLimitsRegistry> =>
  Layer.effectDiscard(
    Effect.flatMap(RateLimitsRegistry, (registry) => registry.register(owner, input)),
  );
