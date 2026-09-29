// P20a/AH-003, decision 36 Tier 4: 00-foundations/02-plugin-composition-validate.feature
// (BEH-EA-009..016). Runtime shadows are asserted for real (composition output, served routes,
// slot conflicts at layer build, the cycle refusal, migration ordering against SQLite); the
// compiler-enforced halves are asserted through `PluginTypeGates.ts` — see `assertTypeGate`.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { Auth, type AuthPlugin } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { assertTypeGate, cell, isObject, put, take, World } from "./FoundationsWorld.ts";
import { migrateSqlite, MigPassword, MigTwoFactor } from "./MigrationFixtures.ts";
import {
  AuditorFixture,
  fakePlugin,
  OrganizationFixture,
  PasskeyFixture,
  PasswordFixture,
  PortUserFixture,
  RolesFixture,
  TwoFactorFixture,
} from "./PluginFixtures.ts";
import {
  duplicateIdComposition,
  duplicateIdDiagnostic,
  missingDepComposition,
  missingDepDiagnostic,
  outOfOrderComposition,
  outOfOrderDiagnostic,
} from "./PluginTypeGates.ts";
import { services } from "./ServeComposition.ts";
import { cheapArgon2id } from "./shared/Harness.ts";

const GATES = "PluginTypeGates.ts";

/** What a scenario needs to know about one `Auth.make` result. */
interface Composition {
  readonly keys: ReadonlyArray<string>;
  readonly groupIds: ReadonlyArray<string>;
  readonly migrationNames: ReadonlyArray<string>;
}

const describeComposition = (built: {
  readonly api: { readonly groups: object };
  readonly migrations: Auth.Built<readonly [AuthPlugin.Any]>["migrations"];
}): Composition => ({
  keys: Object.keys(built),
  groupIds: Object.keys(built.api.groups),
  migrationNames: built.migrations.map((migration) => migration.name),
});

/** What happened when the scenario's tuple was composed (and, where the check lives there, built). */
interface Outcome {
  readonly kind: string;
  readonly thrown?: { readonly tag: string; readonly message: string };
  readonly composition?: Composition;
  readonly failure?: { readonly tag: string; readonly text: string };
  readonly built?: boolean;
}

const tuple = cell("tuple", (value): value is string => typeof value === "string");
const outcome = cell(
  "outcome",
  (value): value is Outcome => isObject(value) && "kind" in value,
);
const baseline = cell(
  "baseline",
  (value): value is Composition => isObject(value) && "groupIds" in value,
);
const statuses = cell(
  "statuses",
  (value): value is ReadonlyArray<number> => Array.isArray(value),
);
const migrationRun = cell(
  "migrationRun",
  (value): value is { readonly core: ReadonlyArray<string>; readonly plugin: ReadonlyArray<string> } =>
    isObject(value) && "core" in value && "plugin" in value,
);

const cycle = cell("cycle", (value): value is ReadonlyArray<string> => Array.isArray(value));

const thrownOf = (error: unknown) => ({
  tag: isObject(error) && "_tag" in error && typeof error._tag === "string" ? error._tag : "unknown",
  message: error instanceof Error ? error.message : String(error),
});

const compose = (kind: string, run: () => Outcome): Outcome => {
  try {
    return run();
  } catch (error) {
    return { kind, thrown: thrownOf(error) };
  }
};

const failureOf = (cause: unknown) => ({
  tag: isObject(cause) && "_tag" in cause && typeof cause._tag === "string" ? cause._tag : "unknown",
  text:
    isObject(cause) && "message" in cause && typeof cause.message === "string"
      ? cause.message
      : String(cause),
});

const getStatus = (
  handler: (request: Request) => Promise<Response>,
  path: string,
): Effect.Effect<number> =>
  Effect.promise(() => handler(new Request(`http://localhost${path}`))).pipe(
    Effect.map((response) => response.status),
  );

/** The probe endpoints the stand-in plugins expose, by group. */
const probePath = (group: string) => (group === "password" ? "/password/probe" : `/${group}/probe`);

export const compositionSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-009 ----

  Given(
    "a plugin tuple containing {string} and its declared dependency {string}",
    function* (label: string, dependency: string) {
      if (dependency === "Core") {
        // Core is not a plugin: its session/account groups are seeded into every composition.
        assert.equal(label, "Password");
        yield* put(tuple, "password");
      } else {
        assert.deepEqual([label, dependency], ["TwoFactor", "Password"]);
        yield* put(tuple, "password+twoFactor");
      }
    },
  );

  When("{string} composes the tuple", function* (_make: string) {
    const kind = yield* take(tuple);
    const result = yield* Effect.gen(function* () {
      switch (kind) {
        case "password":
          return compose(kind, () => ({
            kind,
            composition: describeComposition(Auth.make([PasswordFixture])),
          }));
        case "password+twoFactor":
          return compose(kind, () => ({
            kind,
            composition: describeComposition(Auth.make([PasswordFixture, TwoFactorFixture])),
          }));
        case "duplicate-id":
          return compose(kind, () => {
            duplicateIdComposition();
            return { kind };
          });
        case "missing-dep":
          return compose(kind, () => {
            missingDepComposition();
            return { kind, built: true };
          });
        case "out-of-order":
          return compose(kind, () => {
            outOfOrderComposition();
            return { kind, built: true };
          });
        case "slot-conflict": {
          const built = Auth.make([RolesFixture, OrganizationFixture]);
          const conflict = yield* Effect.scoped(Layer.build(built.layer)).pipe(Effect.flip);
          return { kind, failure: failureOf(conflict) };
        }
        case "distinct-slots": {
          const built = Auth.make([RolesFixture, AuditorFixture]);
          const exit = yield* Effect.exit(Effect.scoped(Layer.build(built.layer)));
          return { kind, built: exit._tag === "Success" };
        }
        default:
          throw new Error(`unknown tuple "${kind}"`);
      }
    });
    yield* put(outcome, result);
  });

  Then(
    "composition succeeds and produces {string}, {string}, {string}, and {string}",
    function* (...products: ReadonlyArray<string>) {
      const { composition } = yield* take(outcome);
      assert.ok(composition !== undefined);
      assert.deepEqual(products, ["api", "layer", "migrations", "manifest"]);
      for (const product of products) assert.ok(composition.keys.includes(product), product);
      // Core's own groups ride along in `api` (MW-002): "Core" is a seed, not a plugin.
      assert.ok(composition.groupIds.includes("session") && composition.groupIds.includes("account"));
      assert.ok(composition.groupIds.includes("password"));
    },
  );

  Given("a plugin tuple already composed by {string}", function* (_make: string) {
    const before = describeComposition(Auth.make([PasswordFixture]));
    yield* put(baseline, before);
    // Before: the added plugin's route does not exist.
    const handler = HttpRouter.toWebHandler(TestAuth.layer(Auth.make([PasswordFixture]), services)).handler;
    yield* put(statuses, [yield* getStatus(handler, probePath("passkey"))]);
  });

  When(
    "a plugin contributing a new contract group and its handler is added to the tuple",
    function* () {
      const built = Auth.make([PasswordFixture, PasskeyFixture]);
      const handler = HttpRouter.toWebHandler(TestAuth.layer(built, services)).handler;
      const [before] = yield* take(statuses);
      yield* put(statuses, [before ?? -1, yield* getStatus(handler, probePath("passkey"))]);
      yield* put(outcome, { kind: "grown", composition: describeComposition(built) });
    },
  );

  Then("the recomputed {string} gains that group", function* (_api: string) {
    const before = yield* take(baseline);
    const { composition } = yield* take(outcome);
    assert.ok(composition !== undefined);
    assert.ok(!before.groupIds.includes("passkey"));
    assert.ok(composition.groupIds.includes("passkey"));
  });

  Then(
    "the recomputed {string} gains that group's handler in the same composition",
    function* (_layer: string) {
      const [before, after] = yield* take(statuses);
      assert.equal(before, 404, "before the plugin joined, nothing answers its route");
      assert.equal(after, 200, "after it joined, its handler answers");
    },
  );

  // ---- BEH-EA-010 ----

  Given(
    "a plugin tuple containing two plugins both declaring id {string}",
    function* (id: string) {
      assert.equal(id, "invite");
      yield* put(tuple, "duplicate-id");
    },
  );

  Then("composition is rejected", function* () {
    const result = yield* take(outcome);
    switch (result.kind) {
      case "duplicate-id":
        // Runtime backstop: the duplicate also trips composeApi's own group-conflict check.
        assert.equal(result.thrown?.tag, "GroupIdConflict");
        assertTypeGate("duplicate-id", GATES, ["@ts-expect-error", "InviteOne, InviteTwin"]);
        return;
      case "missing-dep":
        assertTypeGate("missing-dep", GATES, ["@ts-expect-error", "Auth.make([TwoFactorFixture])"]);
        return;
      case "out-of-order":
        assertTypeGate("out-of-order-dep", GATES, ["@ts-expect-error"]);
        return;
      case "slot-conflict":
        assert.equal(result.failure?.tag, "SlotConflict");
        return;
      default:
        throw new Error(`nothing was rejected for "${result.kind}"`);
    }
  });

  Then(
    "the rejection narrows the tuple's type to a literal string naming {string} as the duplicated id",
    function* (id: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(duplicateIdDiagnostic.awthaq, `plugin id "${id}" appears more than once`);
    },
  );

  Then("composition is rejected at the {string} call site", function* (make: string) {
    assert.equal(make, "Auth.make");
    const result = yield* take(outcome);
    assert.equal(result.kind, "duplicate-id");
    // The refusal is Auth.make itself throwing/type-failing — there is no composed value at all.
    assert.equal(result.composition, undefined);
    assertTypeGate("duplicate-id", GATES, ["Auth.make([InviteOne, InviteTwin])"]);
  });

  Then("no {string} step is ever reached for this tuple", function* (step: string) {
    assert.equal(step, "Layer.launch");
    const result = yield* take(outcome);
    // No `layer` was produced to launch: the composition call itself failed.
    assert.equal(result.built, undefined);
    assert.equal(result.composition, undefined);
  });

  // ---- BEH-EA-011 ----

  Given(
    "a plugin tuple containing {string} without its declared dependency {string}",
    function* (label: string, dependency: string) {
      assert.deepEqual([label, dependency], ["TwoFactor", "Password"]);
      yield* put(tuple, "missing-dep");
    },
  );

  Then(
    "the rejection names {string} as the missing dependency of {string}",
    function* (dependency: string, dependent: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(
        missingDepDiagnostic.awthaq,
        `plugin "${TwoFactorFixture.id}" depends on plugin "${PasswordFixture.id}", which is not in the list`,
      );
      assert.equal(dependency, "Password");
      assert.equal(dependent, "TwoFactor");
    },
  );

  Then("composition succeeds", function* () {
    const result = yield* take(outcome);
    if (result.kind === "distinct-slots") {
      // Two overrides of different slots: the composed layer builds, no SlotConflict.
      assert.equal(result.built, true);
      return;
    }
    assert.equal(result.kind, "password+twoFactor");
    assert.ok(result.composition !== undefined);
    assert.deepEqual(result.composition.migrationNames, [
      "0001_password_create_password_account",
      "0002_twoFactor_create_two_factor_secret",
    ]);
    assertTypeGate("satisfied-dep", GATES, ["Auth.make([PasswordFixture, TwoFactorFixture])"]);
  });

  Then(
    "the rejection is a literal string naming both {string} and {string}",
    function* (dependency: string, dependent: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      const message = missingDepDiagnostic.awthaq;
      assert.equal(typeof message, "string");
      assert.ok(message.includes(`"${dependency.toLowerCase()}"`), message);
      assert.ok(message.includes(`"${dependent.charAt(0).toLowerCase()}${dependent.slice(1)}"`), message);
    },
  );

  Then("the rejection is not merely an opaque unsatisfied service requirement", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.ok(!missingDepDiagnostic.awthaq.includes("awthaq/plugin/"));
    assert.ok(missingDepDiagnostic.awthaq.includes("depends on plugin"));
  });

  Given(
    "a plugin tuple listing {string} before its declared dependency {string}",
    function* (dependent: string, dependency: string) {
      assert.deepEqual([dependent, dependency], ["TwoFactor", "Password"]);
      yield* put(tuple, "out-of-order");
    },
  );

  Then(
    "the rejection names {string} as a plugin that must be listed before {string}",
    function* (dependency: string, dependent: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(dependency, "Password");
      assert.equal(dependent, "TwoFactor");
      assert.equal(
        outOfOrderDiagnostic.awthaq,
        'plugin "twoFactor" depends on plugin "password", which must be listed before it',
      );
    },
  );

  // ---- BEH-EA-012 ----

  Given(
    "a plugin tuple containing {string} and {string}, both overriding the {string} slot",
    function* (first: string, second: string, slot: string) {
      assert.deepEqual([first, second, slot], ["Roles", "Organization", "SubjectResolver"]);
      yield* put(tuple, "slot-conflict");
    },
  );

  Then(
    "the rejection names {string}, {string}, and {string}",
    function* (first: string, second: string, slot: string) {
      const { failure } = yield* take(outcome);
      assert.ok(failure !== undefined);
      assert.equal(failure.tag, "SlotConflict");
      assert.ok(failure.text.includes(`"${first.toLowerCase()}"`), failure.text);
      assert.ok(failure.text.includes(`"${second.toLowerCase()}"`), failure.text);
      assert.ok(failure.text.includes(slot), failure.text);
    },
  );

  Given(
    "a plugin tuple containing {string} overriding the {string} slot and another plugin overriding a distinct slot",
    function* (label: string, slot: string) {
      assert.deepEqual([label, slot], ["Roles", "SubjectResolver"]);
      yield* put(tuple, "distinct-slots");
    },
  );

  When("the composed layer is built without any explicit {string}", function* (explicit: string) {
    assert.equal(explicit, "Slots.layer");
    const built = Auth.make([RolesFixture, OrganizationFixture]);
    const conflict = yield* Effect.scoped(Layer.build(built.layer)).pipe(Effect.flip);
    yield* put(outcome, { kind: "slot-conflict", failure: failureOf(conflict) });
  });

  Then("the build fails with a {string} naming both owners", function* (tag: string) {
    const { failure } = yield* take(outcome);
    assert.ok(failure !== undefined);
    assert.equal(failure.tag, tag);
    assert.ok(failure.text.includes('"roles"') && failure.text.includes('"organization"'), failure.text);
  });

  // ---- BEH-EA-013 ----

  Given(
    "{string} produced by {string} from a plugin tuple {string}",
    function* (_auth: string, _make: string, _tuple: string) {
      yield* put(tuple, "served");
    },
  );

  When(
    "{string}'s groups are compared against {string}'s {string}",
    function* (_api: string, _layer: string, _rout: string) {
      const built = Auth.make([PasswordFixture, PasskeyFixture]);
      const handler = HttpRouter.toWebHandler(TestAuth.layer(built, services)).handler;
      const groupIds = Object.keys(built.api.groups).filter(
        (id) => id !== "session" && id !== "account",
      );
      const answered = yield* Effect.forEach(groupIds, (id) =>
        getStatus(handler, probePath(id)),
      );
      yield* put(statuses, answered);
      yield* put(outcome, { kind: "served", composition: describeComposition(built) });
    },
  );

  Then(
    "no group in {string} lacks a handler service in {string}'s {string}",
    function* () {
      const { composition } = yield* take(outcome);
      assert.ok(composition !== undefined);
      // Every plugin group has an answering handler: none was left unhandled.
      assert.deepEqual(yield* take(statuses), [200, 200]);
      assertTypeGate("api-layer-consistency", GATES, ["everyGroupHasAHandler", "= true"]);
    },
  );

  When(
    "{string}'s {string} is compared against {string}'s groups",
    function* (_layer: string, _rout: string, _api: string) {
      const built = Auth.make([PasswordFixture, PasskeyFixture]);
      const handler = HttpRouter.toWebHandler(TestAuth.layer(built, services)).handler;
      // A route nobody's group declares is not served: a handler cannot exist without a group.
      yield* put(statuses, [
        yield* getStatus(handler, probePath("password")),
        yield* getStatus(handler, "/nobody/probe"),
      ]);
      yield* put(outcome, { kind: "served", composition: describeComposition(built) });
    },
  );

  Then(
    "no handler service in {string}'s {string} lacks a corresponding group in {string}",
    function* () {
      const [declared, undeclared] = yield* take(statuses);
      assert.equal(declared, 200);
      assert.equal(undeclared, 404);
      assertTypeGate("api-layer-consistency", GATES, ["everyHandlerHasAGroup", "= true"]);
    },
  );

  // ---- BEH-EA-014: ports ----

  Given(
    "{string} produced by {string} with unprovided ports {string} and {string}",
    function* (_layer: string, _make: string, first: string, second: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([first, second], ["Mailer", "PasswordHasher"]);
    },
  );

  When(
    "the application calls {string} on {string} without providing those ports",
    function* (launch: string, _layer: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(launch, "Layer.launch");
    },
  );

  Then("the call fails to type-check", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    assertTypeGate("launch-needs-ports", GATES, [
      "@ts-expect-error",
      "Layer.launch(auth.layer)",
      "Effect.Effect<never, unknown, never>",
    ]);
  });

  Then(
    "the diagnostic lists {string} and {string} as unsatisfied requirements",
    function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
      // `requiresExactlyBothPorts` is an exact-set check: the layer's RIn is Mailer | PasswordHasher.
      assertTypeGate("launch-needs-ports", GATES, ["requiresExactlyBothPorts", "= true"]);
    },
  );

  Given(
    "an application that provides {string} to {string} and compiles successfully",
    function* (_port: string, _layer: string) {
      // Runtime half: with both ports provided (the in-memory Mailer stands in for a real one)
      // the very same composed layer builds.
      const provided = Auth.make([PortUserFixture]).layer.pipe(
        Layer.provide(Layer.mergeAll(Mailer.layerMemory, cheapArgon2id)),
        Layer.provide(NodeCrypto.layer),
      );
      yield* Effect.scoped(Layer.build(provided));
    },
  );

  When(
    "the {string} line is removed from the application's wiring",
    function* (_line: string) {
      yield* put(tuple, "launch-without-mailer");
    },
  );

  Then("{string} fails to type-check", function* (launch: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(launch, "Layer.launch");
    assertTypeGate("launch-names-mailer", GATES, ["@ts-expect-error", "Layer.launch(withoutMailer())"]);
  });

  Then("the diagnostic names {string} as the unsatisfied requirement", function* (port: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(port, "Mailer");
    // The only requirement left besides Effect's own `Crypto` is Mailer, as an exact-set check.
    assertTypeGate("launch-names-mailer", GATES, ["stillRequiresOnlyMailer", "= true"]);
  });

  Given(
    "{string} produced by {string} with an unprovided port",
    function* (_layer: string, _make: string) {
      yield* put(tuple, "unprovided-port");
    },
  );

  When(
    "the application calls {string} without providing that port",
    function* (launch: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(launch, "Layer.launch");
    },
  );

  Then(
    "the diagnostic is Effect's ordinary {string} Layer diagnostic naming the unsatisfied service",
    function* (phrase: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(phrase, "is not assignable to");
      // The rejection comes from the unannotated-`never` assignment tsc reports itself, over a
      // requirement set (`Mailer | PasswordHasher`) it names.
      assertTypeGate("launch-needs-ports", GATES, ["@ts-expect-error", "Mailer and PasswordHasher"]);
    },
  );

  Then(
    "the diagnostic is not one of {string}'s curated duplicate-id, missing-dependency, or slot-conflict strings",
    function* (make: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(make, "Auth.make");
      // `Validate` has nothing to say about a missing port: it resolves to the tuple itself.
      assertTypeGate("port-diagnostic-is-effects-own", GATES, ["awthaq: string", "? false"]);
    },
  );

  // ---- BEH-EA-015 ----

  Given(
    "a plugin {string} declared with id {string} whose contract adds an {string} named {string}",
    function* (label: string, id: string, kind: string, group: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([label, id, kind, group], ["Invite", "acme.invite", "HttpApiGroup", "invitations"]);
    },
  );

  Given(
    "a plugin {string} whose contract names a group outside its own namespace, defined in isolation from any other plugin",
    function* (label: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(label, "Invite");
    },
  );

  When("the {string} class is defined", function* (label: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(label, "Invite");
  });

  Then("the class definition fails to type-check", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    assertTypeGate("contract-group-outside-namespace", GATES, [
      "@ts-expect-error",
      'HttpApiGroup.make("invitations")',
    ]);
  });

  Then(
    "{string} can never be expressed as a value that reaches {string}",
    function* (_plugin: string, make: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(make, "Auth.make");
      // The rejected class definition is the only place the plugin could be written; the gate
      // is a bare class definition with no `Auth.make` call to reach.
      assertTypeGate("contract-group-outside-namespace", GATES, ["AuthPlugin.Service"], ["Auth.make"]);
    },
  );

  Then(
    "the class definition fails to type-check without composing {string} with any other plugin",
    function* (_plugin: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assertTypeGate(
        "contract-group-outside-namespace",
        GATES,
        ["@ts-expect-error", "extends AuthPlugin.Service"],
        ["Auth.make", "dependsOn"],
      );
    },
  );

  Then(
    "the failure occurs earlier than any {string}-site check over a composed tuple \\(duplicate id, missing dependency, slot conflict\\)",
    function* (make: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(make, "Auth.make");
      assertTypeGate("contract-group-outside-namespace", GATES, ["AuthPlugin.Service"], ["Auth.make"]);
    },
  );

  // ---- BEH-EA-016: the linker's two runtime checks ----

  Given(
    "a composed application of core plugins {string}, {string}, {string} and installed plugins {string} and {string} whose {string} graph is acyclic",
    function* (...names: ReadonlyArray<string>) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual(names, ["Users", "Accounts", "Sessions", "Password", "Sessions2FA", "dependsOn"]);
    },
  );

  When("{string} runs its linker step", function* (_make: string) {
    // Core's tables are the runner's first step; the linker's own list is plugin-only.
    const built = Auth.make([MigPassword, MigTwoFactor]);
    const ran = yield* migrateSqlite(built.migrations);
    yield* put(outcome, {
      kind: "linked",
      composition: describeComposition(built),
      built: ran.tables.includes("users") && ran.tables.includes("accounts") && ran.tables.includes("sessions"),
    });
    yield* put(migrationRun, {
      core: ran.coreRows.map((row) => row.name),
      plugin: ran.pluginRows.map((row) => row.name),
    });
  });

  Then(
    "the derived migration order places all core migrations before any plugin migrations",
    function* () {
      const linked = yield* take(outcome);
      const run = yield* take(migrationRun);
      assert.ok(run.core.length >= 3, "core's own ledger holds its migrations");
      // The plugin `up`s read core's `users` table: had any run first, applying them would have failed.
      assert.equal(linked.built, true, "users/accounts/sessions exist");
      assert.ok(run.plugin.length > 0);
      // The linker's list carries no core migration: core keeps its own ledger and runs first.
      const pluginNames = new Set(linked.composition?.migrationNames);
      assert.ok(run.core.every((name) => !pluginNames.has(name)));
    },
  );

  Then("plugin migrations follow the {string} graph's topological order", function* (_graph: string) {
    const { plugin } = yield* take(migrationRun);
    const at = (id: string) => plugin.findIndex((name) => name.includes(`_${id}_`));
    assert.ok(at("password") >= 0 && at("sessions2fa") >= 0);
    assert.ok(at("password") < at("sessions2fa"), plugin.join(", "));
  });

  Then("every migration key is rewritten {string}", function* (pattern: string) {
    assert.equal(pattern, "NNNN_<plugin>_<name>");
    const { plugin } = yield* take(migrationRun);
    for (const name of plugin) assert.match(name, /^\d{4}_[a-z0-9]+_[a-z0-9_]+$/);
    assert.deepEqual(
      plugin.map((name) => name.slice(0, 4)),
      plugin.map((_name, index) => String(index + 1).padStart(4, "0")),
    );
  });

  Given(
    "a plugin tuple whose {string} declarations form a cycle {string} depends on {string}, {string} depends on {string}, {string} depends on {string}",
    function* (field: string, ...edges: ReadonlyArray<string>) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(field, "dependsOn");
      assert.deepEqual(edges, ["A", "B", "B", "C", "C", "A"]);
    },
  );

  When(
    "{string} runs Kahn's algorithm over the composed {string} graph",
    function* (_make: string, _graph: string) {
      // A real class cannot be forced into a cycle (ELC-006 refuses a second `dependsOn`), so the
      // cycle is built from plugin *values* whose `dependsOn` point at each other.
      const a: FakeA = fakePlugin("A", () => [b]);
      const b: FakeB = fakePlugin("B", () => [c]);
      const c: FakeC = fakePlugin("C", () => [a]);
      try {
        Auth.make([a, b, c]);
      } catch (error) {
        assert.ok(error instanceof Auth.CircularPluginDependency);
        yield* put(cycle, error.cycle);
        return;
      }
      throw new Error("Auth.make accepted a cyclic dependsOn graph");
    },
  );

  Then("a cycle is detected", function* () {
    assert.ok((yield* take(cycle)).length > 0);
  });

  Then(
    "the report names the full cycle path {string} -> {string} -> {string} -> {string}",
    function* (...path: ReadonlyArray<string>) {
      assert.deepEqual(yield* take(cycle), path);
    },
  );
});

type FakeA = ReturnType<typeof fakePlugin<"A">>;
type FakeB = ReturnType<typeof fakePlugin<"B">>;
type FakeC = ReturnType<typeof fakePlugin<"C">>;

