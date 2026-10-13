// @awthaq/core — RateLimits
//
// spec/behaviors/14-rate-limiting.md, BEH-EA-105 through BEH-EA-111 — the domain-stratum half of
// rate limiting: a plugin declares its rules once as a typed table (`AuthPlugin.Service`'s
// `rateLimitRules`, built with `RateLimits.rule`/`failureRule` over `RateLimits.Key.*`), opens one
// budget in its `make` (`yield* RateLimits.budget(Self, { tune })`) and spends by name
// (`limits.spend(["signInByIp", "signIn"], input)`). Registration, bucket-key derivation, the
// observation of a breach (event, log, metric), the `Api.RateLimited` mapping, the per-call tuning
// (the tenant's config in force) and the application overrides all live behind that interface, once.
// The port itself (`RateLimiter`, `RateLimitExceeded`, the stores) lives in `@awthaq/ports`'s
// `RateLimiter.ts` — see that module's own header comment for why the two halves are split.
//
// The vocabulary (`Rule`, `Table`, `Owner`, `Budget`, the registry's shape and errors) is in
// `RateLimitModel.ts`, the key strategies and the one email normaliser in `RateLimitKey.ts`; both are
// leaves, re-exported here so the public namespace stays `RateLimits.*`.
//
// Declared means registered, by construction: the static `rateLimits` declaration is derived from the
// same table the budget registers; `budget` can only spend that table's own names (a type error
// otherwise); and `AuthPlugin.layer` refuses a plugin that declares rules but never opens its budget.
//
// The registry is a real, scoped service (`RateLimitsRegistry`), not module-level mutable state:
// BEH-EA-111 aggregates rules from every installed plugin into one list *per application
// composition* — a bare module-level array would share one registry across every `Auth.make` call in
// the same process (two unrelated test suites, or two tenants, polluting each other's rule list, and
// one test's `registered()` read permanently freezing every later test's registrations, since
// BEH-EA-024 requires freezing at first read). Providing a fresh `RateLimits.layer` per composition
// gives each composition (and each test) its own registry.
//
// BEH-EA-111's "dependency order, then declared `order`, then plugin id" resolved-order rule is the
// one `HookPoint.compareTaps` implements for hook taps (JH-003), and `registered` sorts with that very
// comparator. Two rules of one plugin with the same `order` keep their registration sequence.
//
// The inference cycle (`static readonly layer = AuthPlugin.layer(Self, { make: ... })` where `make`
// passes `Self` to a function typed `AuthPlugin.Any`, which requires `layer`) is solved by taking a
// narrow `Owner` with no `layer` member, the same move `AuthPlugin.layer` makes with `Class<Self, ...>`.

import { Api } from "@awthaq/api";
import { Defects, RateLimiter } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuthEvents from "./AuthEvents.ts";
import type * as AuthPlugin from "./AuthPlugin.ts";
import * as HookPoint from "./HookPoint.ts";
import * as Key from "./RateLimitKey.ts";
import * as RateLimitModel from "./RateLimitModel.ts";
import {
  RateLimitBucketConflict,
  RateLimitBudgetAlreadyOpen,
  RateLimitBudgetNotOpened,
  RateLimitScopeViolation,
  RateLimitsFrozen,
  RateLimitsRegistry,
  UnknownRateLimitRule,
} from "./RateLimitModel.ts";
import * as Tenant from "./Tenant.ts";

export * from "./RateLimitModel.ts";
export * as Key from "./RateLimitKey.ts";

type Table = RateLimitModel.Table;
type AnyRule = RateLimitModel.Rule;
type Sizing = RateLimitModel.Sizing;
type Owner<Limits = Table> = RateLimitModel.Owner<Limits>;

// ---- the registry ------------------------------------------------------------------------------

const millisOf = (window: Duration.Input) => Duration.toMillis(Duration.fromInputUnsafe(window));

interface BucketClaim {
  readonly owner: string;
  readonly mode: RateLimitModel.Mode;
  readonly limit: number;
  readonly windowMillis: number;
}

interface Entry {
  readonly rule: RateLimitModel.RegisteredRule;
  readonly owner: Owner;
}

export const layer: Layer.Layer<RateLimitModel.RateLimitsRegistry> = Layer.effect(
  RateLimitsRegistry,
  Effect.gen(function* () {
    // The owner rides beside each rule (not on `RegisteredRule`, which is what callers see):
    // ordering needs its `dependsOn`, introspection only its id.
    const entries = yield* Ref.make<ReadonlyArray<Entry>>([]);
    const frozen = yield* Ref.make<ReadonlyArray<RateLimitModel.RegisteredRule> | undefined>(
      undefined,
    );
    const handles = yield* Ref.make<ReadonlyMap<string, RateLimitModel.ErasedBudget>>(new Map());
    const buckets = yield* Ref.make<ReadonlyMap<string, BucketClaim>>(new Map());

    const assertOpen = Effect.flatMap(Ref.get(frozen), (already) =>
      already === undefined
        ? Effect.void
        : Effect.die(
            new RateLimitsFrozen({
              message:
                "awthaq: rate-limit rules are frozen once read (e.g. by introspection) — every rule must be registered before that point",
            }),
          ),
    );

    const scopeViolation = (owner: Owner, group: string) =>
      new RateLimitScopeViolation({
        plugin: owner.id,
        group,
        message: `awthaq: plugin "${owner.id}" cannot rate-limit group "${group}", which is not one of its own contract groups`,
      });

    const register: RateLimitModel.RateLimitsRegistryShape["register"] = (owner, input) =>
      Effect.gen(function* () {
        if (!Object.hasOwn(owner.contract.groups, input.group)) {
          return yield* Effect.fail(scopeViolation(owner, input.group));
        }
        yield* assertOpen;
        yield* Ref.update(entries, (current) => [
          ...current,
          { rule: { ...input, plugin: owner.id, sequence: current.length }, owner },
        ]);
      });

    const open: RateLimitModel.RateLimitsRegistryShape["open"] = (owner, registrations, handle) =>
      Effect.gen(function* () {
        yield* assertOpen;
        if ((yield* Ref.get(handles)).has(owner.id)) {
          return yield* Effect.die(
            new RateLimitBudgetAlreadyOpen({
              plugin: owner.id,
              message: `awthaq: RateLimits.budget(${owner.id}) was opened twice in one registry`,
            }),
          );
        }
        const groups = Object.keys(owner.contract.groups);
        const claimed = new Map(yield* Ref.get(buckets));
        for (const registration of registrations) {
          const { rule, bucket, sizing } = registration;
          if (!Object.hasOwn(owner.contract.groups, rule.group)) {
            return yield* Effect.die(scopeViolation(owner, rule.group));
          }
          if (
            rule.bucket !== undefined &&
            !groups.some((group) => rule.bucket?.startsWith(`${group}.`))
          ) {
            return yield* Effect.die(
              new RateLimitBucketConflict({
                plugin: owner.id,
                bucket,
                message: `awthaq: plugin "${owner.id}" names bucket "${bucket}" for rule "${registration.name}", which does not start with one of its own groups`,
              }),
            );
          }
          const claim: BucketClaim = {
            owner: owner.id,
            mode: rule.mode,
            limit: sizing.limit,
            windowMillis: millisOf(sizing.window),
          };
          const existing = claimed.get(bucket);
          if (
            existing !== undefined &&
            (existing.owner !== claim.owner ||
              existing.mode !== claim.mode ||
              existing.limit !== claim.limit ||
              existing.windowMillis !== claim.windowMillis)
          ) {
            return yield* Effect.die(
              new RateLimitBucketConflict({
                plugin: owner.id,
                bucket,
                message: `awthaq: rules sharing bucket "${bucket}" must have one owner, one mode and one tuned limit and window (rule "${registration.name}" of "${owner.id}" differs)`,
              }),
            );
          }
          claimed.set(bucket, claim);
        }
        yield* Ref.set(buckets, claimed);
        yield* Ref.update(handles, (current) => new Map(current).set(owner.id, handle));
        yield* Ref.update(entries, (current) => [
          ...current,
          ...registrations.map((registration, index) => ({
            rule: {
              plugin: owner.id,
              sequence: current.length + index,
              name: registration.name,
              group: registration.rule.group,
              endpoint: registration.rule.endpoint,
              dimension: registration.rule.dimension,
              strategy: registration.rule.strategy,
              mode: registration.rule.mode,
              bucket: registration.bucket,
              key: registration.keyOf,
              limit: registration.sizing.limit,
              window: registration.sizing.window,
              order: registration.rule.order,
              ...(registration.sizing.escalation === undefined
                ? {}
                : { escalation: registration.sizing.escalation }),
            },
            owner,
          })),
        ]);
      });

    const handleOf: RateLimitModel.RateLimitsRegistryShape["handleOf"] = (ownerId) =>
      Effect.map(Ref.get(handles), (current) => Option.fromNullishOr(current.get(ownerId)));

    const registered: RateLimitModel.RateLimitsRegistryShape["registered"] = Effect.gen(
      function* () {
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
      },
    );

    return RateLimitsRegistry.of({ register, open, handleOf, registered });
  }),
);

/**
 * PV-241/BEH-EA-111: registers every rule `owner` declared statically (`AuthPlugin.Service`'s legacy
 * `rateLimits`), so a plugin whose rules are all declared keeps one list, not two. Removed with the
 * legacy path (plan 06 phase 11).
 */
export const registerDeclared = (
  owner: AuthPlugin.Any,
  options?: {
    readonly key?: (
      rule: RateLimitModel.RateLimitDeclaration,
    ) => RateLimitModel.RateLimitKey | undefined;
    readonly tune?: (
      rule: RateLimitModel.RateLimitDeclaration,
    ) => Partial<Pick<RateLimitModel.RuleInput, "limit" | "window">> | undefined;
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
    .map((rule) => `${rule.limit}/${millisOf(rule.window)}`)
    .toSorted()
    .join(",");

/** PV-241/BEH-EA-111: the legacy consistency check (removed with the legacy path, plan 06 phase 11). */
export const declarationDrift = (
  owner: AuthPlugin.Any,
  registered: ReadonlyArray<RateLimitModel.RegisteredRule>,
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

// ---- observation -------------------------------------------------------------------------------

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

/** EOTS-007's one observation site: publishes `auth.rateLimit.exceeded`, logs a warning and counts, annotated with `meta` only. */
const observe = (events: AuthEvents.AuthEventsShape, meta: EnforceMeta, retryAfterMillis: number) =>
  Effect.all(
    [
      events.publish({ _tag: "auth.rateLimit.exceeded", ...meta, retryAfterMillis }),
      Effect.logWarning("awthaq: rate limit exceeded").pipe(
        Effect.annotateLogs({ ...meta, retryAfterMillis }),
      ),
      Metric.update(Metric.withAttributes(exceededCounter, { ...meta }), 1),
    ],
    { discard: true },
  );

export interface EnforceInput {
  readonly key: string;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: RateLimiter.Escalation;
  readonly meta: EnforceMeta;
}

/**
 * Legacy single-key enforcement, still used by plugins that have not moved to a budget (removed with
 * the legacy path, plan 06 phase 11). The bucket key (an email, an IP) is never published, logged or
 * used as a metric attribute (BEH-EA-108); the port's own `RateLimitExceeded` is re-raised unchanged.
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
      .pipe(Effect.tapError((error) => observe(events, input.meta, error.retryAfterMillis)));
  });

// ---- application overrides ---------------------------------------------------------------------

/** The app/tenant override path: tuning by plugin id, then rule name. */
export interface OverridesShape {
  readonly [plugin: string]: { readonly [rule: string]: Partial<Sizing> | undefined } | undefined;
}

/** A `Context.Reference`, so a tenant middleware may provide its own per fiber (it then wins over the built layer). */
export const RateLimitOverrides = Context.Reference<OverridesShape>(
  "awthaq/core/RateLimitOverrides",
  { defaultValue: () => ({}) },
);

export interface OverrideEntry {
  readonly plugin: string;
  readonly tuning: { readonly [rule: string]: Partial<Sizing> | undefined };
}

/** Typed per plugin: `tune(Password, { signIn: { limit: 3 } })`; an unknown rule name is a compile error. */
export const tune = <Limits>(owner: Owner<Limits>, tuning: RateLimitModel.Tuning<Limits>) => {
  const entry: OverrideEntry = { plugin: owner.id, tuning };
  return entry;
};

/** One Layer for all of an application's overrides (two `Layer.succeed`s of one Reference would shadow, not merge). */
export const overrides = (...entries: ReadonlyArray<OverrideEntry>) =>
  Layer.succeed(
    RateLimitOverrides,
    entries.reduce<OverridesShape>(
      (acc, entry) => ({ ...acc, [entry.plugin]: { ...acc[entry.plugin], ...entry.tuning } }),
      {},
    ),
  );

// ---- the budget --------------------------------------------------------------------------------

/** Layers `...tunings` over `base`, lowest precedence first; an absent field leaves the lower layer's. */
const layered = (base: Sizing, tunings: ReadonlyArray<Partial<Sizing> | undefined>) =>
  tunings.reduce<Sizing>(
    (acc, tuning) =>
      tuning === undefined
        ? acc
        : {
            limit: tuning.limit ?? acc.limit,
            window: tuning.window ?? acc.window,
            escalation: tuning.escalation ?? acc.escalation,
          },
    base,
  );

const validSizing = (plugin: string, name: string, sizing: Sizing) =>
  Number.isInteger(sizing.limit) && sizing.limit > 0 && millisOf(sizing.window) > 0
    ? Effect.succeed(sizing)
    : Defects.invalidConfiguration(
        "rateLimits",
        `awthaq: rate-limit rule "${name}" of plugin "${plugin}" needs a positive integer limit and a window greater than 0 ms`,
      );

const noTuning: RateLimitModel.ErasedTuning = {};

/**
 * Opens `owner`'s budget: registers its whole table (BEH-EA-107/111) and returns the typed handle.
 * `options.tune` is the plugin's own knob, evaluated here (for the registry) and on every call, so a
 * tenant's config in force applies (EP-007). Precedence on every call, lowest first: the declared
 * default, `tune`, the application's `RateLimits.overrides` layer, a fiber-provided
 * `RateLimitOverrides`. The registry records the first three as they stood at open.
 *
 * Takes `Owner`, which has no `layer` member: a plugin passes its own class from inside its own
 * `layer` initializer without an inference cycle.
 */
export const budget = <Limits extends Table>(
  owner: Owner<Limits>,
  options: RateLimitModel.BudgetOptions<Limits> = {},
) =>
  Effect.gen(function* () {
    const registry = yield* RateLimitsRegistry;
    const limiter = yield* RateLimiter.RateLimiter;
    const events = yield* AuthEvents.AuthEvents;
    const table: Table = owner.rateLimitRules ?? {};
    const context = { email: options.emailKey ?? Key.emailKey };
    const tuneNow: Effect.Effect<RateLimitModel.ErasedTuning> =
      options.tune ?? Effect.succeed(noTuning);
    const builtOverrides = yield* RateLimitOverrides;
    const overridesNow = Tenant.configInForce(RateLimitOverrides, builtOverrides);

    const resolve = (
      name: string,
      tuning: RateLimitModel.ErasedTuning,
      applied: OverridesShape,
    ) => {
      const rule = table[name];
      // Unreachable through the typed handle; reachable only from a hand-built owner.
      if (rule === undefined) {
        return Effect.die(
          new UnknownRateLimitRule({
            plugin: owner.id,
            name,
            message: `awthaq: plugin "${owner.id}" has no rate-limit rule "${name}"`,
          }),
        );
      }
      return Effect.map(
        validSizing(
          owner.id,
          name,
          layered(rule.sizing, [tuning[name], applied[owner.id]?.[name]]),
        ),
        (sizing) => ({ rule, sizing, bucket: rule.bucket ?? `${rule.group}.${name}` }),
      );
    };
    const now = (name: string) =>
      Effect.flatMap(Effect.all([tuneNow, overridesNow]), ([tuning, applied]) =>
        resolve(name, tuning, applied),
      );
    const metaOf = (
      name: string,
      rule: AnyRule,
      spendOptions: RateLimitModel.SpendOptions | undefined,
    ) => {
      const meta: EnforceMeta = {
        group: rule.group,
        endpoint: spendOptions?.endpoint ?? rule.endpoint,
        rule: name,
        dimension: rule.dimension,
      };
      return meta;
    };
    const refused = (
      attempt: Effect.Effect<void, RateLimiter.RateLimitExceeded>,
      name: string,
      rule: AnyRule,
      spendOptions: RateLimitModel.SpendOptions | undefined,
    ) =>
      attempt.pipe(
        Effect.catchTag("RateLimitExceeded", (error) =>
          observe(events, metaOf(name, rule, spendOptions), error.retryAfterMillis).pipe(
            Effect.andThen(
              Effect.fail(new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis })),
            ),
          ),
        ),
      );

    const spendOne = (name: string, input: unknown, spendOptions?: RateLimitModel.SpendOptions) =>
      Effect.flatMap(now(name), ({ rule, sizing, bucket }) =>
        refused(
          limiter.consume({ key: rule.keyOf(bucket, input, context), ...sizing }),
          name,
          rule,
          spendOptions,
        ),
      );
    const erased: RateLimitModel.ErasedBudget = {
      spend: (names, input, spendOptions) =>
        Effect.forEach(
          typeof names === "string" ? [names] : names,
          (name) => spendOne(name, input, spendOptions),
          { discard: true },
        ),
      guard: (name, input, spendOptions) =>
        Effect.flatMap(now(name), ({ rule, sizing, bucket }) =>
          refused(
            limiter.check({ key: rule.keyOf(bucket, input, context), ...sizing }),
            name,
            rule,
            spendOptions,
          ),
        ),
      charge: (name, input) =>
        Effect.flatMap(now(name), ({ rule, sizing, bucket }) =>
          limiter
            .consume({ key: rule.keyOf(bucket, input, context), ...sizing })
            .pipe(Effect.ignore),
        ),
    };

    // The registry records what is in force at build: declared + tune + the built overrides.
    const tuningAtOpen = yield* tuneNow;
    const registrations = yield* Effect.forEach(Object.keys(table), (name) =>
      Effect.map(resolve(name, tuningAtOpen, builtOverrides), ({ rule, sizing, bucket }) => ({
        name,
        rule,
        sizing,
        bucket,
        keyOf: (input: unknown) => rule.keyOf(bucket, input, context),
      })),
    );
    yield* registry.open(owner, registrations, erased);
    const typed: RateLimitModel.Budget<Limits> = erased;
    return typed;
  });

/** The handle a plugin's layer already opened: for its handlers and contributions (ApiKey). Dies if not opened. */
export const budgetOf = <Limits extends Table>(owner: Owner<Limits>) =>
  Effect.gen(function* () {
    const registry = yield* RateLimitsRegistry;
    const handle = yield* registry.handleOf(owner.id);
    if (Option.isNone(handle)) {
      return yield* Effect.die(
        new RateLimitBudgetNotOpened({
          plugin: owner.id,
          rules: Object.keys(owner.rateLimitRules ?? {}),
          message: `awthaq: RateLimits.budgetOf(${owner.id}) ran before the plugin's layer opened RateLimits.budget(${owner.id})`,
        }),
      );
    }
    const typed: RateLimitModel.Budget<Limits> = handle.value;
    return typed;
  });

/** A rule's bucket key outside a budget (SecondFactor's failure budget). Needs an explicit `bucket`. */
export const bucketKey = <I>(
  rule: RateLimitModel.Rule<string, I, RateLimitModel.Mode> & { readonly bucket: string },
  input: NoInfer<I>,
  context: Key.KeyContext = { email: Key.emailKey },
) => rule.keyOf(rule.bucket, input, context);

/** A hand-built owner (core's own account group, tests, BDD): groups confined to `contract`'s at compile time. */
export const owner = <
  Groups extends HttpApiGroup.Constraint,
  const Limits extends RateLimitModel.Table<AuthPlugin.GroupIdOf<Groups>>,
>(spec: {
  readonly id: string;
  readonly contract: HttpApi.HttpApi<"auth", Groups>;
  readonly dependsOn?: ReadonlyArray<HookPoint.TapOwner>;
  readonly rateLimits: Limits;
}) => {
  const made: Owner<Limits> = {
    id: spec.id,
    contract: spec.contract,
    dependsOn: spec.dependsOn ?? [],
    rateLimitRules: spec.rateLimits,
  };
  return made;
};
