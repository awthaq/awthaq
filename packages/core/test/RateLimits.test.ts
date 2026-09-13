// spec/behaviors/14-rate-limiting.md, BEH-EA-107/108/110/111. See
// src/RateLimits.ts's own header comment for why the registry is a real,
// per-composition service rather than module-level state, and for what
// BEH-EA-111's full dependency-aware ordering still needs.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpApiGroup } from "effect/unstable/httpapi";
import type { AuthPlugin } from "../src/index.ts";
import { RateLimits } from "../src/index.ts";

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
