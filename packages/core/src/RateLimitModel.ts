// @awthaq/core — RateLimitModel
//
// spec/behaviors/14-rate-limiting.md, BEH-EA-105 through BEH-EA-111 — the vocabulary of the
// rate-limit budget: a typed `Rule`, the `Table` a plugin declares once, the `Owner` a budget is
// opened for, the typed `Budget` handle (`spend`/`guard`/`charge`), and the registry's shape.
//
// A leaf module on purpose. `AuthPlugin.ts` must read `Table`/`declare`/the registry tag, and
// `RateLimits.ts` (the implementation) already imports `AuthPlugin` as a type; `scripts/circular.mjs`
// fails type-only cycles too, so the shared vocabulary lives here and imports neither of them.
// `RateLimits.ts` re-exports everything below, so the public namespace stays `RateLimits.*`.

import type { Api } from "@awthaq/api";
import type { RateLimiter } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as HookPoint from "./HookPoint.ts";
import type * as Key from "./RateLimitKey.ts";

/** `"attempts"`: every call is consumed (`spend`). `"failures"`: refused before evaluating, charged only on failure (BCR-006). */
export type Mode = "attempts" | "failures";

/** The numbers an application may tune. */
export interface Sizing {
  readonly limit: number;
  readonly window: Duration.Input;
  /** RBS-009: opt-in exponential penalty for repeat breaches. Off by default. */
  readonly escalation?: RateLimiter.Escalation | undefined;
}

export interface Rule<Group extends string = string, I = unknown, M extends Mode = Mode> {
  readonly group: Group;
  /** One of `group`'s endpoints, or `"*"` for a group-wide rule (the event then reports the endpoint `spend` names). */
  readonly endpoint: string;
  readonly strategy: Key.Key<I>["strategy"];
  readonly dimension: Key.Dimension;
  readonly mode: M;
  /** The declared default. */
  readonly sizing: Sizing;
  /** A bucket shared by several rules (or used outside a budget): must start with one of the owner's groups + ".". */
  readonly bucket: string | undefined;
  readonly order: number;
  /** Erased derivation: `ratelimit:<bucket>:<part>`, or `ratelimit:<bucket>:invalid` for input of the wrong shape. */
  readonly keyOf: (bucket: string, input: unknown, context: Key.KeyContext) => string;
  /** Phantom: the input type `spend` demands. Never assigned (the `"~userFields"` precedent in `AuthPlugin.Class`). */
  readonly "~input"?: I;
}

/** A plugin's rule table; the key of each entry IS the rule's name (`rule` in the event and the metric). */
export type Table<Group extends string = string> = {
  readonly [name: string]: Rule<Group, unknown, Mode>;
};

export interface RuleSpec<Group extends string, I> {
  readonly group: Group;
  readonly endpoint: string;
  readonly key: Key.Key<I>;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: RateLimiter.Escalation;
  readonly bucket?: string;
  readonly order?: number;
}

const build = <Group extends string, I, M extends Mode>(spec: RuleSpec<Group, I>, mode: M) => {
  const made: Rule<Group, I, M> = {
    group: spec.group,
    endpoint: spec.endpoint,
    strategy: spec.key.strategy,
    dimension: spec.key.dimension,
    mode,
    sizing: { limit: spec.limit, window: spec.window, escalation: spec.escalation },
    bucket: spec.bucket,
    order: spec.order ?? 0,
    keyOf: (bucket, input, context) =>
      `ratelimit:${bucket}:${spec.key.accepts(input) ? spec.key.part(input, context) : "invalid"}`,
  };
  return made;
};

/**
 * A request throttle: every call spends one unit. Two constructors rather than a `mode?` option:
 * with a defaulted `mode` the expression `spec.mode ?? "attempts"` has type `M | "attempts"`, which
 * is not `M`, and a cast would be needed.
 *
 * Overloaded on `bucket`: an explicit bucket rides in the rule's type (`bucket: "two_factor.failures"`),
 * so `RateLimits.bucketKey`, which has no table name to derive a default from, accepts only a rule
 * that names one.
 */
export function rule<const Group extends string, I>(
  spec: RuleSpec<Group, I> & { readonly bucket?: undefined },
): Rule<Group, I, "attempts"> & { readonly bucket: undefined };
export function rule<const Group extends string, I, const Bucket extends string>(
  spec: RuleSpec<Group, I> & { readonly bucket: Bucket },
): Rule<Group, I, "attempts"> & { readonly bucket: Bucket };
export function rule<const Group extends string, I>(spec: RuleSpec<Group, I>) {
  return build(spec, "attempts");
}

/** A failure budget (BCR-006): `guard` before evaluating, `charge` on a failure. */
export function failureRule<const Group extends string, I>(
  spec: RuleSpec<Group, I> & { readonly bucket?: undefined },
): Rule<Group, I, "failures"> & { readonly bucket: undefined };
export function failureRule<const Group extends string, I, const Bucket extends string>(
  spec: RuleSpec<Group, I> & { readonly bucket: Bucket },
): Rule<Group, I, "failures"> & { readonly bucket: Bucket };
export function failureRule<const Group extends string, I>(spec: RuleSpec<Group, I>) {
  return build(spec, "failures");
}

// ---- the static declaration, derived from the table ---------------------------------------------

/** PV-241: what a rate-limit rule is keyed on, as a label a listing can print. */
export type RateLimitDimension = Key.Dimension;

/**
 * PV-241/BEH-EA-111: one rate-limit rule declared statically on a plugin, so `awthaq plugin list
 * --rules` can print it without building a layer. It is DERIVED from the plugin's `rateLimitRules`
 * table (`declare`), the same table `RateLimits.budget` registers, so the two cannot differ except by
 * tuning. The numbers are the plugin's defaults.
 */
export interface RateLimitDeclaration<Group extends string = string> {
  readonly group: Group;
  readonly endpoint: string;
  /** The rule's own name: its key in the table, as the event's `rule` reports it. */
  readonly name: string;
  readonly dimension: Key.Dimension;
  /** The key strategy (`"ip"`, `"email"`, ...), printed by `plugin list --rules`. */
  readonly key: Key.Key<unknown>["strategy"];
  readonly mode: Mode;
  readonly limit: number;
  readonly window: Duration.Input;
}

export const declare = (table: Table) =>
  Object.entries(table).map(([name, entry]) => {
    const declaration: RateLimitDeclaration = {
      group: entry.group,
      endpoint: entry.endpoint,
      name,
      dimension: entry.dimension,
      key: entry.strategy,
      mode: entry.mode,
      limit: entry.sizing.limit,
      window: entry.sizing.window,
    };
    return declaration;
  });

// ---- the owner and the typed handle -------------------------------------------------------------

/**
 * What `budget` needs of its owner. No `layer` member: this is what breaks the inference cycle
 * (a plugin's `static readonly layer = AuthPlugin.layer(Self, { make: ... budget(Self) ... })` would
 * otherwise need `Self.layer`'s type while inferring it). The same move `AuthPlugin.layer` makes with
 * `Class<Self, ...>`.
 */
export interface Owner<Limits = Table> extends HookPoint.TapOwner {
  readonly contract: { readonly groups: { readonly [group: string]: unknown } };
  readonly rateLimitRules?: Table | undefined;
  readonly "~rateLimits"?: Limits;
}

export type InputOf<R> = R extends { readonly "~input"?: infer I } ? I : never;

export type NamesOf<Limits, M extends Mode> = {
  [N in keyof Limits]: Limits[N] extends Rule<string, unknown, M> ? N : never;
}[keyof Limits] &
  string;

type Picked<N> = N extends ReadonlyArray<infer X> ? X : N;

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

/** `spend(["signInByIp", "signIn"], input)`: the input must satisfy every named rule's key. */
export type InputsOf<Limits, N> = UnionToIntersection<
  Picked<N> extends infer K ? (K extends keyof Limits ? InputOf<Limits[K]> : never) : never
>;

export type Tuning<Limits> = { readonly [N in keyof Limits]?: Partial<Sizing> };

/** The plugin-knob tuning as the implementation reads it: by rule name, any name. */
export interface ErasedTuning {
  readonly [rule: string]: Partial<Sizing> | undefined;
}

export interface SpendOptions {
  /** For a group-wide (`"*"`) rule: the endpoint the event and metric report. */
  readonly endpoint?: string;
}

/** The typed handle. Every refusal is published, logged and counted (EOTS-007) and answers `Api.RateLimited` (429). */
export interface Budget<Limits> {
  /** Consumes each named attempts-rule, in order, stopping at the first refusal. */
  readonly spend: <
    const N extends NamesOf<Limits, "attempts"> | ReadonlyArray<NamesOf<Limits, "attempts">>,
  >(
    names: N,
    input: InputsOf<Limits, N>,
    options?: SpendOptions,
  ) => Effect.Effect<void, Api.RateLimited>;
  /** The read half of a failure budget: refuses once spent, never counts (`RateLimiter.check`). */
  readonly guard: <N extends NamesOf<Limits, "failures">>(
    name: N,
    input: InputOf<Limits[N]>,
    options?: SpendOptions,
  ) => Effect.Effect<void, Api.RateLimited>;
  /** Charges one failure; a race past the limit is ignored (the next `guard` refuses). */
  readonly charge: <N extends NamesOf<Limits, "failures">>(
    name: N,
    input: InputOf<Limits[N]>,
  ) => Effect.Effect<void>;
}

/** The runtime shape. Assignable to `Budget<Limits>` because its parameters are wider. */
export interface ErasedBudget {
  readonly spend: (
    names: string | ReadonlyArray<string>,
    input: unknown,
    options?: SpendOptions,
  ) => Effect.Effect<void, Api.RateLimited>;
  readonly guard: (
    name: string,
    input: unknown,
    options?: SpendOptions,
  ) => Effect.Effect<void, Api.RateLimited>;
  readonly charge: (name: string, input: unknown) => Effect.Effect<void>;
}

export interface BudgetOptions<Limits> {
  /**
   * The plugin's own knobs, evaluated at open (for the registry) AND on every call, so a tenant's config
   * in force applies (EP-007): `Effect.map(configNow, (config) => config.rateLimits)`.
   */
  readonly tune?: Effect.Effect<Tuning<Limits>>;
  /** Default `RateLimits.Key.emailKey`. */
  readonly emailKey?: (address: string) => string;
}

// ---- the registry ---------------------------------------------------------------------------------

/** One rule as the registry reports it (BEH-EA-111): the tuned numbers in force at build, never a key function. */
export interface RegisteredRule {
  readonly plugin: string;
  /** The table key. */
  readonly name: string;
  readonly group: string;
  readonly endpoint: string;
  readonly dimension: Key.Dimension;
  /** The key strategy (`"ip"`, `"email"`, ...). */
  readonly key: Key.Key<unknown>["strategy"];
  readonly mode: Mode;
  /** The bucket the rule's counter lives in. */
  readonly bucket: string;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: RateLimiter.Escalation | undefined;
  readonly order: number;
  readonly sequence: number;
}

/** One rule of a table, resolved: the tuned sizing in force at open and the bucket it counts in. */
export interface Registration {
  readonly name: string;
  readonly rule: Rule;
  readonly bucket: string;
  readonly sizing: Sizing;
}

export interface RateLimitsRegistryShape {
  /** Registers `owner`'s whole table and remembers its handle. Dies on: scope violation, frozen, double open, bucket conflict. */
  readonly open: (
    owner: Owner,
    registrations: ReadonlyArray<Registration>,
    handle: ErasedBudget,
  ) => Effect.Effect<void>;
  readonly handleOf: (ownerId: string) => Effect.Effect<Option.Option<ErasedBudget>>;
  /** BEH-EA-111: every rule registered so far, ordered by dependency order, then declared `order`, then plugin id (`HookPoint.compareTaps`, the hook registry's own comparator), then registration sequence — frozen the first time it is read. */
  readonly registered: Effect.Effect<ReadonlyArray<RegisteredRule>>;
}

export class RateLimitsRegistry extends Context.Service<
  RateLimitsRegistry,
  RateLimitsRegistryShape
>()("awthaq/core/RateLimitsRegistry") {}

/** BEH-EA-107: a budget refuses a `group` outside the calling plugin's own contract. */
export class RateLimitScopeViolation extends Data.TaggedError("RateLimitScopeViolation")<{
  readonly plugin: string;
  readonly group: string;
  readonly message: string;
}> {}

/** Reachable only if a budget opens after `registered()` has already read (and so frozen) the list once — a composition-order bug, not a normal-flow error (BEH-EA-024's "frozen at first read"). */
export class RateLimitsFrozen extends Data.TaggedError("RateLimitsFrozen")<{
  readonly message: string;
}> {}

/** `budget(owner)` ran twice in one registry. */
export class RateLimitBudgetAlreadyOpen extends Data.TaggedError("RateLimitBudgetAlreadyOpen")<{
  readonly plugin: string;
  readonly message: string;
}> {}

/** A plugin declared rules but its layer never opened `RateLimits.budget(Self)` (or `budgetOf` ran first). */
export class RateLimitBudgetNotOpened extends Data.TaggedError("RateLimitBudgetNotOpened")<{
  readonly plugin: string;
  readonly rules: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** Rules sharing a bucket must agree on mode and tuned sizing, and a bucket belongs to one owner's groups. */
export class RateLimitBucketConflict extends Data.TaggedError("RateLimitBucketConflict")<{
  readonly plugin: string;
  readonly bucket: string;
  readonly message: string;
}> {}

/** `spend`/`guard`/`charge` named a rule the owner's table does not have (unreachable through the typed handle). */
export class UnknownRateLimitRule extends Data.TaggedError("UnknownRateLimitRule")<{
  readonly plugin: string;
  readonly name: string;
  readonly message: string;
}> {}
