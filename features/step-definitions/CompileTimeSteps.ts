// The steps of the compile-time scenarios that used to be `@skip`ped. Each Given/When only names
// the arrangement — the arrangement IS the source of the matching `// type-gate:` block in
// `CompileTimeGates.ts`, compiled by the typecheck gate — and each Then asserts, through
// `assertTypeGate`, that the block still carries its enforcing construct (see that file's header).
// A few also assert what can be observed at runtime beside the compile-time claim.
import { OAuthProvider } from "@awthaq/oauth";
import { Password } from "@awthaq/password";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { customKey, tightenedPolicy } from "./CompileTimeGates.ts";
import { assertTypeGate } from "./FoundationsWorld.ts";

const GATES = "CompileTimeGates.ts";

/** A step body that only exists to assert a gate: nothing to await. */
const gate = (name: string, mustContain: ReadonlyArray<string>) =>
  function* () {
    yield* Effect.void;
    assertTypeGate(name, GATES, mustContain);
  };

/** BEH-EA-089/094 (12-hooks.feature). */
export const hookTypeSteps = defineSteps(({ Given, When, Then }) => {
  Given(
    "a {string} definition that omits a {string}",
    function* (_service: string, _field: string) {
      yield* Effect.void;
    },
  );

  Given(
    "a {string} definition that declares a {string} but omits an {string} schema",
    function* (_service: string, _kind: string, _input: string) {
      yield* Effect.void;
    },
  );

  When("the hook point class is defined", function* () {
    yield* Effect.void;
  });

  Then("the definition fails to compile, naming {string} as required", function* (field: string) {
    yield* Effect.void;
    if (field === "kind") {
      assertTypeGate("hook-kind-is-the-factory", GATES, ["@ts-expect-error", "HookPoint.Service"]);
    } else {
      assert.equal(field, "input");
      assertTypeGate("hook-input-is-required", GATES, ["@ts-expect-error", "HookPoint.veto"]);
    }
  });

  Given(
    "a plugin tuple where no installed plugin's Layer provides {string} in its {string}",
    function* (_point: string, _output: string) {
      yield* Effect.void;
    },
  );

  Given("a tap is registered on {string}", function* (_point: string) {
    yield* Effect.void;
  });

  When("the tuple is composed", function* () {
    yield* Effect.void;
  });

  Then(
    "{string} remains in the composed Layer's {string}",
    function* (_point: string, _requirements: string) {
      yield* Effect.void;
      // The launch without the point does not type-check; providing the point's own layer does.
      assertTypeGate("tap-needs-its-point", GATES, ["@ts-expect-error", "Layer.launch"]);
      assertTypeGate("tap-satisfied-by-its-point", GATES, ["Layer.provide(Complete.layer)"]);
    },
  );

  Then(
    "composition fails to compile, identical in kind to a missing port",
    gate("tap-needs-its-point", ["@ts-expect-error", "nothing provides it"]),
  );

  Given(
    "a tap registered on a hook point that {string} used to define",
    function* (_plugin: string) {
      yield* Effect.void;
    },
  );

  When("{string} is removed from the installed plugin tuple", function* (_plugin: string) {
    yield* Effect.void;
  });

  Then(
    "the tap's Layer fails to compile",
    gate("tap-needs-its-point", ["@ts-expect-error", "Effect.runPromise"]),
  );

  Then("the tap does not silently become a no-op that fires zero times", function* () {
    yield* Effect.void;
    // What stays is a compile error (above), never a Layer that builds and registers nowhere.
    assertTypeGate("tap-needs-its-point", GATES, ["@ts-expect-error"]);
  });
});

/** BEH-EA-115/120 (15-password.feature). */
export const passwordTypeSteps = defineSteps(({ Given, When, Then }) => {
  Given(
    "an application composing {string} with no {string} Layer provided",
    function* (_plugin: string, _port: string) {
      yield* Effect.void;
    },
  );

  When("the application's Layer is composed", function* () {
    yield* Effect.void;
  });

  Then(
    "the composition remains incomplete, since {string} contributes no default {string} to satisfy its own requirement",
    function* (_plugin: string, _port: string) {
      yield* Effect.void;
      assertTypeGate("password-requires-a-hasher", GATES, [
        "PasswordHasher.PasswordHasher extends",
        "= true",
      ]);
    },
  );

  Given(
    "{string} is provided in place of the default {string}",
    function* (_config: string, _default: string) {
      yield* Effect.void;
    },
  );

  When("{string}'s contract, table set, and migrations are inspected", function* (_plugin: string) {
    yield* Effect.void;
  });

  // Runtime half: building the policy layer leaves the class's own statics as they were.
  const unchanged = (what: "contract" | "tables" | "migrations") =>
    Effect.gen(function* () {
      const before = {
        contract: Password.Password.contract,
        tables: Password.Password.tables,
        migrations: Password.Password.migrations,
      };
      yield* Effect.scoped(Layer.build(tightenedPolicy));
      assert.equal(Password.Password[what], before[what]);
      assertTypeGate("password-config-is-policy-only", GATES, [
        "Password.config({ minLength: 16 })",
        "@ts-expect-error",
      ]);
    });

  Then("its contract is unchanged", () => unchanged("contract"));
  Then("its table set is unchanged", () => unchanged("tables"));
  Then("its migrations are unchanged", () => unchanged("migrations"));
});

/** BEH-EA-271 (33-email-otp.feature). */
export const numericValueTypeSteps = defineSteps(({ When, Then }) => {
  When("a caller tries to supply its own numeric value", function* () {
    yield* Effect.void;
  });

  Then(
    "the input is rejected by the type",
    gate("numeric-value-is-never-caller-chosen", ["@ts-expect-error", 'value: "123456"']),
  );
});

/** BEH-EA-108 (14-rate-limiting.feature). */
export const rateLimitKeyTypeSteps = defineSteps(({ Given, When, Then }) => {
  Given(
    "a plugin author declaring a rule using only the built-in {string} or {string} strategies",
    function* (_principal: string, _ip: string) {
      yield* Effect.void;
    },
  );

  When("that rule derives a bucket key", function* () {
    yield* Effect.void;
  });

  Then(
    "neither built-in strategy allows keying on an arbitrary caller-supplied string such as an unvalidated header",
    function* () {
      yield* Effect.void;
      assertTypeGate("rate-limit-key-is-a-strategy-or-a-function", GATES, [
        "@ts-expect-error",
        '"x-forwarded-for"',
      ]);
      // The one strategy that reads request data is an explicit function.
      assert.equal(typeof customKey, "function");
    },
  );

  Then(
    "only an explicit custom key function lets the author opt into deriving a key from request-supplied data",
    gate("rate-limit-key-is-a-strategy-or-a-function", ["customKey", "=> `signin:"]),
  );
});

/** BEH-EA-145 (19-qadi-bridge-path-a.feature). */
export const authorizedSubjectTypeSteps = defineSteps(({ Given, When, Then }) => {
  Given(
    "an endpoint group that declares {string} without {string} preceding it in the chain",
    function* (_subject: string, _authentication: string) {
      yield* Effect.void;
    },
  );

  When("the group is composed", function* () {
    yield* Effect.void;
  });

  Then(
    "composition is rejected, because {string} has no {string} in its required environment",
    function* (_subject: string, _principal: string) {
      yield* Effect.void;
      assertTypeGate("authorized-subject-needs-authentication-first", GATES, [
        "Api.CurrentPrincipal extends",
        "= true",
      ]);
      // ...while the documented order leaves nothing unsatisfied.
      assertTypeGate("authorized-subject-in-the-right-order", GATES, ["[never]", "= true"]);
    },
  );

  Then(
    "the ordering violation is caught before any request reaches the group",
    gate("authorized-subject-needs-authentication-first", ["misorderedLeavesPrincipal"]),
  );
});

/** BEH-EA-151 (19-qadi-bridge-path-a.feature). */
export const witnessTypeSteps = defineSteps(({ Given, Then }) => {
  Given(
    "a handler needing downstream proof that {string} was granted for {string}",
    function* (_permission: string, _resource: string) {
      yield* Effect.void;
    },
  );

  Then(
    "it does not thread a boolean flag as a substitute for the witness",
    gate("guard-witness-is-not-a-boolean", ["@ts-expect-error", "removeWithWitness(true"]),
  );

  Then(
    "the downstream removal function's signature requires the actual witness value, not a boolean",
    gate("guard-witness-is-not-a-boolean", ["Authorized<Permission>"]),
  );
});

/** BEH-EA-155 (20-qadi-bridge-path-b.feature). */
export const publicEndpointTypeSteps = defineSteps(({ Given, When, Then }) => {
  Given("an endpoint in a RequirePermission-middlewared group", function* () {
    yield* Effect.void;
  });

  When(
    "it is annotated PublicEndpoint with a bare boolean instead of a documented reason string",
    function* () {
      yield* Effect.void;
    },
  );

  Then(
    "the declaration is not legal",
    gate("public-endpoint-needs-a-reason", ["@ts-expect-error", "PublicDeclaration"]),
  );

  Then(
    "the endpoint carries no valid public-endpoint exemption",
    gate("public-endpoint-needs-a-reason", ["@ts-expect-error", "true,"]),
  );
});

/** BEH-EA-261 (31-two-factor.feature). */
export const twoFactorGateTypeSteps = defineSteps(({ Given, When, Then }) => {
  Given(
    "a composition of {string} that omits {string} or {string}",
    function* (_plugin: string, _session: string, _reset: string) {
      yield* Effect.void;
    },
  );

  When("the composition is type-checked", function* () {
    yield* Effect.void;
  });

  Then("it fails to compile because a required marker service is missing", function* () {
    yield* Effect.void;
    assertTypeGate("two-factor-requires-the-session-gate", GATES, [
      "Includes<TwoFactorNeeds, TwoFactor.TwoFactorGateInstalled>",
    ]);
    assertTypeGate("two-factor-requires-a-reset-guard", GATES, [
      "Includes<TwoFactorNeeds, TwoFactor.TwoFactorResetGuard>",
    ]);
  });
});

/** BEH-EA-126 (16-oauth.feature). */
export const oauthSecretTypeSteps = defineSteps(({ Given, When, Then }) => {
  Given(
    "the application's plugin-wiring source code for provider {string}",
    function* (_provider: string) {
      yield* Effect.void;
    },
  );

  When("that source is inspected", function* () {
    yield* Effect.void;
  });

  Then(
    "no plaintext secret value appears as an option, a plugin argument, or anywhere alongside the plugin wiring",
    function* () {
      yield* Effect.void;
      // The type refuses a bare string...
      assertTypeGate("oauth-secret-is-config-redacted", GATES, [
        "@ts-expect-error",
        'clientSecret: "hunter2"',
      ]);
      // ...so what a provider holds is a `Config`, never the secret's value.
      const provider = OAuthProvider.oauth2({
        id: "okta",
        clientId: "abc",
        clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET"),
        scopes: [],
        endpoints: {
          authorizationEndpoint: "https://x.example.com/a",
          tokenEndpoint: "https://x.example.com/t",
        },
        mapProfile: () => ({ subject: "x" }),
      });
      assert.notEqual(typeof provider.clientSecret, "string");
      assert.ok(!JSON.stringify(provider.clientSecret).includes("hunter2"));
    },
  );

  Then("only the name of the environment variable appears", function* () {
    yield* Effect.void;
    const provider = OAuthProvider.oauth2({
      id: "okta",
      clientId: "abc",
      clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET"),
      scopes: [],
      endpoints: {
        authorizationEndpoint: "https://x.example.com/a",
        tokenEndpoint: "https://x.example.com/t",
      },
      mapProfile: () => ({ subject: "x" }),
    });
    // Reading it goes through the environment (an unset variable is a config error naming the variable).
    const secret = provider.clientSecret;
    assert.ok(secret !== undefined);
    const exit = yield* Effect.exit(secret);
    assert.ok(exit._tag === "Failure");
    assert.match(String(exit), /AUTH_OAUTH_OKTA_CLIENT_SECRET/);
  });
});
