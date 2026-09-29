// spec/behaviors/14-rate-limiting.md, BEH-EA-107/108/110/111. See
// src/RateLimits.ts's own header comment for why the registry is a real,
// per-composition service rather than module-level state, and for what
// BEH-EA-111's full dependency-aware ordering still needs.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";
import { RateLimiter } from "@awthaq/ports";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type { AuthPlugin } from "../src/index.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as RateLimits from "../src/RateLimits.ts";

const fakePlugin = (id: string, groups: ReadonlyArray<string>): AuthPlugin.Any => ({
  id,
  apiVersion: 1,
  contract: {
    identifier: "auth",
    groups: Object.fromEntries(groups.map((name) => [name, HttpApiGroup.make(name)])),
  },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
});

/** Builds (and immediately tears down) `RateLimits.rule`'s own `Layer` — the effectDiscard registration is what runs, not anything long-lived. */
const install = (
  owner: AuthPlugin.Any,
  input: RateLimits.RuleInput,
): Effect.Effect<void, RateLimits.RateLimitScopeViolation, RateLimits.RateLimitsRegistry> =>
  Effect.scoped(Layer.build(RateLimits.rule(owner, input))).pipe(Effect.asVoid);

describe("RateLimits.rule (BEH-EA-107)", () => {
  it.effect("a plugin may rate-limit one of its own contract groups", () =>
    Effect.gen(function* () {
      const invite = fakePlugin("invite", ["invite"]);
      yield* install(invite, {
        group: "invite",
        endpoint: "create",
        key: "principal",
        limit: 10,
        window: Duration.minutes(10),
      });
      const registry = yield* RateLimits.RateLimitsRegistry;
      const rules = yield* registry.registered;
      assert.strictEqual(rules.length, 1);
      assert.strictEqual(rules[0]?.plugin, "invite");
      assert.strictEqual(rules[0]?.group, "invite");
    }).pipe(Effect.provide(RateLimits.layer)),
  );

  it.effect("a plugin cannot rate-limit a group that isn't its own", () =>
    Effect.gen(function* () {
      const invite = fakePlugin("invite", ["invite"]);
      const failure = yield* install(invite, {
        group: "password",
        endpoint: "signIn",
        key: "ip",
        limit: 5,
        window: Duration.seconds(10),
      }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimitScopeViolation");
      assert.strictEqual(failure.plugin, "invite");
      assert.strictEqual(failure.group, "password");
    }).pipe(Effect.provide(RateLimits.layer)),
  );
});

describe("RateLimits.RateLimitsRegistry.registered (BEH-EA-111)", () => {
  it.effect("orders by declared `order`, regardless of registration order", () =>
    Effect.gen(function* () {
      const twoFactor = fakePlugin("two-factor", ["two-factor"]);
      const password = fakePlugin("password", ["password"]);
      yield* install(twoFactor, {
        group: "two-factor",
        endpoint: "verify",
        key: "principal",
        limit: 3,
        window: Duration.seconds(10),
        order: 1,
      });
      yield* install(password, {
        group: "password",
        endpoint: "signIn",
        key: "ip",
        limit: 5,
        window: Duration.seconds(10),
        order: 0,
      });
      const registry = yield* RateLimits.RateLimitsRegistry;
      const rules = yield* registry.registered;
      assert.deepStrictEqual(
        rules.map((rule) => rule.plugin),
        ["password", "two-factor"],
      );
    }).pipe(Effect.provide(RateLimits.layer)),
  );

  it.effect(
    "BEH-EA-111 (REQ-EA-299): a dependent plugin's rules list after its dependency's, whatever their declared order; equal keys fall to plugin id",
    () =>
      Effect.gen(function* () {
        const base = fakePlugin("zeta", ["zeta"]);
        const dependent: AuthPlugin.Any = { ...fakePlugin("alpha", ["alpha"]), dependsOn: [base] };
        const peer = fakePlugin("beta", ["beta"]);
        const rule = (group: string, order?: number): RateLimits.RuleInput => ({
          group,
          endpoint: "verify",
          key: "ip",
          limit: 3,
          window: Duration.seconds(10),
          ...(order === undefined ? {} : { order }),
        });
        // Registered dependent-first, and the dependent even declares the lowest order:
        // dependency order still wins, then declared order, then plugin id.
        yield* install(dependent, rule("alpha", -10));
        yield* install(peer, rule("beta"));
        yield* install(base, rule("zeta"));
        const registry = yield* RateLimits.RateLimitsRegistry;
        assert.deepStrictEqual(
          (yield* registry.registered).map((registered) => registered.plugin),
          ["beta", "zeta", "alpha"],
        );
      }).pipe(Effect.provide(RateLimits.layer)),
  );

  it.effect("BEH-EA-024: freezes at first read — a rule registered afterward is a defect", () =>
    Effect.gen(function* () {
      const invite = fakePlugin("invite", ["invite"]);
      const registry = yield* RateLimits.RateLimitsRegistry;
      yield* registry.registered;
      const exit = yield* Effect.exit(
        registry.register(invite, {
          group: "invite",
          endpoint: "create",
          key: "principal",
          limit: 1,
          window: Duration.seconds(1),
        }),
      );
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(RateLimits.layer)),
  );
});

describe("RateLimits.enforce (EOTS-007)", () => {
  const EnforceLive = RateLimiter.layer.pipe(
    Layer.provide(RateLimiter.layerStoreMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
  );
  const input = {
    key: "password:signin:alice@example.com",
    limit: 1,
    window: Duration.minutes(1),
    meta: {
      group: "password",
      endpoint: "signIn",
      rule: "signIn",
      dimension: "identity" as const,
    },
  };

  it.effect("a breach publishes auth.rateLimit.exceeded without the raw key", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const collected = yield* Effect.forkChild(
        events.stream.pipe(Stream.take(1), Stream.runCollect),
        { startImmediately: true },
      );
      yield* RateLimits.enforce(input);
      const failure = yield* RateLimits.enforce(input).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimitExceeded");
      const [event] = yield* Fiber.join(collected);
      assert.strictEqual(event?._tag, "auth.rateLimit.exceeded");
      assert.strictEqual(event?._tag === "auth.rateLimit.exceeded" && event.rule, "signIn");
      assert.isFalse(JSON.stringify(event).includes("alice"));
    }).pipe(Effect.provide(EnforceLive)),
  );

  it.effect("a breach increments the exceeded counter and logs a warning without the key", () =>
    Effect.gen(function* () {
      const messages: Array<string> = [];
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") messages.push(JSON.stringify(options));
      });
      const counter = Metric.withAttributes(RateLimits.exceededCounter, {
        group: "password",
        endpoint: "signIn",
        rule: "signIn",
        dimension: "identity",
      });
      const before = (yield* Metric.value(counter)).count;
      yield* RateLimits.enforce(input);
      yield* RateLimits.enforce(input).pipe(Effect.flip, Effect.provide(Logger.layer([capture])));
      assert.strictEqual((yield* Metric.value(counter)).count, before + 1);
      assert.strictEqual(messages.length, 1);
      assert.isFalse(messages[0]?.includes("alice"));
    }).pipe(Effect.provide(EnforceLive)),
  );

  it.effect("an admitted call emits nothing", () =>
    Effect.gen(function* () {
      const counter = Metric.withAttributes(RateLimits.exceededCounter, {
        group: "password",
        endpoint: "signIn",
        rule: "signIn",
        dimension: "identity",
      });
      const before = (yield* Metric.value(counter)).count;
      yield* RateLimits.enforce({ ...input, key: "fresh", limit: 5 });
      assert.strictEqual((yield* Metric.value(counter)).count, before);
    }).pipe(Effect.provide(EnforceLive)),
  );
});
