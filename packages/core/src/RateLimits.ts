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
// BEH-EA-111's "dependency order, then declared `order`, then plugin id"
// resolved-order rule is the one `HookPoint.compareTaps` implements for hook
// taps (JH-003), and `registered` sorts with that very comparator (P20a,
// REQ-EA-299/300: the registry used to order by declared `order` then
// registration sequence alone, so an import-order accident decided which of two
// unrelated plugins' rules listed first). Two rules of one plugin with the same
// `order` keep their registration sequence. `registered` is the introspection
// primitive a CLI listing of the rules would call.

import { Api } from "@awthaq/api";
import { ClientAddress, RateLimiter } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as AuthEvents from "./AuthEvents.ts";
import type * as AuthPlugin from "./AuthPlugin.ts";
import * as HookPoint from "./HookPoint.ts";
import * as Phone from "./Phone.ts";

/** BEH-EA-108: the built-in bucket-key strategies, plus an escape hatch for a plugin author who has already reasoned through the risk a fixed string key would otherwise carry (a caller-chosen value collectively locking out a NATed office, or an attacker-controlled bucket). */
export type RateLimitKey = "principal" | "ip" | ((input: unknown) => string);

export interface RuleInput {
  readonly group: string;
  readonly endpoint: string;
  readonly key: RateLimitKey;
  readonly limit: number;
  readonly window: Duration.Input;
  /** RBS-009: opt-in exponential penalty for repeat breaches. Off by default. */
  readonly escalation?: RateLimiter.Escalation;
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
  /** BEH-EA-111: every rule registered so far, ordered by dependency order, then declared `order`, then plugin id (`HookPoint.compareTaps`, the hook registry's own comparator), then registration sequence — frozen the first time it is read. */
  readonly registered: Effect.Effect<ReadonlyArray<RegisteredRule>>;
}

export class RateLimitsRegistry extends Context.Service<
  RateLimitsRegistry,
  RateLimitsRegistryShape
>()("awthaq/core/RateLimitsRegistry") {}

export const layer: Layer.Layer<RateLimitsRegistry> = Layer.effect(
  RateLimitsRegistry,
  Effect.gen(function* () {
    // The owner rides beside each rule (not on `RegisteredRule`, which is what callers see):
    // ordering needs its `dependsOn`, introspection only its id.
    const entries = yield* Ref.make<
      ReadonlyArray<{ readonly rule: RegisteredRule; readonly owner: AuthPlugin.Any }>
    >([]);
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
          { rule: { ...input, plugin: owner.id, sequence: current.length }, owner },
        ]);
      });

    const registered: RateLimitsRegistryShape["registered"] = Effect.gen(function* () {
      const already = yield* Ref.get(frozen);
      if (already !== undefined) return already;
      const sorted = (yield* Ref.get(entries))
        .toSorted(
          (a, b) =>
            HookPoint.compareTaps(
              { owner: a.owner, order: a.rule.order ?? 0 },
              { owner: b.owner, order: b.rule.order ?? 0 },
            ) || a.rule.sequence - b.rule.sequence,
        )
        .map((entry) => entry.rule);
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

/**
 * PV-241/BEH-EA-111: registers every rule `owner` declared statically (`AuthPlugin.Service`'s
 * `rateLimits`), so a plugin whose rules are all declared keeps one list, not two. `key` chooses each
 * rule's bucket strategy (`"ip"` and `"principal"` dimensions default to the built-ins; an
 * `identity`/`custom` rule has no strategy to guess, so it takes `key`'s answer or an opaque
 * per-rule key); `tune` lets a config override a declared default (a limit, a window). The registry
 * reports the tuned values, the manifest the declared ones.
 */
export const registerDeclared = (
  owner: AuthPlugin.Any,
  options?: {
    readonly key?: (rule: AuthPlugin.RateLimitDeclaration) => RateLimitKey | undefined;
    readonly tune?: (
      rule: AuthPlugin.RateLimitDeclaration,
    ) => Partial<Pick<RuleInput, "limit" | "window">> | undefined;
  },
) =>
  Effect.flatMap(RateLimitsRegistry, (registry) =>
    Effect.forEach(
      owner.rateLimits ?? [],
      (rule) =>
        registry.register(owner, {
          group: rule.group,
          endpoint: rule.endpoint,
          key:
            options?.key?.(rule) ??
            (rule.dimension === "ip" || rule.dimension === "principal"
              ? rule.dimension
              : () => `${rule.group}:${rule.name}`),
          limit: rule.limit,
          window: rule.window,
          ...options?.tune?.(rule),
        }),
      { discard: true },
    ),
  );

/** PV-241: how a plugin's runtime registrations differ from its declaration (all empty when they agree). */
export interface DeclarationDrift {
  /** Registered (group, endpoint) pairs no declaration names. */
  readonly undeclared: ReadonlyArray<string>;
  /** Declared (group, endpoint) pairs nothing registered. */
  readonly unregistered: ReadonlyArray<string>;
  /** Declared and registered, but with different limits or windows (a config-tuned plugin should compare under its defaults). */
  readonly mismatched: ReadonlyArray<string>;
}

const addressOf = (rule: { readonly group: string; readonly endpoint: string }) =>
  `${rule.group}.${rule.endpoint}`;

interface Sized {
  readonly limit: number;
  readonly window: Duration.Input;
}

const shapesOf = (rules: ReadonlyArray<Sized>) =>
  rules
    .map((rule) => `${rule.limit}/${Duration.toMillis(Duration.fromInputUnsafe(rule.window))}`)
    .toSorted()
    .join(",");

/**
 * PV-241/BEH-EA-111: the consistency check between a plugin's static `rateLimits` declaration and what
 * it actually registered (`RateLimitsRegistry.registered`), by (group, endpoint) and, per pair, the
 * multiset of (limit, window). A plugin's test asserts all three lists empty, so the declaration
 * `plugin list --rules` prints cannot drift from the rules enforced.
 */
export const declarationDrift = (
  owner: AuthPlugin.Any,
  registered: ReadonlyArray<RegisteredRule>,
): DeclarationDrift => {
  const declared = owner.rateLimits ?? [];
  const mine = registered.filter((rule) => rule.plugin === owner.id);
  const declaredAddresses = new Set(declared.map(addressOf));
  const registeredAddresses = new Set(mine.map(addressOf));
  return {
    undeclared: [...registeredAddresses].filter((address) => !declaredAddresses.has(address)),
    unregistered: [...declaredAddresses].filter((address) => !registeredAddresses.has(address)),
    mismatched: [...declaredAddresses]
      .filter((address) => registeredAddresses.has(address))
      .filter(
        (address) =>
          shapesOf(declared.filter((rule) => addressOf(rule) === address)) !==
          shapesOf(mine.filter((rule) => addressOf(rule) === address)),
      ),
  };
};

/** EOTS-007: the metric every breach increments, tagged with the rule that fired (never a key). */
export const exceededCounter = Metric.counter("awthaq.ratelimit.exceeded", {
  description: "Requests rejected by a rate-limit rule",
  incremental: true,
});

/** EOTS-007: which rule a breach belongs to. Every field is a fixed label, so none of it can carry caller input. */
export interface EnforceMeta {
  readonly group: string;
  readonly endpoint: string;
  readonly rule: string;
  readonly dimension: "identity" | "ip" | "principal" | "custom";
}

export interface EnforceInput {
  readonly key: string;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: RateLimiter.Escalation;
  readonly meta: EnforceMeta;
}

/**
 * EOTS-007: the one place a rate-limit breach is made observable. Consumes
 * from the `RateLimiter` port and, when it refuses, publishes
 * `auth.rateLimit.exceeded`, logs a warning and increments
 * `exceededCounter`, all annotated with `meta` only. The bucket key (an
 * email, an IP) is never published, logged or used as a metric attribute
 * (BEH-EA-108). The port's own `RateLimitExceeded` is re-raised unchanged so
 * each plugin still maps it onto its own wire error.
 */
export const enforce = (input: EnforceInput) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter.RateLimiter;
    const events = yield* AuthEvents.AuthEvents;
    return yield* limiter
      .consume({
        key: input.key,
        limit: input.limit,
        window: input.window,
        escalation: input.escalation,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.all(
            [
              events.publish({
                _tag: "auth.rateLimit.exceeded",
                ...input.meta,
                retryAfterMillis: error.retryAfterMillis,
              }),
              Effect.logWarning("awthaq: rate limit exceeded").pipe(
                Effect.annotateLogs({ ...input.meta, retryAfterMillis: error.retryAfterMillis }),
              ),
              Metric.update(Metric.withAttributes(exceededCounter, { ...input.meta }), 1),
            ],
            { discard: true },
          ),
        ),
      );
  });

// ---- SOS-007: a recipient dimension ---------------------------------------------------------

/**
 * SOS-007: the bucket a per-destination limit counts against for an endpoint that sends to a phone
 * number (an SMS one-time code, a voice call). The number is normalised to E.164 first
 * (`Phone.normalizePhone`), so `+1 (555) 0100`, `1-555-0100` and `+15550100` share one budget instead
 * of an attacker choosing spellings to multiply it; input that is not a phone number falls into one
 * shared `invalid` bucket, never an unthrottled one. `read` names where the number lives in the
 * endpoint's input — it stays out of the strategy, like the other keys, so a token or a code never
 * becomes a bucket key.
 *
 * SMS pumping (toll fraud) is bounded by *simultaneous* caps, each its own rule: this recipient key,
 * plus `"ip"` and, once signed in, `"principal"`. Removing the recipient rule is the red flag.
 */
export const phoneKey =
  (
    read: (input: unknown) => unknown,
    options?: Phone.NormalizeOptions,
  ): ((input: unknown) => string) =>
  (input) => {
    const raw = read(input);
    const normalized =
      typeof raw === "string" ? Phone.normalizePhone(raw, options) : Option.none<Phone.E164>();
    return `phone:${Option.getOrElse(normalized, () => "invalid")}`;
  };

// ---- PV-240: key strategies ------------------------------------------------------------------

/** What `bucketKey` and `enforceRule` read of a rule: its address and its strategy. */
type Keyed = Pick<RuleInput, "group" | "endpoint">;

/** The label a rule reports with a breach (`EnforceMeta.rule`): fixed, never a key. */
const ruleLabel = (rule: Keyed) => `${rule.group}.${rule.endpoint}`;

const dimensionOf = (key: RateLimitKey): EnforceMeta["dimension"] =>
  key === "principal" ? "principal" : key === "ip" ? "ip" : "custom";

/**
 * PV-240/BEH-EA-108: the bucket key a rule's strategy derives for the current request, prefixed
 * with the rule's own `group.endpoint` so two rules with the same strategy never share a counter.
 *
 * - `"principal"`: the caller's `CurrentPrincipal` (`type:id`). An anonymous caller is one shared
 *   principal, so an unauthenticated endpoint should not use this strategy.
 * - `"ip"`: the address the `ClientAddress` port resolves for the ambient request; an unresolvable
 *   address falls into one explicit `unknown` bucket rather than escaping the limit.
 * - a function: applied to `input`, the plugin author's own responsibility (BEH-EA-108).
 */
export function bucketKey(
  rule: Keyed & { readonly key: "principal" },
): Effect.Effect<string, never, Api.CurrentPrincipal>;
export function bucketKey(
  rule: Keyed & { readonly key: "ip" },
): Effect.Effect<string, never, ClientAddress.ClientAddress | HttpServerRequest.HttpServerRequest>;
export function bucketKey(
  rule: Keyed & { readonly key: (input: unknown) => string },
  input?: unknown,
): Effect.Effect<string>;
export function bucketKey(
  rule: Keyed & { readonly key: RateLimitKey },
  input?: unknown,
): Effect.Effect<
  string,
  never,
  Api.CurrentPrincipal | ClientAddress.ClientAddress | HttpServerRequest.HttpServerRequest
>;
export function bucketKey(
  rule: Keyed & { readonly key: RateLimitKey },
  input?: unknown,
): Effect.Effect<
  string,
  never,
  Api.CurrentPrincipal | ClientAddress.ClientAddress | HttpServerRequest.HttpServerRequest
> {
  const namespace = `ratelimit:${ruleLabel(rule)}`;
  const strategy = rule.key;
  if (typeof strategy === "function") return Effect.succeed(`${namespace}:${strategy(input)}`);
  if (strategy === "principal") {
    return Api.CurrentPrincipal.use((principal) =>
      Effect.succeed(`${namespace}:principal:${principal.ref.type}:${principal.ref.id}`),
    );
  }
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const clientAddress = yield* ClientAddress.ClientAddress;
    const address = yield* clientAddress.resolve(request);
    return `${namespace}:ip:${Option.getOrElse(address, () => "unknown")}`;
  });
}

/**
 * PV-240: enforces a declared rule end to end: derives its bucket key (`bucketKey`) and consumes
 * it through `enforce`, so the rule a plugin registers (`RateLimits.rule`) and the one it enforces
 * are the same object, and a breach is reported under the rule's own `group.endpoint`, its
 * strategy's dimension, and never its key.
 */
export function enforceRule(
  rule: RuleInput & { readonly key: "principal" },
): Effect.Effect<
  void,
  RateLimiter.RateLimitExceeded,
  Api.CurrentPrincipal | RateLimiter.RateLimiter | AuthEvents.AuthEvents
>;
export function enforceRule(
  rule: RuleInput & { readonly key: "ip" },
): Effect.Effect<
  void,
  RateLimiter.RateLimitExceeded,
  | ClientAddress.ClientAddress
  | HttpServerRequest.HttpServerRequest
  | RateLimiter.RateLimiter
  | AuthEvents.AuthEvents
>;
export function enforceRule(
  rule: RuleInput & { readonly key: (input: unknown) => string },
  input?: unknown,
): Effect.Effect<
  void,
  RateLimiter.RateLimitExceeded,
  RateLimiter.RateLimiter | AuthEvents.AuthEvents
>;
export function enforceRule(
  rule: RuleInput,
  input?: unknown,
): Effect.Effect<
  void,
  RateLimiter.RateLimitExceeded,
  | Api.CurrentPrincipal
  | ClientAddress.ClientAddress
  | HttpServerRequest.HttpServerRequest
  | RateLimiter.RateLimiter
  | AuthEvents.AuthEvents
>;
export function enforceRule(
  rule: RuleInput,
  input?: unknown,
): Effect.Effect<
  void,
  RateLimiter.RateLimitExceeded,
  | Api.CurrentPrincipal
  | ClientAddress.ClientAddress
  | HttpServerRequest.HttpServerRequest
  | RateLimiter.RateLimiter
  | AuthEvents.AuthEvents
> {
  return Effect.flatMap(bucketKey(rule, input), (key) =>
    enforce({
      key,
      limit: rule.limit,
      window: rule.window,
      ...(rule.escalation === undefined ? {} : { escalation: rule.escalation }),
      meta: {
        group: rule.group,
        endpoint: rule.endpoint,
        rule: ruleLabel(rule),
        dimension: dimensionOf(rule.key),
      },
    }),
  );
}
