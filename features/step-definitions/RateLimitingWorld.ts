// AH-003 tier 3 (decision 36): 14-rate-limiting.feature's World. Two seams, chosen per claim:
//
// - the *port* (`RateLimiter`, `RateLimiter.layer` over a store) built directly in the
//   scenario's scope, with `TestClock` driving windows — for what BEH-EA-105/106/109 say about
//   `consume` itself;
// - the *plugin* seam: `@awthaq/password`'s real rules enforced through the real HTTP handler
//   over `TestAuth`'s bundle with a real limiter replacing the permissive one (BEH-EA-108/110/
//   112) — the wire is where a client sees a 429 and its `retryAfterMillis`.
//
// The port's own failure is `RateLimitExceeded`; the wire's is `Api.RateLimited` (RBS-010,
// spec/behaviors/14-rate-limiting.md: "where this document says `consume` fails with
// `RateLimited`, the port-level failure is `RateLimitExceeded` and the caller-visible one is
// `RateLimited`"). `failureNamed` maps the Gherkin's word onto the level each step is at.
import { Auth, AuthPlugin, RateLimits } from "@awthaq/core";
import { RateLimiter } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { type Host, jsonPost, makeHost } from "./CrossCuttingApp.ts";
import { AcmeAudit, AcmeGate, AcmeNormalize, PRE } from "./HooksWorld.ts";

// ---- an "invite" plugin whose rate-limit rule names a configurable group (BEH-EA-107) ----

/** Which group the Invite plugin's rule names; a Given sets it, the plugin's `make` reads it. */
export const InviteRuleGroup = Context.Reference<string>("features/InviteRuleGroup", {
  defaultValue: () => "invite",
});

const InviteApi = HttpApi.make("auth").add(
  HttpApiGroup.make("invite").add(
    HttpApiEndpoint.post("create", "/invite/create", { success: Schema.String }),
  ),
);

/**
 * The Invite plugin as the registry sees its owner (id and contract groups). Spelled from the
 * contract rather than `InvitePlugin` itself: the plugin's own layer initializer cannot name the
 * class it belongs to without the type checker looping.
 */
const inviteOwner: AuthPlugin.Any = {
  id: "invite",
  apiVersion: 1,
  contract: InviteApi,
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
};

export class InvitePlugin extends AuthPlugin.Service<InvitePlugin, Record<string, never>>()(
  "invite",
  { apiVersion: 1, contract: InviteApi },
) {
  static readonly layer = AuthPlugin.layer(InvitePlugin, {
    make: Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      const group = yield* InviteRuleGroup;
      // The rule the plugin contributes; the registry refuses one naming a group the plugin
      // does not own (BEH-EA-107), which fails this plugin's layer — i.e. composition.
      yield* registry.register(inviteOwner, {
        group,
        endpoint: "create",
        key: "principal",
        limit: 10,
        window: Duration.minutes(10),
      });
      return {};
    }),
    handlers: HttpApiBuilder.group(InviteApi, "invite", (handlers) =>
      handlers.handle("create", () => Effect.succeed("created")),
    ),
  });
}

const FixtureAuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const FixtureCsrfLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

/** What composing the Invite plugin came to: the rules it registered, or why it was refused. */
export type Composition =
  | {
      readonly _tag: "Composed";
      readonly rules: ReadonlyArray<{ readonly plugin: string; readonly group: string }>;
    }
  | { readonly _tag: "Rejected"; readonly plugin: string; readonly group: string };

export const composeInvite = (group: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          TestAuth.layer(
            Auth.make([InvitePlugin]),
            Layer.mergeAll(
              FixtureAuthenticationLive,
              FixtureCsrfLive,
              Layer.succeed(InviteRuleGroup, group),
            ),
          ),
        );
        const registry = yield* RateLimits.RateLimitsRegistry.pipe(Effect.provide(context));
        return yield* registry.registered;
      }).pipe(Effect.scoped),
    );
    if (Exit.isSuccess(exit)) {
      const composed: Composition = {
        _tag: "Composed",
        rules: exit.value.map((rule) => ({ plugin: rule.plugin, group: rule.group })),
      };
      return composed;
    }
    const failure = Cause.squash(exit.cause);
    if (failure instanceof RateLimits.RateLimitScopeViolation) {
      const rejected: Composition = {
        _tag: "Rejected",
        plugin: failure.plugin,
        group: failure.group,
      };
      return rejected;
    }
    return yield* Effect.die(failure);
  });

// ---- fake owners for the registry-ordering scenarios ----

/** A plugin value that owns one contract group and depends on nothing — enough to own a rule. */
export const fakeOwner = (id: string): AuthPlugin.Any => ({
  id,
  apiVersion: 1,
  contract: { identifier: "auth", groups: { [id]: HttpApiGroup.make(id) } },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
});

export { AcmeAudit, AcmeGate, AcmeNormalize, PRE };

/** Registers `rules` into a fresh registry (one per scenario) and reads the resolved list back. */
export const resolvedRules = (
  rules: ReadonlyArray<{ readonly owner: AuthPlugin.Any; readonly order?: number }>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(RateLimits.layer);
    return yield* Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      for (const { owner, order } of rules) {
        yield* registry
          .register(owner, {
            group: Object.keys(owner.contract.groups)[0] ?? owner.id,
            endpoint: "verify",
            key: "ip",
            limit: 3,
            window: Duration.seconds(10),
            ...(order === undefined ? {} : { order }),
          })
          .pipe(Effect.orDie);
      }
      return (yield* registry.registered).map((rule) => rule.plugin);
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped);

// ---- store doubles ----

export const unreachableStore = Layer.succeed(
  RateLimiter.RateLimiterStore,
  RateLimiter.RateLimiterStore.of({
    increment: () =>
      Effect.fail(new RateLimiter.RateLimiterStoreUnavailable({ cause: "connection refused" })),
    peek: () =>
      Effect.fail(new RateLimiter.RateLimiterStoreUnavailable({ cause: "connection refused" })),
  }),
);

/** Another store, standing in for the bring-your-own (Redis) one BEH-EA-109 names: it counts every increment it is asked for. */
export const makeAlternativeStore = () => {
  const increments = Effect.runSync(Ref.make(0));
  const layer = Layer.succeed(
    RateLimiter.RateLimiterStore,
    RateLimiter.RateLimiterStore.of({
      increment: (_key, window) =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(increments, (n) => n + 1);
          const now = yield* DateTime.now;
          return { count, resetAt: DateTime.addDuration(now, window) };
        }),
      peek: () => Effect.succeed(Option.none()),
    }),
  );
  return { layer, increments: Ref.get(increments) };
};

/**
 * BEH-EA-105/283: the anti-pattern the spec rules out — read the count, decide in application
 * code, and only then write it back. The `yieldNow` between the read and the write is the
 * window in which a concurrent caller reads the same pre-increment count.
 */
export const naiveLimiter = (limit: number) => {
  const count = Effect.runSync(Ref.make(0));
  const consume: RateLimiter.RateLimiterShape["consume"] = () =>
    Effect.gen(function* () {
      const seen = yield* Ref.get(count);
      yield* Effect.yieldNow;
      if (seen >= limit)
        return yield* new RateLimiter.RateLimitExceeded({ retryAfterMillis: 1000 });
      yield* Ref.set(count, seen + 1);
    });
  return {
    limiter: RateLimiter.RateLimiter.of({ consume }),
    primeTo: (n: number) => Ref.set(count, n),
  };
};

/** Counts every `consume` and records its key, delegating to nothing (a limiter that only listens). */
export const makeSpyLimiter = () => {
  const keys = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));
  const layer = Layer.succeed(
    RateLimiter.RateLimiter,
    RateLimiter.RateLimiter.of({
      consume: (input) => Ref.update(keys, (existing) => [...existing, input.key]),
    }),
  );
  return { layer, keys: Ref.get(keys) };
};

/** A real limiter that tightens whatever rule is asked of it to `limit` — a test's own stricter `RateLimiter` (BEH-EA-112). */
export const strictLimiter = (limit: number) =>
  Layer.effect(
    RateLimiter.RateLimiter,
    Effect.map(RateLimiter.RateLimiter, (real) =>
      RateLimiter.RateLimiter.of({ consume: (input) => real.consume({ ...input, limit }) }),
    ),
  ).pipe(Layer.provide(RateLimiter.layerMemory));

// ---- the World ----

export interface PortConfig {
  readonly limit: number;
  readonly window: Duration.Duration;
  readonly key: string;
}

/** One `consume` call's result, reduced to what a Then compares. */
export type ConsumeResult =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "Refused"; readonly error: string; readonly retryAfterMillis: number };

export interface WorldShape {
  readonly host: Host;
  readonly port: Ref.Ref<PortConfig | undefined>;
  /** The port-level limiter a scenario built, once it has. */
  readonly limiter: Ref.Ref<RateLimiter.RateLimiterShape | undefined>;
  readonly results: Ref.Ref<ReadonlyArray<ConsumeResult>>;
  /** What the Givens arranged, run by the (shared) `When` that composes the application. */
  readonly compose: Ref.Ref<Effect.Effect<void> | undefined>;
  readonly composition: Ref.Ref<Composition | undefined>;
  readonly counts: Ref.Ref<Readonly<Record<string, number>>>;
  readonly texts: Ref.Ref<Readonly<Record<string, ReadonlyArray<string>>>>;
  readonly policy: Ref.Ref<Partial<RateLimiter.RateLimiterConfigShape> | undefined>;
  readonly store: Ref.Ref<Layer.Layer<RateLimiter.RateLimiterStore> | undefined>;
  readonly statuses: Ref.Ref<ReadonlyArray<number>>;
  readonly bodies: Ref.Ref<ReadonlyArray<unknown>>;
  /** Readers into doubles a Given built (the spy limiter's keys, the memory store's size, the alternative store's increments), for the Thens. */
  readonly spyKeys: Ref.Ref<Effect.Effect<ReadonlyArray<string>> | undefined>;
  readonly memorySize: Ref.Ref<Effect.Effect<number> | undefined>;
  readonly alternativeIncrements: Ref.Ref<Effect.Effect<number> | undefined>;
}

export class World extends Context.Service<World, WorldShape>()("features/RateLimitingWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      host: yield* makeHost,
      port: yield* Ref.make<PortConfig | undefined>(undefined),
      limiter: yield* Ref.make<RateLimiter.RateLimiterShape | undefined>(undefined),
      results: yield* Ref.make<ReadonlyArray<ConsumeResult>>([]),
      compose: yield* Ref.make<Effect.Effect<void> | undefined>(undefined),
      composition: yield* Ref.make<Composition | undefined>(undefined),
      counts: yield* Ref.make<Readonly<Record<string, number>>>({}),
      texts: yield* Ref.make<Readonly<Record<string, ReadonlyArray<string>>>>({}),
      policy: yield* Ref.make<Partial<RateLimiter.RateLimiterConfigShape> | undefined>(undefined),
      store: yield* Ref.make<Layer.Layer<RateLimiter.RateLimiterStore> | undefined>(undefined),
      statuses: yield* Ref.make<ReadonlyArray<number>>([]),
      bodies: yield* Ref.make<ReadonlyArray<unknown>>([]),
      spyKeys: yield* Ref.make<Effect.Effect<ReadonlyArray<string>> | undefined>(undefined),
      memorySize: yield* Ref.make<Effect.Effect<number> | undefined>(undefined),
      alternativeIncrements: yield* Ref.make<Effect.Effect<number> | undefined>(undefined),
    });
  }),
);

export const getCount = Effect.fn("features.rateLimiting.getCount")(function* (name: string) {
  const { counts } = yield* World;
  const found = (yield* Ref.get(counts))[name];
  if (found === undefined) return yield* Effect.die(new Error(`nothing counted for "${name}"`));
  return found;
});

export const setCount = Effect.fn("features.rateLimiting.setCount")(function* (
  name: string,
  value: number,
) {
  const { counts } = yield* World;
  yield* Ref.update(counts, (existing) => ({ ...existing, [name]: value }));
});

export const setTexts = Effect.fn("features.rateLimiting.setTexts")(function* (
  name: string,
  values: ReadonlyArray<string>,
) {
  const { texts } = yield* World;
  yield* Ref.update(texts, (existing) => ({ ...existing, [name]: values }));
});

export const getTexts = Effect.fn("features.rateLimiting.getTexts")(function* (name: string) {
  const { texts } = yield* World;
  return (yield* Ref.get(texts))[name] ?? [];
});

/** `"10 seconds"` -> a `Duration`; a spelling this does not know is a typo in the scenario. */
export const durationOf = (text: string) => {
  const match = /^(\d+) (second|seconds|minute|minutes)$/.exec(text);
  if (match === null) throw new Error(`not a duration the scenarios use: "${text}"`);
  const amount = Number(match[1]);
  return match[2]?.startsWith("minute") === true
    ? Duration.minutes(amount)
    : Duration.seconds(amount);
};

/** A reader a Given stored, or a defect naming it: a Then that runs before its Given is a broken scenario. */
export const readerOf = Effect.fn("features.rateLimiting.readerOf")(function* <A>(
  cell: Ref.Ref<Effect.Effect<A> | undefined>,
  name: string,
) {
  const found = yield* Ref.get(cell);
  if (found === undefined) return yield* Effect.die(new Error(`no ${name} was set up`));
  return yield* found;
});

/** The scenario's port-level configuration, once a Given has said what the limiter is. */
export const portConfig = Effect.fn("features.rateLimiting.portConfig")(function* () {
  const { port } = yield* World;
  const found = yield* Ref.get(port);
  if (found === undefined) return yield* Effect.die(new Error("no limiter was configured"));
  return found;
});

/**
 * Builds the port limiter — `RateLimiter.layer` over `store` (the shipped memory store by
 * default) with `policy` — into the scenario's scope, and remembers it.
 */
export const buildLimiter = Effect.fn("features.rateLimiting.buildLimiter")(function* (
  store: Layer.Layer<RateLimiter.RateLimiterStore> = RateLimiter.layerStoreMemory,
  policy?: Partial<RateLimiter.RateLimiterConfigShape>,
) {
  const { host, limiter } = yield* World;
  const context = yield* Layer.buildWithScope(
    RateLimiter.layer.pipe(Layer.provide(store), Layer.provide(RateLimiter.config(policy ?? {}))),
    host.scope,
  );
  const built = Context.get(context, RateLimiter.RateLimiter);
  yield* Ref.set(limiter, built);
  return built;
});

const asResult = (exit: Exit.Exit<void, RateLimiter.RateLimitExceeded>): ConsumeResult => {
  if (Exit.isSuccess(exit)) return { _tag: "Ok" };
  const failure = Cause.squash(exit.cause);
  if (failure instanceof RateLimiter.RateLimitExceeded) {
    return { _tag: "Refused", error: failure._tag, retryAfterMillis: failure.retryAfterMillis };
  }
  throw failure;
};

/** One `consume` on the scenario's port limiter, recorded. */
export const consume = Effect.fn("features.rateLimiting.consume")(function* (key?: string) {
  const { limiter, results } = yield* World;
  const built = yield* Ref.get(limiter);
  if (built === undefined) return yield* Effect.die(new Error("no limiter was built"));
  const config = yield* portConfig();
  const exit = yield* Effect.exit(
    built.consume({ key: key ?? config.key, limit: config.limit, window: config.window }),
  );
  const result = asResult(exit);
  yield* Ref.update(results, (existing) => [...existing, result]);
  return result;
});

/** A `consume` through `limiter` with an explicit config, without touching the recorded results — for races and controls. */
export const consumeOn = (limiter: RateLimiter.RateLimiterShape, config: PortConfig) =>
  Effect.exit(
    limiter.consume({ key: config.key, limit: config.limit, window: config.window }),
  ).pipe(Effect.map(asResult));

export const results = Effect.gen(function* () {
  const world = yield* World;
  return yield* Ref.get(world.results);
});

/** The Gherkin's `RateLimited` at the level the step is at: the port's own `RateLimitExceeded`. */
export const failureNamed = (name: string) => {
  if (name !== "RateLimited") throw new Error(`unknown failure name "${name}"`);
  return "RateLimitExceeded";
};

// ---- HTTP through the composed Password plugin ----

const emailFor = (name: string) => (name.includes("@") ? name : `${name}@example.com`);

export const post = Effect.fn("features.rateLimiting.post")(function* (
  path: string,
  body: unknown,
) {
  const { host, statuses, bodies } = yield* World;
  const response = yield* host.dispatch(yield* jsonPost(path, body));
  const parsed: unknown = yield* Effect.promise(() => response.json().catch(() => undefined));
  yield* Ref.update(statuses, (existing) => [...existing, response.status]);
  yield* Ref.update(bodies, (existing) => [...existing, parsed]);
  return { status: response.status, body: parsed };
});

export const STRONG = "correct horse battery staple";

export const signUpOverHttp = (name: string) =>
  post("/password/sign-up", { email: emailFor(name), password: STRONG });

export const signInOverHttp = (name: string, password: string = STRONG) =>
  post("/password/sign-in", { email: emailFor(name), password });

export const requestResetOverHttp = (name: string) =>
  post("/password/request-reset", { email: emailFor(name) });

/** The `retryAfterMillis` of a 429 body, read without a cast. */
export const retryAfterOf = (body: unknown): number | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const value: unknown = Reflect.get(body, "retryAfterMillis");
  return typeof value === "number" ? value : undefined;
};

export const tagOf = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const value: unknown = Reflect.get(body, "_tag");
  return typeof value === "string" ? value : undefined;
};

/** The rules the Password plugin registered, for introspection (BEH-EA-110/111). */
export const registeredRules = Effect.gen(function* () {
  const { host } = yield* World;
  return yield* host.run(
    Effect.flatMap(RateLimits.RateLimitsRegistry, (registry) => registry.registered),
  );
});
