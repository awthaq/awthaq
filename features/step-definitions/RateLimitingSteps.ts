// AH-003 tier 3: the steps of 14-rate-limiting.feature (BEH-EA-105 through BEH-EA-112). The
// fixed-window claims run against the real `RateLimiter.layer` over the real memory store under
// `TestClock`; the plugin-facing ones (built-in rules, key spaces, the permissive test default)
// run Password's real rules over the real HTTP handler. Where the Gherkin names something the
// shipped API spells differently (`RateLimited` at the port, `onUnavailable`, the Redis store)
// the step that receives the name maps it and says so.
import { Api } from "@awthaq/api";
import { HookPoint, RateLimits } from "@awthaq/core";
import { ClientAddress, RateLimiter } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import {
  AcmeAudit,
  AcmeGate,
  AcmeNormalize,
  buildLimiter,
  composeInvite,
  consume,
  consumeOn,
  durationOf,
  failureNamed,
  fakeOwner,
  getCount,
  getTexts,
  makeAlternativeStore,
  makeSpyLimiter,
  naiveLimiter,
  PRE,
  portConfig,
  readerOf,
  registeredRules,
  requestResetOverHttp,
  resolvedRules,
  results,
  retryAfterOf,
  setCount,
  setTexts,
  signInOverHttp,
  signUpOverHttp,
  strictLimiter,
  tagOf,
  unreachableStore,
  World,
  type WorldShape,
} from "./RateLimitingWorld.ts";
import { resolvedBeforeSignUp } from "./HooksWorld.ts";
import { assertTypeGate } from "./FoundationsWorld.ts";
import { inTwoFactorApp } from "./TwoFactorWorld.ts";

/** `Password.signIn` for an account the scenario signed up: only whether it was refused for rate limiting matters. */
const signInAttempt = (email: string) =>
  Effect.flatMap(Password.Password, (password) =>
    password.signIn({ email, password: Redacted.make("correct horse battery staple") }),
  ).pipe(
    Effect.match({
      onFailure: (error) => (error instanceof Api.RateLimited ? "rate-limited" : error._tag),
      onSuccess: () => "ok",
    }),
  );

export const rateLimitingSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-105: the port ----

  Given("a plugin wanting to throttle one of its own endpoints", function* () {
    // The password plugin, over a limiter that only listens: no store anywhere in the graph.
    const { host, spyKeys } = yield* World;
    const spy = makeSpyLimiter();
    yield* host.configure((spec) => ({ ...spec, rateLimiter: spy.layer }));
    yield* Ref.set(spyKeys, spy.keys);
  });

  When("it enforces that limit", function* () {
    const { host } = yield* World;
    yield* host.run(
      Effect.flatMap(Password.Password, (password) =>
        password.signUp({
          email: "alice@example.com",
          password: Redacted.make("correct horse battery staple"),
        }),
      ).pipe(Effect.orDie),
    );
    yield* host.run(signInAttempt("alice@example.com"));
  });

  Then("it does so only by calling {string}", function* (call: string) {
    assert.equal(call, "RateLimiter.consume");
    const { spyKeys } = yield* World;
    const keys = yield* readerOf(spyKeys, "spy limiter");
    assert.ok(keys.includes("password:signup:alice@example.com"), "sign-up never called consume");
    assert.ok(keys.includes("password:signin:alice@example.com"), "sign-in never called consume");
  });

  Then(
    "it does not read or write a rate-limit count directly against any backing store itself",
    function* () {
      // There is no store in the composition for it to reach: the only thing it was given is the port.
      const { host } = yield* World;
      const context = yield* host.context;
      assert.equal(Context.getOption(context, RateLimiter.RateLimiterStore)._tag, "None");
    },
  );

  // ---- the second official plugin: TwoFactor reaches the same port (REQ-EA-278/297) ----

  /** One TwoFactor rule as a scenario reads it: `endpoint`, `limit`, `window` (milliseconds). */
  const describeRule = (rule: RateLimits.RegisteredRule) =>
    `${rule.endpoint}|${rule.limit}|${Duration.toMillis(Duration.fromInputUnsafe(rule.window))}`;

  Given(
    "a plugin {string} that needs rate limiting for its {string} endpoint",
    function* (plugin: string, endpoint: string) {
      assert.deepEqual([plugin, endpoint], ["two-factor", "verify"]);
      yield* Effect.void;
    },
  );

  When("{string} is composed into an application", function* (_plugin: string) {
    // The application supplies only the port (the permissive limiter, no store): the composition
    // then holds what the plugin registered and whatever store it could have reached.
    const facts = yield* inTwoFactorApp(
      Effect.gen(function* () {
        const registry = yield* RateLimits.RateLimitsRegistry;
        const context = yield* Effect.context<never>();
        return {
          rules: (yield* registry.registered).filter((rule) => rule.plugin === "two_factor"),
          hasStore: Context.getOption(context, RateLimiter.RateLimiterStore)._tag === "Some",
        };
      }),
    );
    yield* setTexts("twoFactorRules", facts.rules.map(describeRule));
    yield* setTexts("twoFactorHasStore", [String(facts.hasStore)]);
  });

  Then(
    "{string} requires {string} as a port in its Layer's requirements",
    function* (_plugin: string, port: string) {
      assert.equal(port, "RateLimiter");
      yield* Effect.void;
      assertTypeGate("two-factor-requires-the-rate-limiter-port", "CompileTimeGates.ts", [
        "TwoFactorNeeds",
        "RateLimiter.RateLimiter",
      ]);
    },
  );

  Then("{string} does not bundle its own limiter implementation", function* (_plugin: string) {
    // The application gave it the permissive limiter and no store: there was nothing for the plugin to bundle onto.
    assert.deepEqual(yield* getTexts("twoFactorHasStore"), ["false"]);
    assert.ok((yield* getTexts("twoFactorRules")).length > 0, "the plugin registered no rule");
  });

  Given(
    "the official {string} plugin's {string} endpoint",
    function* (plugin: string, endpoint: string) {
      assert.deepEqual([plugin, endpoint], ["two-factor", "verify"]);
      yield* Effect.void;
    },
  );

  When(
    "{string} is installed with no application-authored rate-limit configuration",
    function* (_plugin: string) {
      const rules = yield* inTwoFactorApp(
        Effect.flatMap(RateLimits.RateLimitsRegistry, (registry) => registry.registered),
      );
      yield* setTexts(
        "twoFactorRules",
        rules.filter((rule) => rule.plugin === "two_factor").map(describeRule),
      );
    },
  );

  Then(
    "{string} is rate limited by rules the plugin itself ships: {int} attempts per {int} minutes per source address, and a per-user failure budget",
    function* (path: string, limit: number, minutes: number) {
      assert.equal(path, "/two-factor/verify");
      const rules = yield* getTexts("twoFactorRules");
      const verify = rules.filter((rule) => rule.startsWith("verify|"));
      assert.ok(
        verify.includes(`verify|${limit}|${minutes * 60_000}`),
        `no per-source verify rule: ${rules.join(" ")}`,
      );
      // ...and the per-user budget beside it: another verify rule, with its own (configured) limit.
      assert.ok(verify.length >= 2, `no failure budget: ${rules.join(" ")}`);
    },
  );

  Given(
    "a {string} configured with {string} {int} and {string} {string} for key {string}",
    function* (
      name: string,
      limitWord: string,
      limit: number,
      windowWord: string,
      window: string,
      key: string,
    ) {
      assert.deepEqual([name, limitWord, windowWord], ["RateLimiter", "limit", "window"]);
      const { port } = yield* World;
      yield* Ref.set(port, { limit, window: durationOf(window), key });
      yield* buildLimiter();
    },
  );

  Given(
    "a {string} configured with {string} {int} and {string} {string}",
    function* (name: string, limitWord: string, limit: number, windowWord: string, window: string) {
      assert.deepEqual([name, limitWord, windowWord], ["RateLimiter", "limit", "window"]);
      const { port } = yield* World;
      yield* Ref.set(port, { limit, window: durationOf(window), key: "bucket" });
      yield* buildLimiter();
    },
  );

  Given(
    "{string} has called {string} {int} times within the current window",
    function* (_key: string, call: string, times: number) {
      assert.equal(call, "consume");
      for (let i = 0; i < times; i++) assert.equal((yield* consume())._tag, "Ok");
    },
  );

  When(
    "{string} calls {string} a {int}th time within that same window",
    function* (_key: string, call: string, _nth: number) {
      assert.equal(call, "consume");
      yield* consume();
    },
  );

  Then("the {int}th call fails with {string}", function* (_nth: number, failure: string) {
    const all = yield* results;
    const last = all[all.length - 1];
    assert.ok(last !== undefined && last._tag === "Refused");
    assert.equal(last.error, failureNamed(failure));
  });

  When(
    "{string} consumes {int} times just before the window boundary and {int} more times just after it",
    function* (_key: string, before: number, after: number) {
      const config = yield* portConfig();
      const windowMillis = Duration.toMillis(config.window);
      // The window opens at the first call. Take it at t = 0, wait until one millisecond before
      // it closes for the rest of the first batch, then step past the boundary for the second.
      assert.equal((yield* consume())._tag, "Ok");
      yield* TestClock.adjust(Duration.millis(windowMillis - 1));
      for (let i = 1; i < before; i++) assert.equal((yield* consume())._tag, "Ok");
      yield* TestClock.adjust(Duration.millis(2));
      for (let i = 0; i < after; i++) yield* consume();
    },
  );

  Then("all {int} calls succeed", function* (total: number) {
    const all = yield* results;
    assert.equal(all.length, total);
    assert.ok(all.every((result) => result._tag === "Ok"));
  });

  Then("this is the documented, accepted cost of the fixed-window default", function* () {
    // Twice the limit got through, and no more: the very next call in the new window is refused.
    const config = yield* portConfig();
    assert.equal((yield* results).length, config.limit * 2);
    const next = yield* consume();
    assert.equal(next._tag, "Refused");
  });

  Given(
    "a {string} backed by a store with an atomic compare-and-increment primitive",
    function* (name: string) {
      assert.equal(name, "RateLimiter");
      const { port } = yield* World;
      yield* Ref.set(port, { limit: 3, window: durationOf("10 seconds"), key: "alice" });
      // The shipped memory store advances a bucket in one `Ref.modify`.
      yield* buildLimiter(RateLimiter.layerStoreMemory);
    },
  );

  When(
    "two concurrent {string} calls for the same key race at exactly the limit boundary",
    function* (call: string) {
      assert.equal(call, "consume");
      const { limiter } = yield* World;
      const config = yield* portConfig();
      const built = yield* Ref.get(limiter);
      assert.ok(built !== undefined);
      // limit - 1 calls in, so the next one is the last that may succeed.
      for (let i = 0; i < config.limit - 1; i++) assert.equal((yield* consume())._tag, "Ok");
      const raced = yield* Effect.all([consumeOn(built, config), consumeOn(built, config)], {
        concurrency: "unbounded",
      });
      yield* setCount("raceSucceeded", raced.filter((r) => r._tag === "Ok").length);
      yield* setCount("raceRefused", raced.filter((r) => r._tag === "Refused").length);
    },
  );

  Then("at most {string} calls succeed", function* (word: string) {
    assert.equal(word, "limit");
    const config = yield* portConfig();
    // limit - 1 before the race plus whatever of the race got through.
    assert.equal(config.limit - 1 + (yield* getCount("raceSucceeded")), config.limit);
  });

  Then(
    "the store's atomicity prevents both calls from observing a pre-increment count under the limit",
    function* () {
      assert.equal(yield* getCount("raceSucceeded"), 1);
      assert.equal(yield* getCount("raceRefused"), 1);
    },
  );

  Given(
    "a candidate {string} implementation whose {string} reads the current count, decides {string} in application code, and only then writes the incremented count back",
    function* (name: string, call: string, decision: string) {
      assert.deepEqual([name, call, decision], ["RateLimiter", "consume", "not yet at the limit"]);
      const { port } = yield* World;
      yield* Ref.set(port, { limit: 3, window: durationOf("10 seconds"), key: "alice" });
      const naive = naiveLimiter(3);
      yield* naive.primeTo(2);
      const { limiter } = yield* World;
      yield* Ref.set(limiter, naive.limiter);
      // The shipped limiter, primed to the same count, is the control.
      yield* buildLimiter();
    },
  );

  When("two concurrent {string} calls for the same key race", function* (call: string) {
    assert.equal(call, "consume");
    const { limiter } = yield* World;
    const config = yield* portConfig();
    const candidate = yield* Ref.get(limiter);
    assert.ok(candidate !== undefined);
    const raced = yield* Effect.all([consumeOn(candidate, config), consumeOn(candidate, config)], {
      concurrency: "unbounded",
    });
    yield* setCount("candidateAdmitted", raced.filter((r) => r._tag === "Ok").length);
  });

  Then(
    "both calls can observe a pre-increment count under {string} and both proceed",
    function* (word: string) {
      assert.equal(word, "limit");
      // One slot was left (2 of 3 used) and the candidate let two callers into it.
      assert.equal(yield* getCount("candidateAdmitted"), 2);
    },
  );

  Then(
    "this implementation does not honor {string}'s contract, so it is not a legal implementation of the {string} port",
    function* (call: string, port: string) {
      assert.deepEqual([call, port], ["consume", "RateLimiter"]);
      // The same race, the same one free slot, against the shipped limiter: exactly one caller gets it.
      const config = yield* portConfig();
      const shipped = yield* buildLimiter();
      for (let i = 0; i < config.limit - 1; i++)
        assert.equal((yield* consumeOn(shipped, config))._tag, "Ok");
      const raced = yield* Effect.all([consumeOn(shipped, config), consumeOn(shipped, config)], {
        concurrency: "unbounded",
      });
      assert.equal(raced.filter((r) => r._tag === "Ok").length, 1);
      assert.ok((yield* getCount("candidateAdmitted")) > 1, "the candidate honored the limit");
    },
  );

  Given("{string}'s backing store is unreachable", function* (name: string) {
    assert.equal(name, "RateLimiter");
    const { store, policy } = yield* World;
    yield* Ref.set(store, unreachableStore);
    yield* Ref.set(policy, {});
  });

  Given(
    "an application that provides a {string} Layer configured with {string}",
    function* (name: string, option: string) {
      assert.equal(name, "RateLimiter");
      // The shipped option is `onStoreUnavailable` (RBS-004); the scenario's `onUnavailable` is
      // the password plugin's breach-check option's name, which the spec text carried over.
      assert.equal(option, 'onStoreUnavailable: "reject"');
      const { policy } = yield* World;
      yield* Ref.set(policy, { onStoreUnavailable: "reject" });
    },
  );

  Given("its backing store is unreachable", function* () {
    const { store } = yield* World;
    yield* Ref.set(store, unreachableStore);
  });

  When("{string} is called", function* (call: string) {
    assert.equal(call, "consume");
    const { host, store, policy, port } = yield* World;
    const unreachable = yield* Ref.get(store);
    assert.ok(unreachable !== undefined, "the scenario never said the store is unreachable");
    const chosen = (yield* Ref.get(policy)) ?? {};
    yield* Ref.set(port, { limit: 3, window: durationOf("10 seconds"), key: "alice" });
    // The port on its own, and the same limiter behind the password plugin's HTTP surface.
    yield* buildLimiter(unreachable, chosen);
    yield* consume();
    yield* host.configure((spec) => ({
      ...spec,
      rateLimiter: RateLimiter.layer.pipe(
        Layer.provide(unreachable),
        Layer.provide(RateLimiter.config(chosen)),
      ),
    }));
    yield* signUpOverHttp("alice");
    yield* signInOverHttp("alice");
  });

  Then("{string} succeeds and the request proceeds unthrottled", function* (call: string) {
    assert.equal(call, "consume");
    const all = yield* results;
    assert.deepEqual(all, [{ _tag: "Ok" }]);
    const { statuses } = yield* World;
    // The requests behind the same limiter went through: a sign-up (200) and a sign-in for the
    // account it made.
    assert.deepEqual(yield* Ref.get(statuses), [200, 200]);
  });

  Then(
    "no request fails with an unrelated 5xx server error merely because the rate-limit store is unavailable",
    function* () {
      const { statuses, host } = yield* World;
      assert.ok((yield* Ref.get(statuses)).every((status) => status < 500));
      // Not silently: the outage was logged (never its key).
      const logged = (yield* host.logs).some((record) =>
        record.text.includes("rate-limit store unavailable"),
      );
      assert.ok(logged, "the outage was not logged");
    },
  );

  Then(
    "{string} fails with {string} or a distinct outage error",
    function* (call: string, failure: string) {
      assert.equal(call, "consume");
      const all = yield* results;
      const only = all[0];
      assert.ok(only !== undefined && only._tag === "Refused");
      assert.equal(only.error, failureNamed(failure));
      assert.equal(only.retryAfterMillis, 1000);
    },
  );

  Then("the request does not proceed", function* () {
    const { statuses, bodies } = yield* World;
    assert.deepEqual(yield* Ref.get(statuses), [429, 429]);
    assert.equal(tagOf((yield* Ref.get(bodies))[0]), "RateLimited");
  });

  // ---- BEH-EA-106: the RateLimited error ----

  Given("the limit has already been reached within the current window", function* () {
    const config = yield* portConfig();
    for (let i = 0; i < config.limit; i++) assert.equal((yield* consume())._tag, "Ok");
  });

  When("a further {string} call is made within that window", function* (call: string) {
    assert.equal(call, "consume");
    yield* consume();
  });

  Then("the call fails with {string}", function* (failure: string) {
    const all = yield* results;
    const last = all[all.length - 1];
    assert.ok(last !== undefined && last._tag === "Refused");
    assert.equal(last.error, failureNamed(failure));
  });

  Then("the failure carries a {string} field", function* (field: string) {
    assert.equal(field, "retryAfterMillis");
    const config = yield* portConfig();
    const last = (yield* results).at(-1);
    assert.ok(last !== undefined && last._tag === "Refused");
    assert.ok(
      last.retryAfterMillis > 0 && last.retryAfterMillis <= Duration.toMillis(config.window),
    );
  });

  Given("the same exceeded limit", function* () {
    const { port } = yield* World;
    yield* Ref.set(port, { limit: 3, window: durationOf("10 seconds"), key: "bucket" });
    yield* buildLimiter();
    for (let i = 0; i < 3; i++) yield* consume();
  });

  When("the call fails", function* () {
    yield* consume();
  });

  Then("the failure is not a generic or untyped error", function* () {
    const last = (yield* results).at(-1);
    assert.ok(last !== undefined && last._tag === "Refused");
    assert.equal(last.error, "RateLimitExceeded");
    // A typed value of the port's own class, not something to string-match.
    const { limiter } = yield* World;
    const built = yield* Ref.get(limiter);
    assert.ok(built !== undefined);
    const exit = yield* Effect.flip(
      built.consume({ key: "bucket", limit: 3, window: "10 seconds" }),
    );
    assert.ok(exit instanceof RateLimiter.RateLimitExceeded);
  });

  Then(
    "a client can render a {string} message from {string} alone, without parsing any message string",
    function* (message: string, field: string) {
      assert.equal(message, "try again in n seconds");
      assert.equal(field, "retryAfterMillis");
      const last = (yield* results).at(-1);
      assert.ok(last !== undefined && last._tag === "Refused");
      const seconds = Math.ceil(last.retryAfterMillis / 1000);
      assert.ok(
        seconds >= 1 && seconds <= 10,
        `${seconds} is not a sensible wait for a 10 second window`,
      );
      assert.equal(`try again in ${seconds} seconds`, "try again in 10 seconds");
    },
  );

  // Wire-level (added scenario): the 429 a client actually receives.
  Given(
    "the password plugin's sign-in rule enforced by a real limiter over the memory store",
    function* () {
      const { host } = yield* World;
      yield* host.configure((spec) => ({ ...spec, rateLimiter: RateLimiter.layerMemory }));
      yield* signUpOverHttp("alice");
    },
  );

  When(
    "{string} attempts to sign in with a wrong password more often than the rule allows",
    function* (name: string) {
      for (let i = 0; i < 6; i++) yield* signInOverHttp(name, "not the right password");
    },
  );

  Then(
    "the refused request is a 429 whose body is a RateLimited value carrying retryAfterMillis",
    function* () {
      const { statuses, bodies } = yield* World;
      const seen = yield* Ref.get(statuses);
      // sign-up 200, five 401s (wrong password), then the sixth attempt is refused.
      assert.deepEqual(seen, [200, 401, 401, 401, 401, 401, 429]);
      const body = (yield* Ref.get(bodies)).at(-1);
      assert.equal(tagOf(body), "RateLimited");
      const retryAfter = retryAfterOf(body);
      assert.ok(retryAfter !== undefined && retryAfter > 0);
      // 15 minutes is the rule's window; the wait a client renders comes from that one number.
      assert.ok(retryAfter <= 15 * 60 * 1000);
    },
  );

  // ---- BEH-EA-107: a plugin may only rate-limit its own endpoints ----

  Given(
    "plugin {string} contributes a rate-limit rule naming group {string}",
    function* (plugin: string, group: string) {
      assert.equal(plugin, "invite");
      const { compose, composition } = yield* World;
      yield* Ref.set(
        compose,
        Effect.flatMap(composeInvite(group), (result) => Ref.set(composition, result)),
      );
    },
  );

  When("the application is composed", function* () {
    const { compose } = yield* World;
    const arranged = yield* Ref.get(compose);
    assert.ok(arranged !== undefined, "no Given arranged a composition");
    yield* arranged;
  });

  Then("the rule composes successfully", function* () {
    const { composition } = yield* World;
    const result = yield* Ref.get(composition);
    assert.ok(result !== undefined && result._tag === "Composed");
    assert.deepEqual(result.rules, [{ plugin: "invite", group: "invite" }]);
  });

  Then("composition is rejected", function* () {
    const { composition } = yield* World;
    const result = yield* Ref.get(composition);
    assert.equal(result?._tag, "Rejected");
  });

  Then(
    "the rejection names {string} as the contributing plugin and {string} as the group it does not own",
    function* (plugin: string, group: string) {
      const { composition } = yield* World;
      const result = yield* Ref.get(composition);
      assert.ok(result !== undefined && result._tag === "Rejected");
      assert.equal(result.plugin, plugin);
      assert.equal(result.group, group);
    },
  );

  // ---- BEH-EA-108: key strategies ----

  // PV-240/REQ-EA-290: a built-in strategy resolves against the request's own context.
  Given("a rule with key strategy {string}", function* (strategy: string) {
    assert.ok(strategy === "principal" || strategy === "ip", `unknown strategy ${strategy}`);
    yield* setTexts("strategy", [strategy]);
  });

  Given("a signed-in user {string}", function* (name: string) {
    yield* setTexts("caller", [name]);
  });

  When(
    "{string} derives a bucket key for a request from {string}",
    function* (call: string, name: string) {
      assert.equal(call, "consume");
      const [strategy] = yield* getTexts("strategy");
      const ORIGIN = "203.0.113.7";
      const derive = (user: string) => {
        const ruleFor = { group: "invite", endpoint: "create" };
        const request = HttpServerRequest.fromWeb(new Request("http://localhost/invite/create"));
        const principal = Layer.succeed(
          Api.CurrentPrincipal,
          new Api.UserPrincipal({
            ref: new Api.PrincipalRef({ type: "user", id: user }),
            sessionId: `session-${user}`,
          }),
        );
        const address = Layer.succeed(ClientAddress.ClientAddress, {
          resolve: () => Effect.succeed(Option.some(ORIGIN)),
        });
        return strategy === "principal"
          ? RateLimits.bucketKey({ ...ruleFor, key: "principal" }).pipe(Effect.provide(principal))
          : RateLimits.bucketKey({ ...ruleFor, key: "ip" }).pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
              Effect.provide(address),
            );
      };
      yield* setTexts("derived", [yield* derive(name), yield* derive("someone-else")]);
    },
  );

  Then("the bucket key is derived from {string}'s CurrentPrincipal", function* (name: string) {
    const [own, other] = yield* getTexts("derived");
    assert.ok(own !== undefined && own.includes(`user:${name}`), `${own} names ${name}`);
    assert.notEqual(own, other, "another principal must get another bucket");
  });

  Then("the bucket key is derived from the request's network origin", function* () {
    const [own, other] = yield* getTexts("derived");
    assert.ok(own !== undefined && own.includes("203.0.113.7"), `${own} names the address`);
    assert.ok(!own.includes("alice"), "the caller's identity is not part of an ip bucket");
    assert.equal(own, other, "the same origin is one bucket whoever asks");
  });

  Given(
    "a rule with a custom key function deriving {string} from the sign-in payload",
    function* (template: string) {
      assert.equal(template, "signin:${email}");
      const { texts } = yield* World;
      yield* Ref.update(texts, (existing) => ({ ...existing, keyTemplate: [template] }));
    },
  );

  When("{string} derives a bucket key for a sign-in request", function* (call: string) {
    assert.equal(call, "consume");
    const registry = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(RateLimits.layer);
        return yield* Effect.gen(function* () {
          const registry = yield* RateLimits.RateLimitsRegistry;
          // The custom function reads the sign-in payload's email (narrowed, never cast).
          yield* registry
            .register(fakeOwner("invite"), {
              group: "invite",
              endpoint: "signIn",
              key: (input) =>
                typeof input === "object" &&
                input !== null &&
                typeof Reflect.get(input, "email") === "string"
                  ? `signin:${String(Reflect.get(input, "email"))}`
                  : "signin:unknown",
              limit: 5,
              window: Duration.minutes(15),
            })
            .pipe(Effect.orDie);
          const [rule] = yield* registry.registered;
          assert.ok(rule !== undefined && typeof rule.key === "function");
          return [
            rule.key({ email: "alice@example.com", password: "irrelevant" }),
            rule.key({ email: "alice@example.com", password: "irrelevant" }),
            rule.key({ email: "bob@example.com", password: "irrelevant" }),
          ];
        }).pipe(Effect.provide(context));
      }),
    );
    yield* setTexts("derived", registry);
  });

  Then(
    "the bucket key is the deterministic value that function computes for that request",
    function* () {
      const [first, second, other] = yield* getTexts("derived");
      assert.equal(first, "signin:alice@example.com");
      assert.equal(second, first);
      assert.equal(other, "signin:bob@example.com");
    },
  );

  Given("a rule keyed by {string}", function* (strategy: string) {
    assert.equal(strategy, "ip");
    const { host } = yield* World;
    yield* host.configure((spec) => ({ ...spec, rateLimiter: RateLimiter.layerMemory }));
    // The password plugin's per-source sign-up rule, as the registry reports it.
    const rules = yield* registeredRules;
    const byIp = rules.find(
      (rule) =>
        rule.endpoint === "signUp" &&
        typeof rule.key === "function" &&
        rule.key({ ip: "203.0.113.7" }) === "password:signup:ip:203.0.113.7",
    );
    assert.ok(byIp !== undefined, "no per-source sign-up rule is registered");
  });

  When(
    "many distinct users behind the same network address exceed the limit together",
    function* () {
      // Twenty-five different people, one address (the direct-connection default resolves no
      // client address, so they share the "unknown" source bucket): 20 an hour are let in.
      for (let i = 0; i < 25; i++) yield* signUpOverHttp(`user-${i}`);
    },
  );

  Then("all of them share the same bucket and are throttled together", function* () {
    const { statuses } = yield* World;
    const seen = yield* Ref.get(statuses);
    assert.equal(seen.filter((status) => status === 200).length, 20);
    assert.ok(
      seen.slice(20).every((status) => status === 429),
      "later users were not throttled with the first twenty",
    );
  });

  Given(
    "a custom key function that keys on an unvalidated email field from the request payload",
    function* () {
      const { host } = yield* World;
      yield* host.configure((spec) => ({ ...spec, rateLimiter: RateLimiter.layerMemory }));
      // Password's per-account sign-in rule is exactly that: its key is a function of the email in the payload.
      const rules = yield* registeredRules;
      const perAccount = rules.find(
        (rule) =>
          rule.endpoint === "signIn" &&
          typeof rule.key === "function" &&
          rule.key({ email: "anyone@example.com" }) === "password:signin:anyone@example.com",
      );
      assert.ok(perAccount !== undefined);
    },
  );

  When("an attacker varies the email value on each request", function* () {
    // Eight guesses, each naming a different (made-up) account.
    for (let i = 0; i < 8; i++) yield* signInOverHttp(`victim-${i}`, "guess");
  });

  Then(
    "the attacker obtains a fresh bucket for every request, defeating the limit's purpose",
    function* () {
      const { statuses } = yield* World;
      const varied = yield* Ref.get(statuses);
      // Eight attempts against a limit of five per account, and not one was throttled...
      assert.equal(varied.length, 8);
      assert.ok(varied.every((status) => status === 401));
      // ...where the same eight attempts at ONE account are cut off after five.
      yield* Ref.set(statuses, []);
      for (let i = 0; i < 8; i++) yield* signInOverHttp("one-victim", "guess");
      const fixed = yield* Ref.get(statuses);
      assert.deepEqual(fixed, [401, 401, 401, 401, 401, 429, 429, 429]);
    },
  );

  // ---- BEH-EA-109: swappable stores ----

  Given("{string} is first provided with {string}", function* (layerName: string, store: string) {
    assert.deepEqual([layerName, store], ["RateLimiter.layer", "RateLimiter.layerStoreMemory"]);
    const { port } = yield* World;
    yield* Ref.set(port, { limit: 2, window: durationOf("10 seconds"), key: "alice" });
  });

  Given("a second {string} then supplies {string}", function* (how: string, store: string) {
    assert.equal(how, "Layer.provide");
    // `layerStoreRedisConfig` is bring-your-own (the spec's line is illustrative; nothing in
    // @awthaq ships it), so a store double that counts what it is asked stands in for it.
    assert.equal(store, "RateLimiter.layerStoreRedisConfig(...)");
    const world = yield* World;
    yield* Ref.set(world.compose, composeTwoLimiters(world));
  });

  Then("the Redis-backed implementation is the one in effect", function* () {
    const { alternativeIncrements } = yield* World;
    yield* consume();
    yield* consume();
    assert.equal(yield* readerOf(alternativeIncrements, "alternative store"), 2);
  });

  Then("the memory-backed implementation is entirely shadowed, not merged", function* () {
    const { memorySize } = yield* World;
    // Nothing reached the memory store, which the first layer still built.
    assert.equal(yield* readerOf(memorySize, "memory store"), 0);
  });

  Given("two Layers are provided for the {string} port", function* (port: string) {
    assert.equal(port, "RateLimiter");
    const world = yield* World;
    yield* Ref.set(world.port, { limit: 2, window: durationOf("10 seconds"), key: "alice" });
    yield* Ref.set(world.compose, composeTwoLimiters(world));
  });

  Then(
    "only one implementation of {string} exists in the composed graph",
    function* (port: string) {
      assert.equal(port, "RateLimiter");
      // One service under the port's key, and it behaves as the later store alone: its limit
      // decisions come from the alternative store's counter.
      const outcomes = [];
      for (let i = 0; i < 3; i++) outcomes.push((yield* consume())._tag);
      assert.deepEqual(outcomes, ["Ok", "Ok", "Refused"]);
      const { alternativeIncrements } = yield* World;
      assert.equal(yield* readerOf(alternativeIncrements, "alternative store"), 3);
    },
  );

  Then(
    "no attempt is made to combine both stores' behavior into a single implementation",
    function* () {
      const { memorySize } = yield* World;
      // The memory store saw none of those three calls: nothing was split, mirrored or summed.
      assert.equal(yield* readerOf(memorySize, "memory store"), 0);
    },
  );

  // ---- BEH-EA-110: built-in rules shipped by core plugins ----

  Given(
    "an application installing the official {string} plugin with no rate-limit rules of its own",
    function* (plugin: string) {
      assert.equal(plugin, "password");
      const { host, compose } = yield* World;
      // The only thing the application supplies is the port (a real limiter); no rule.
      yield* host.configure((spec) => ({ ...spec, rateLimiter: RateLimiter.layerMemory }));
      yield* Ref.set(compose, Effect.asVoid(host.context));
    },
  );

  Then(
    "its sign-in and password-reset-request endpoints are already rate limited by rules those plugins ship",
    function* () {
      const rules = yield* registeredRules;
      assert.ok(rules.some((rule) => rule.plugin === "password" && rule.endpoint === "signIn"));
      assert.ok(
        rules.some((rule) => rule.plugin === "password" && rule.endpoint === "requestReset"),
      );
      // Registered is not enough: they are enforced. Sixth sign-in and sixth reset request for
      // one address are refused (five per fifteen minutes each).
      yield* signUpOverHttp("alice");
      const { statuses } = yield* World;
      yield* Ref.set(statuses, []);
      for (let i = 0; i < 6; i++) yield* signInOverHttp("alice", "guess");
      for (let i = 0; i < 6; i++) yield* requestResetOverHttp("alice");
      const seen = yield* Ref.get(statuses);
      assert.equal(seen[5], 429, "the sixth sign-in was not refused");
      assert.equal(seen[11], 429, "the sixth reset request was not refused");
      assert.ok(seen.slice(0, 5).every((status) => status === 401));
      assert.ok(seen.slice(6, 11).every((status) => status === 202));
    },
  );

  Then(
    "the application required no additional rate-limiting code to get that protection",
    function* () {
      // The composition held nothing but the limiter port and the plugin: every rule in the
      // registry belongs to the plugin, none to the application.
      const rules = yield* registeredRules;
      assert.ok(rules.length > 0);
      assert.ok(rules.every((rule) => rule.plugin === "password"));
    },
  );

  // ---- BEH-EA-111: registry ordering ----

  Given(
    "rate-limit rules contributed by plugins with a dependency relationship, some declaring an explicit {string}, and rule ids as the final tiebreaker",
    function* (word: string) {
      assert.equal(word, "order");
      const { compose, texts } = yield* World;
      yield* Ref.set(
        compose,
        Effect.gen(function* () {
          // Registered in scrambled order: the dependent first, declaring the lowest order of all.
          const listed = yield* resolvedRules([
            { owner: AcmeGate, order: -50 },
            { owner: fakeOwner("acme.zed") },
            { owner: AcmeNormalize, order: 5 },
            { owner: fakeOwner("acme.abe") },
            { owner: AcmeAudit },
          ]);
          yield* Ref.update(texts, (existing) => ({ ...existing, listing: listed }));
        }),
      );
    },
  );

  When("the rate-limit registry is read for its resolved rule list", function* () {
    const { compose } = yield* World;
    const arranged = yield* Ref.get(compose);
    assert.ok(arranged !== undefined);
    yield* arranged;
  });

  Then(
    "the listing is ordered by plugin dependency order first, then by declared {string}, then by rule id",
    function* (word: string) {
      assert.equal(word, "order");
      // Dependency level 0 first (declared order, then id: abe/audit/zed tie at 0, normalize
      // declared 5), the dependent — whatever it declared — after everything it depends on.
      assert.deepEqual(yield* getTexts("listing"), [
        "acme.abe",
        "acme.audit",
        "acme.zed",
        "acme.normalize",
        "acme.gate",
      ]);
    },
  );

  Given(
    "the resolved order of hook taps and the resolved order of rate-limit rules for the same plugin tuple",
    function* () {
      const { compose, texts } = yield* World;
      yield* Ref.set(
        compose,
        Effect.gen(function* () {
          const hooks = yield* resolvedBeforeSignUp;
          // The same three plugins, contributing rules at the same declared orders as their taps.
          const rules = yield* resolvedRules([
            { owner: AcmeGate },
            { owner: AcmeAudit },
            { owner: AcmeNormalize, order: PRE },
          ]);
          yield* Ref.update(texts, (existing) => ({
            ...existing,
            hookOrder: hooks.map((tap) => tap.owner),
            ruleOrder: rules,
          }));
        }),
      );
    },
  );

  When("both are computed", function* () {
    const { compose } = yield* World;
    const arranged = yield* Ref.get(compose);
    assert.ok(arranged !== undefined);
    yield* arranged;
  });

  Then(
    "both follow the identical three-key ordering: dependency order, then declared {string}, then id",
    function* (word: string) {
      assert.equal(word, "order");
      const hooks = yield* getTexts("hookOrder");
      const rules = yield* getTexts("ruleOrder");
      assert.deepEqual(hooks, ["acme.normalize", "acme.audit", "acme.gate"]);
      assert.deepEqual(rules, hooks);
      // One comparator behind both: a tie on level and order falls to the plugin id.
      assert.ok(
        HookPoint.compareTaps(
          { owner: fakeOwner("acme.a"), order: 0 },
          { owner: fakeOwner("acme.b"), order: 0 },
        ) < 0,
      );
    },
  );

  // ---- BEH-EA-112: testing with a permissive limiter ----

  Given("{string} is used to compose a test application", function* (call: string) {
    assert.equal(call, "TestAuth.layer(plugins)");
    // No limiter is supplied: the bundle's own is what runs.
    const { host } = yield* World;
    yield* Effect.asVoid(host.context);
  });

  When("a test signs in {int} times in a loop", function* (times: number) {
    yield* loopSignIns(times);
  });

  Then(
    "none of the {int} attempts is rejected by {string}",
    function* (times: number, failure: string) {
      assert.equal(failure, "RateLimited");
      assert.equal(yield* getCount("attempts"), times);
      assert.equal(yield* getCount("rejected"), 0);
    },
  );

  Given("a test using {string} with no rate-limiting-specific setup", function* (call: string) {
    assert.equal(call, "TestAuth.layer(plugins)");
    const { host } = yield* World;
    yield* Effect.asVoid(host.context);
  });

  When("the test exercises a loop of repeated sign-in attempts", function* () {
    yield* loopSignIns(30);
  });

  Then(
    "it requires no additional reconfiguration or mocking of {string} to do so",
    function* (port: string) {
      assert.equal(port, "RateLimiter");
      const { host } = yield* World;
      // Nothing was overridden, and the limiter in play is the bundle's own permissive one...
      const limiter = yield* host.run(RateLimiter.RateLimiter);
      assert.equal(limiter.permissive, true);
      // ...under which thirty attempts (six times any built-in rule's limit) all went through.
      assert.equal(yield* getCount("rejected"), 0);
      assert.equal(yield* getCount("attempts"), 30);
    },
  );

  Given("a test that wants to verify rate-limiting behavior itself", function* () {
    // Nothing yet: what it wants is what the When provides.
  });

  When(
    "that test provides its own {string} Layer configured with a strict limit, overriding {string}'s permissive default",
    function* (port: string, harness: string) {
      assert.deepEqual([port, harness], ["RateLimiter", "TestAuth.layer"]);
      const { host } = yield* World;
      yield* host.configure((spec) => ({ ...spec, rateLimiter: strictLimiter(2) }));
    },
  );

  Then("that test's stricter limit is the one in effect for its scenario", function* () {
    const { host } = yield* World;
    yield* host.run(
      Effect.flatMap(Password.Password, (password) =>
        password.signUp({
          email: "alice@example.com",
          password: Redacted.make("correct horse battery staple"),
        }),
      ).pipe(Effect.orDie),
    );
    // The password plugin's own rule says five per fifteen minutes; the test's limiter says two.
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(yield* host.run(signInAttempt("alice@example.com")));
    assert.deepEqual(outcomes, ["ok", "ok", "rate-limited", "rate-limited"]);
    // Refused at two, not the rule's five: the plugin is running on the test's limiter, not the
    // bundle's permissive one (which would not have refused at all).
  });
});

const loopSignIns = (times: number) =>
  Effect.gen(function* () {
    const { host } = yield* World;
    yield* host.run(
      Effect.flatMap(Password.Password, (password) =>
        password.signUp({
          email: "alice@example.com",
          password: Redacted.make("correct horse battery staple"),
        }),
      ).pipe(Effect.orDie),
    );
    let rejected = 0;
    for (let i = 0; i < times; i++) {
      if ((yield* host.run(signInAttempt("alice@example.com"))) === "rate-limited") rejected++;
    }
    yield* setCount("attempts", times);
    yield* setCount("rejected", rejected);
  });

/**
 * BEH-EA-109: two limiter layers for the one port, merged: the later wins where they meet, and
 * nothing is combined. The first sits over the shipped memory store (whose size it exposes),
 * the second over a store double standing in for the bring-your-own Redis one.
 */
const composeTwoLimiters = (world: WorldShape) =>
  Effect.gen(function* () {
    const { host, limiter, memorySize, alternativeIncrements } = world;
    const alternative = makeAlternativeStore();
    const first = RateLimiter.layer.pipe(Layer.provideMerge(RateLimiter.layerStoreMemory));
    // `Layer.fresh`: `RateLimiter.layer` is one layer *value*, and a build memoizes by value — without
    // it the second composition would reuse the service the first already built (over the memory
    // store) instead of building its own over the alternative store.
    const second = Layer.fresh(RateLimiter.layer).pipe(Layer.provide(alternative.layer));
    const context = yield* Layer.buildWithScope(Layer.merge(first, second), host.scope);
    yield* Ref.set(limiter, Context.get(context, RateLimiter.RateLimiter));
    yield* Ref.set(memorySize, Context.get(context, RateLimiter.RateLimiterMemoryStats).size);
    yield* Ref.set(alternativeIncrements, alternative.increments);
  });
