// BEH-EA-107/108/111 (plan 06 §5.2 T1-T8): the compile-time half of the rate-limit budget. Nothing
// here executes its assertions: they are the `@ts-expect-error` directives (and the positive
// compilation of the cycle gate), checked by `tsc -p tsconfig.test.json`.
import { RateLimiter } from "@awthaq/ports";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as RateLimits from "../src/RateLimits.ts";

const contract = HttpApi.make("auth").add(
  HttpApiGroup.make("fixture").add(
    HttpApiEndpoint.get("go", "/fixture", { success: Schema.String }),
  ),
);

const rules = {
  signInByIp: RateLimits.rule({
    group: "fixture",
    endpoint: "go",
    key: RateLimits.Key.ip,
    limit: 5,
    window: "1 minute",
  }),
  signIn: RateLimits.rule({
    group: "fixture",
    endpoint: "go",
    key: RateLimits.Key.email,
    limit: 5,
    window: "1 minute",
  }),
  lock: RateLimits.failureRule({
    group: "fixture",
    endpoint: "go",
    key: RateLimits.Key.user,
    limit: 5,
    window: "1 minute",
  }),
};

// T8, the cycle gate: `budget(Fixture)` inside Fixture's own `layer` initializer, with no annotation
// and no comment. Before the narrow `Owner`, this was TS7022 ("'layer' implicitly has type 'any'").
class Fixture extends AuthPlugin.Service<Fixture, {}>()("fixture", {
  apiVersion: 1,
  contract,
  rateLimitRules: rules,
}) {
  static readonly layer = AuthPlugin.layer(Fixture, {
    ports: [RateLimiter.RateLimiter],
    make: Effect.gen(function* () {
      const limits = yield* RateLimits.budget(Fixture);

      // the positive shapes
      yield* limits.spend("signInByIp", { ip: "1.2.3.4" });
      yield* limits.spend(["signInByIp", "signIn"], { ip: undefined, email: "a@b.c" });
      yield* limits.guard("lock", { userId: "u" });
      yield* limits.charge("lock", { userId: "u" });

      // @ts-expect-error T1 - a name that is not in the table
      yield* limits.spend("unknown", { ip: "1.2.3.4" });
      // @ts-expect-error T2 - the second rule keys on `email`, which the input lacks
      yield* limits.spend(["signInByIp", "signIn"], { ip: "1.2.3.4" });
      // @ts-expect-error T3 - `lock` is a failure budget: it is guarded and charged, never spent
      yield* limits.spend("lock", { userId: "u" });
      // @ts-expect-error T4 - `signIn` is an attempts rule: it is spent, never guarded
      yield* limits.guard("signIn", { email: "a@b.c" });
      return {};
    }),
  });
}

describe("RateLimitBudget types", () => {
  it("is checked by tsc, not at run time", () => {
    void Fixture;
  });

  it("T5: a rule naming a group outside the contract is refused", () => {
    class Stray extends AuthPlugin.Service<Stray, {}>()("fixture", {
      apiVersion: 1,
      contract,
      rateLimitRules: {
        // @ts-expect-error T5 - "foreign" is not one of this plugin's contract groups
        x: RateLimits.rule({
          group: "foreign",
          endpoint: "go",
          key: RateLimits.Key.ip,
          limit: 1,
          window: "1 minute",
        }),
      },
    }) {}
    void Stray;
  });

  it("T6: tuning an unknown rule is refused", () => {
    RateLimits.tune(Fixture, { signIn: { limit: 1 } });
    // @ts-expect-error T6 - `nope` is not a rule of Fixture
    RateLimits.tune(Fixture, { nope: { limit: 1 } });
  });

  it("T7: a bare string is not a key strategy", () => {
    RateLimits.rule({
      group: "g",
      endpoint: "e",
      key: RateLimits.Key.ip,
      limit: 1,
      window: "1 minute",
    });
    RateLimits.rule({
      group: "g",
      endpoint: "e",
      // @ts-expect-error T7 - keying on caller-supplied data needs Key.custom
      key: "x-forwarded-for",
      limit: 1,
      window: "1 minute",
    });
  });
});
