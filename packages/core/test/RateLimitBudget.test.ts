// spec/behaviors/14-rate-limiting.md, BEH-EA-105 through BEH-EA-111 — `RateLimits.budget`: a plugin
// declares its rules once (`rateLimitRules`), opens one budget and spends by name (plan 06 §5.2).
import { Api } from "@awthaq/api";
import { RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as RateLimits from "../src/RateLimits.ts";

const minute = Duration.minutes(1);

const InviteApi = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("invite").add(
      HttpApiEndpoint.post("create", "/invite", { success: Schema.String }),
    ),
  )
  .add(
    HttpApiGroup.make("invite.admin").add(
      HttpApiEndpoint.post("revoke", "/invite/revoke", { success: Schema.String }),
    ),
  );

const rules = {
  createByIp: RateLimits.rule({
    group: "invite",
    endpoint: "create",
    key: RateLimits.Key.ip,
    limit: 1,
    window: minute,
  }),
  createByEmail: RateLimits.rule({
    group: "invite",
    endpoint: "create",
    key: RateLimits.Key.email,
    limit: 2,
    window: minute,
  }),
  revokeByUser: RateLimits.rule({
    group: "invite.admin",
    endpoint: "*",
    key: RateLimits.Key.user,
    limit: 3,
    window: minute,
  }),
  lockout: RateLimits.failureRule({
    group: "invite",
    endpoint: "create",
    key: RateLimits.Key.user,
    limit: 2,
    window: minute,
    bucket: "invite.lockout",
  }),
};

const inviteOwner = RateLimits.owner({ id: "invite", contract: InviteApi, rateLimits: rules });

/** A hand-built owner whose group list and table are plain data (the scope, bucket and ordering cases). */
const handOwner = <const Limits extends RateLimits.Table>(
  id: string,
  groups: ReadonlyArray<string>,
  table: Limits,
  dependsOn: ReadonlyArray<RateLimits.Owner<RateLimits.Table>> = [],
) => {
  const made: RateLimits.Owner<Limits> = {
    id,
    dependsOn,
    contract: { groups: Object.fromEntries(groups.map((group) => [group, true])) },
    rateLimitRules: table,
  };
  return made;
};

const ipRule = (group: string, order = 0) =>
  RateLimits.rule({
    group,
    endpoint: "e",
    key: RateLimits.Key.ip,
    limit: 2,
    window: minute,
    order,
  });

const ipRuleIn = (group: string, bucket: string) =>
  RateLimits.rule({
    group,
    endpoint: "e",
    key: RateLimits.Key.ip,
    limit: 2,
    window: minute,
    bucket,
  });

const Live = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(RateLimits.layer),
);

/** The defect an effect died with, or undefined. */
const defectOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
  );

const tagOf = (defect: unknown) =>
  typeof defect === "object" && defect !== null && "_tag" in defect ? defect._tag : undefined;

/** How many `spend`s of `name` over one fixed input are admitted before the first refusal. */
const admitted = <E, R>(spend: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    let count = 0;
    while (count < 20 && (yield* Effect.exit(spend))._tag === "Success") count += 1;
    return count;
  });

describe("RateLimits.budget registration (BEH-EA-107/111)", () => {
  it.effect("registers the table in order with name, key, mode, bucket and sizing", () =>
    Effect.gen(function* () {
      yield* RateLimits.budget(inviteOwner);
      const registry = yield* RateLimits.RateLimitsRegistry;
      const registered = yield* registry.registered;
      assert.deepStrictEqual(
        registered.map((rule) => [rule.plugin, rule.name, rule.strategy, rule.mode, rule.bucket]),
        [
          ["invite", "createByIp", "ip", "attempts", "invite.createByIp"],
          ["invite", "createByEmail", "email", "attempts", "invite.createByEmail"],
          ["invite", "revokeByUser", "user", "attempts", "invite.admin.revokeByUser"],
          ["invite", "lockout", "user", "failures", "invite.lockout"],
        ],
      );
      assert.deepStrictEqual(
        registered.map((rule) => rule.limit),
        [1, 2, 3, 2],
      );
    }).pipe(Effect.provide(Live)),
  );

  it.effect(
    "orders across owners by dependency, then declared order, then plugin id (REQ-EA-299)",
    () =>
      Effect.gen(function* () {
        const base = handOwner("zeta", ["zeta"], { r: ipRule("zeta") });
        const dependent = handOwner("alpha", ["alpha"], { r: ipRule("alpha", -10) }, [base]);
        const peer = handOwner("beta", ["beta"], { r: ipRule("beta") });
        yield* RateLimits.budget(dependent);
        yield* RateLimits.budget(peer);
        yield* RateLimits.budget(base);
        const registry = yield* RateLimits.RateLimitsRegistry;
        assert.deepStrictEqual(
          (yield* registry.registered).map((rule) => rule.plugin),
          ["beta", "zeta", "alpha"],
        );
      }).pipe(Effect.provide(Live)),
  );

  it.effect("BEH-EA-024: a budget opened after registered was read is a defect", () =>
    Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      yield* registry.registered;
      const defect = yield* defectOf(RateLimits.budget(inviteOwner));
      assert.strictEqual(tagOf(defect), "RateLimitsFrozen");
    }).pipe(Effect.provide(Live)),
  );

  it.effect("BEH-EA-107: a rule naming a group outside the owner's contract is a defect", () =>
    Effect.gen(function* () {
      const stray = handOwner("invite", ["invite"], { r: ipRule("password") });
      const defect = yield* defectOf(RateLimits.budget(stray));
      assert.strictEqual(tagOf(defect), "RateLimitScopeViolation");
      assert.deepInclude(defect, { plugin: "invite", group: "password" });
    }).pipe(Effect.provide(Live)),
  );

  it.effect("opening one owner's budget twice is a defect", () =>
    Effect.gen(function* () {
      yield* RateLimits.budget(inviteOwner);
      const defect = yield* defectOf(RateLimits.budget(inviteOwner));
      assert.strictEqual(tagOf(defect), "RateLimitBudgetAlreadyOpen");
    }).pipe(Effect.provide(Live)),
  );

  it.effect("budgetOf before open is a defect; after open it shares buckets with the opener", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        tagOf(yield* defectOf(RateLimits.budgetOf(inviteOwner))),
        "RateLimitBudgetNotOpened",
      );
      const opened = yield* RateLimits.budget(inviteOwner);
      const again = yield* RateLimits.budgetOf(inviteOwner);
      yield* opened.spend("createByIp", { ip: "9.9.9.9" });
      const refused = yield* again.spend("createByIp", { ip: "9.9.9.9" }).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "RateLimited");
    }).pipe(Effect.provide(Live)),
  );
});

describe("shared buckets (BEH-EA-107)", () => {
  it.effect("rules naming one bucket share one counter", () =>
    Effect.gen(function* () {
      const shared = handOwner("invite", ["invite"], {
        a: ipRuleIn("invite", "invite.shared"),
        b: ipRuleIn("invite", "invite.shared"),
      });
      const limits = yield* RateLimits.budget(shared);
      yield* limits.spend("a", { ip: "1.1.1.1" });
      yield* limits.spend("b", { ip: "1.1.1.1" });
      const refused = yield* limits.spend("a", { ip: "1.1.1.1" }).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "RateLimited");
    }).pipe(Effect.provide(Live)),
  );

  it.effect("unequal sizing in one bucket is a defect", () =>
    Effect.gen(function* () {
      const uneven = handOwner("invite", ["invite"], {
        a: ipRuleIn("invite", "invite.shared"),
        b: RateLimits.rule({
          group: "invite",
          endpoint: "e",
          key: RateLimits.Key.ip,
          limit: 9,
          window: minute,
          bucket: "invite.shared",
        }),
      });
      assert.strictEqual(
        tagOf(yield* defectOf(RateLimits.budget(uneven))),
        "RateLimitBucketConflict",
      );
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a bucket outside the owner's own groups is a defect", () =>
    Effect.gen(function* () {
      const poacher = handOwner("invite", ["invite"], {
        a: ipRuleIn("invite", "password.signIn"),
      });
      assert.strictEqual(
        tagOf(yield* defectOf(RateLimits.budget(poacher))),
        "RateLimitBucketConflict",
      );
    }).pipe(Effect.provide(Live)),
  );
});

describe("spend (BEH-EA-105/106, EOTS-007)", () => {
  it.effect("consumes exactly the bucket key the rule derives", () =>
    Effect.gen(function* () {
      const consumed: Array<string> = [];
      const recording = Layer.succeed(
        RateLimiter.RateLimiter,
        RateLimiter.RateLimiter.of({
          consume: (input) => Effect.sync(() => void consumed.push(input.key)),
          check: () => Effect.void,
        }),
      );
      const limits = yield* RateLimits.budget(inviteOwner).pipe(Effect.provide(recording));
      yield* limits
        .spend(["createByIp", "createByEmail"], { ip: "1.2.3.4", email: "Alice+x@Example.com" })
        .pipe(Effect.provide(recording));
      assert.deepStrictEqual(consumed, [
        "ratelimit:invite.createByIp:ip:1.2.3.4",
        "ratelimit:invite.createByEmail:email:alice@example.com",
      ]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("consumes in order and stops at the first refusal", () =>
    Effect.gen(function* () {
      const consumed: Array<string> = [];
      const refusingIp = Layer.succeed(
        RateLimiter.RateLimiter,
        RateLimiter.RateLimiter.of({
          consume: (input) =>
            Effect.suspend(() => {
              consumed.push(input.key);
              return input.key.includes(":ip:")
                ? Effect.fail(new RateLimiter.RateLimitExceeded({ retryAfterMillis: 5 }))
                : Effect.void;
            }),
          check: () => Effect.void,
        }),
      );
      const limits = yield* RateLimits.budget(inviteOwner).pipe(Effect.provide(refusingIp));
      const failure = yield* limits
        .spend(["createByIp", "createByEmail"], { ip: "1.2.3.4", email: "a@b.c" })
        .pipe(Effect.provide(refusingIp), Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
      assert.deepStrictEqual(consumed, ["ratelimit:invite.createByIp:ip:1.2.3.4"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a breach answers Api.RateLimited and publishes without the key", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const limits = yield* RateLimits.budget(inviteOwner);
      const collected = yield* Effect.forkChild(
        events.stream.pipe(Stream.take(1), Stream.runCollect),
        { startImmediately: true },
      );
      yield* limits.spend("createByEmail", { email: "alice@example.com" });
      yield* limits.spend("createByEmail", { email: "alice@example.com" });
      const failure = yield* limits
        .spend("createByEmail", { email: "alice@example.com" })
        .pipe(Effect.flip);
      assert.instanceOf(failure, Api.RateLimited);
      assert.isAbove(failure.retryAfterMillis, 0);
      const [event] = yield* Fiber.join(collected);
      assert.deepInclude(event, {
        _tag: "auth.rateLimit.exceeded",
        group: "invite",
        endpoint: "create",
        rule: "createByEmail",
        dimension: "identity",
      });
      assert.isFalse(JSON.stringify(event).includes("alice"));
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a breach increments the counter and logs a warning without the key", () =>
    Effect.gen(function* () {
      const messages: Array<string> = [];
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") messages.push(JSON.stringify(options));
      });
      const counter = Metric.withAttributes(RateLimits.exceededCounter, {
        group: "invite",
        endpoint: "create",
        rule: "createByIp",
        dimension: "ip",
      });
      const before = (yield* Metric.value(counter)).count;
      const limits = yield* RateLimits.budget(inviteOwner);
      yield* limits.spend("createByIp", { ip: "7.7.7.7" });
      yield* limits
        .spend("createByIp", { ip: "7.7.7.7" })
        .pipe(Effect.flip, Effect.provide(Logger.layer([capture])));
      assert.strictEqual((yield* Metric.value(counter)).count, before + 1);
      assert.strictEqual(messages.length, 1);
      assert.isFalse(messages[0]?.includes("7.7.7.7"));
    }).pipe(Effect.provide(Live)),
  );

  it.effect("an admitted call emits nothing", () =>
    Effect.gen(function* () {
      const counter = Metric.withAttributes(RateLimits.exceededCounter, {
        group: "invite",
        endpoint: "create",
        rule: "createByIp",
        dimension: "ip",
      });
      const before = (yield* Metric.value(counter)).count;
      const limits = yield* RateLimits.budget(inviteOwner);
      yield* limits.spend("createByIp", { ip: "8.8.8.8" });
      assert.strictEqual((yield* Metric.value(counter)).count, before);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a group-wide rule reports the endpoint spend names", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const limits = yield* RateLimits.budget(inviteOwner);
      const collected = yield* Effect.forkChild(
        events.stream.pipe(Stream.take(1), Stream.runCollect),
        { startImmediately: true },
      );
      const spend = limits.spend("revokeByUser", { userId: "u1" }, { endpoint: "revoke" });
      yield* spend;
      yield* spend;
      yield* spend;
      yield* spend.pipe(Effect.flip);
      const [event] = yield* Fiber.join(collected);
      assert.deepInclude(event, {
        group: "invite.admin",
        endpoint: "revoke",
        rule: "revokeByUser",
      });
    }).pipe(Effect.provide(Live)),
  );

  it.effect("RateLimiter.layerPermissive never refuses", () =>
    Effect.gen(function* () {
      const limits = yield* RateLimits.budget(inviteOwner);
      const count = yield* admitted(limits.spend("createByIp", { ip: "6.6.6.6" }));
      assert.strictEqual(count, 20);
    }).pipe(
      Effect.provide(
        RateLimiter.layerPermissive.pipe(
          Layer.provideMerge(AuthEvents.layer),
          Layer.provideMerge(AuditLog.layerMemory),
          Layer.provideMerge(RateLimits.layer),
        ),
      ),
    ),
  );
});

describe("guard and charge (BCR-006)", () => {
  it.effect("guard never counts; it refuses once charge has spent the limit, observably", () =>
    Effect.gen(function* () {
      const counter = Metric.withAttributes(RateLimits.exceededCounter, {
        group: "invite",
        endpoint: "create",
        rule: "lockout",
        dimension: "principal",
      });
      const before = (yield* Metric.value(counter)).count;
      const limits = yield* RateLimits.budget(inviteOwner);
      for (let i = 0; i < 5; i++) yield* limits.guard("lockout", { userId: "u1" });
      yield* limits.charge("lockout", { userId: "u1" });
      yield* limits.guard("lockout", { userId: "u1" });
      yield* limits.charge("lockout", { userId: "u1" });
      const refused = yield* limits.guard("lockout", { userId: "u1" }).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "RateLimited");
      assert.strictEqual((yield* Metric.value(counter)).count, before + 1);
      // charge itself is silent and never fails, even past the limit
      yield* limits.charge("lockout", { userId: "u1" });
      assert.strictEqual((yield* Metric.value(counter)).count, before + 1);
    }).pipe(Effect.provide(Live)),
  );
});

describe("tuning and overrides (BEH-EA-110)", () => {
  const ip = (n: number) => ({ ip: `10.0.0.${n}` });

  it.effect("tune is evaluated per call, so a config in force applies without a rebuild", () =>
    Effect.gen(function* () {
      const limit = yield* Ref.make(1);
      const limits = yield* RateLimits.budget(inviteOwner, {
        tune: Effect.map(Ref.get(limit), (value) => ({ createByIp: { limit: value } })),
      });
      yield* limits.spend("createByIp", ip(4));
      assert.strictEqual(
        (yield* limits.spend("createByIp", ip(4)).pipe(Effect.flip))._tag,
        "RateLimited",
      );
      yield* Ref.set(limit, 3);
      yield* limits.spend("createByIp", ip(4));
    }).pipe(Effect.provide(Live)),
  );

  it.effect("an invalid override dies with an invalid-configuration defect", () =>
    Effect.gen(function* () {
      const built = yield* defectOf(
        RateLimits.budget(inviteOwner, { tune: Effect.succeed({ createByIp: { limit: 0 } }) }),
      );
      assert.strictEqual(tagOf(built), "Defects/InvalidConfiguration");
      const limits = yield* RateLimits.budget(inviteOwner);
      const fiber = yield* defectOf(
        limits.spend("createByIp", ip(5)).pipe(
          Effect.provideService(RateLimits.RateLimitOverrides, {
            invite: { createByIp: { window: "0 millis" } },
          }),
        ),
      );
      assert.strictEqual(tagOf(fiber), "Defects/InvalidConfiguration");
    }).pipe(Effect.provide(Live)),
  );
});

describe("precedence of the four levels", () => {
  const spendCount = (limits: RateLimits.Budget<typeof rules>, n: number) =>
    admitted(limits.spend("createByIp", { ip: `10.1.0.${n}` }));

  it.effect("declared is 1", () =>
    Effect.gen(function* () {
      const limits = yield* RateLimits.budget(inviteOwner);
      assert.strictEqual(yield* spendCount(limits, 1), 1);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("tune beats the declaration", () =>
    Effect.gen(function* () {
      const limits = yield* RateLimits.budget(inviteOwner, {
        tune: Effect.succeed({ createByIp: { limit: 2 } }),
      });
      assert.strictEqual(yield* spendCount(limits, 2), 2);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("the application's overrides layer beats tune", () =>
    Effect.gen(function* () {
      const limits = yield* RateLimits.budget(inviteOwner, {
        tune: Effect.succeed({ createByIp: { limit: 2 } }),
      }).pipe(
        Effect.provide(
          RateLimits.overrides(RateLimits.tune(inviteOwner, { createByIp: { limit: 3 } })),
        ),
      );
      assert.strictEqual(yield* spendCount(limits, 3), 3);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a fiber-provided override beats the layer", () =>
    Effect.gen(function* () {
      const limits = yield* RateLimits.budget(inviteOwner, {
        tune: Effect.succeed({ createByIp: { limit: 2 } }),
      }).pipe(
        Effect.provide(
          RateLimits.overrides(RateLimits.tune(inviteOwner, { createByIp: { limit: 3 } })),
        ),
      );
      const count = yield* spendCount(limits, 4).pipe(
        Effect.provideService(RateLimits.RateLimitOverrides, {
          invite: { createByIp: { limit: 4 } },
        }),
      );
      assert.strictEqual(count, 4);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("overrides enable escalation for a shipped rule (RBS-009)", () =>
    Effect.gen(function* () {
      const limits = yield* RateLimits.budget(inviteOwner).pipe(
        Effect.provide(
          RateLimits.overrides(
            RateLimits.tune(inviteOwner, {
              createByIp: {
                limit: 1,
                window: Duration.seconds(10),
                escalation: { factor: 2, maxPenalty: Duration.minutes(5) },
              },
            }),
          ),
        ),
      );
      const input = { ip: "10.2.0.1" };
      yield* limits.spend("createByIp", input);
      const first = yield* limits.spend("createByIp", input).pipe(Effect.flip);
      assert.isTrue(first.retryAfterMillis <= 10_000);
      yield* TestClock.adjust(Duration.seconds(10));
      yield* limits.spend("createByIp", input);
      const second = yield* limits.spend("createByIp", input).pipe(Effect.flip);
      assert.strictEqual(second.retryAfterMillis, 20_000);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("overrides merge several plugins' entries into one layer", () =>
    Effect.gen(function* () {
      const shape = yield* Effect.provide(
        Effect.service(RateLimits.RateLimitOverrides),
        RateLimits.overrides(
          RateLimits.tune(inviteOwner, { createByIp: { limit: 3 } }),
          RateLimits.tune(inviteOwner, { lockout: { limit: 9 } }),
          RateLimits.tune(handOwner("other", ["other"], {}), {}),
        ),
      );
      assert.deepStrictEqual(shape, {
        invite: { createByIp: { limit: 3 }, lockout: { limit: 9 } },
        other: {},
      });
    }),
  );
});

// ---- the guard: declared means opened (B17) ----------------------------------------------------

const GuardApi = HttpApi.make("auth").add(
  HttpApiGroup.make("guarded").add(
    HttpApiEndpoint.get("ping", "/guarded", { success: Schema.String }),
  ),
);

const guardedRules = {
  pingByIp: RateLimits.rule({
    group: "guarded",
    endpoint: "ping",
    key: RateLimits.Key.ip,
    limit: 1,
    window: minute,
  }),
};

describe("AuthPlugin.layer refuses a plugin that declares rules and never opens its budget", () => {
  class Forgetful extends AuthPlugin.Service<Forgetful, {}>()("guarded", {
    apiVersion: 1,
    contract: GuardApi,
    rateLimitRules: guardedRules,
  }) {
    static readonly layer = AuthPlugin.layer(Forgetful, { make: Effect.succeed({}) });
  }

  // The cycle gate (T8): no annotation, no comment; `budget(Self)` inside Self's own layer.
  class Diligent extends AuthPlugin.Service<Diligent, {}>()("guarded", {
    apiVersion: 1,
    contract: GuardApi,
    rateLimitRules: guardedRules,
  }) {
    static readonly layer = AuthPlugin.layer(Diligent, {
      ports: [RateLimiter.RateLimiter],
      make: Effect.gen(function* () {
        const limits = yield* RateLimits.budget(Diligent);
        yield* limits.spend("pingByIp", { ip: "1.2.3.4" });
        return {};
      }),
    });
  }

  class Quiet extends AuthPlugin.Service<Quiet, {}>()("quiet", {
    apiVersion: 1,
    contract: HttpApi.make("auth"),
  }) {
    static readonly layer = AuthPlugin.layer(Quiet, { make: Effect.succeed({}) });
  }

  it.effect("names the plugin and its rules", () =>
    Effect.gen(function* () {
      const defect = yield* defectOf(Effect.scoped(Layer.build(Forgetful.layer)));
      assert.strictEqual(tagOf(defect), "RateLimitBudgetNotOpened");
      assert.deepInclude(defect, { plugin: "guarded", rules: ["pingByIp"] });
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a plugin that opens its budget builds, and its handle is readable", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(Diligent.layer));
      const registry = yield* RateLimits.RateLimitsRegistry;
      assert.isTrue((yield* registry.handleOf("guarded"))._tag === "Some");
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a plugin with no rules builds without RateLimits.layer in scope", () =>
    Effect.scoped(Layer.build(Quiet.layer)).pipe(Effect.asVoid),
  );

  it("derives the static declaration from the table", () => {
    assert.deepStrictEqual(
      Diligent.rateLimits.map((rule) => [
        rule.group,
        rule.endpoint,
        rule.name,
        rule.dimension,
        rule.key,
        rule.mode,
      ]),
      [["guarded", "ping", "pingByIp", "ip", "ip", "attempts"]],
    );
  });
});
