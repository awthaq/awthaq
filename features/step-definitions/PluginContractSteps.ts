// P20a/AH-003, decision 36 Tier 4: 00-foundations/01-plugin-contract.feature (BEH-EA-001..008).
//
// Most of this Feature's Rules are compile-time (INV-EA-006 and friends): where a scenario has a
// runtime shadow (a service key, static members, what `Auth.make` produces) the steps assert it
// for real; where the enforcing mechanism is the compiler, the steps assert the matching gate in
// `PluginTypeGates.ts` (which the typecheck gate compiles) is still in place — see that file.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { Auth, type AuthPlugin } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assertTypeGate, cell, isObject, put, take, World } from "./FoundationsWorld.ts";
import {
  DependentFixture,
  fixtureConfig,
  InviteFixture,
  layerEvaluations,
  PasswordFixture,
  SessionsFixture,
  UsersFixture,
} from "./PluginFixtures.ts";
import { duplicateIdDiagnostic, missingDepDiagnostic } from "./PluginTypeGates.ts";

const GATES = "PluginTypeGates.ts";

/** The stand-in a scenario's quoted plugin label names; an unknown label fails loudly rather than defaulting. */
const pluginNamed = (label: string) => {
  if (label === "Password") return PasswordFixture;
  throw new Error(`no plugin stand-in is defined for "${label}"`);
};

interface Requirement {
  readonly probe: () => Effect.Effect<string>;
  readonly minLength: number;
}

const requiredService = cell(
  "requiredService",
  (value): value is Requirement =>
    isObject(value) &&
    "probe" in value &&
    typeof value.probe === "function" &&
    "minLength" in value,
);
/** What a scenario needs to know about one `Auth.make` result, read off it once when it is composed. */
interface Composition {
  readonly keys: ReadonlyArray<string>;
  readonly isLayer: boolean;
  readonly groupIds: ReadonlyArray<string>;
  readonly migrationNames: ReadonlyArray<string>;
  readonly manifestPlugins: ReadonlyArray<{ readonly id: string; readonly apiVersion: 1 }>;
}

const describeComposition = (built: {
  readonly api: { readonly groups: object };
  readonly layer: unknown;
  readonly migrations: Auth.Built<readonly [AuthPlugin.Any]>["migrations"];
  readonly manifest: Auth.Manifest;
}): Composition => ({
  keys: Object.keys(built),
  isLayer: Layer.isLayer(built.layer),
  groupIds: Object.keys(built.api.groups),
  migrationNames: built.migrations.map((migration) => migration.name),
  manifestPlugins: built.manifest.plugins.map((plugin) => ({
    id: plugin.id,
    apiVersion: plugin.apiVersion,
  })),
});

const composition = cell(
  "composition",
  (value): value is Composition =>
    isObject(value) && "migrationNames" in value && "isLayer" in value,
);
const claim = cell(
  "claim",
  (value): value is { readonly gate: string; readonly accepted: boolean; readonly id: string } =>
    isObject(value) && "gate" in value && "accepted" in value && "id" in value,
);
const statics = cell("statics", (value): value is ReadonlyArray<unknown> => Array.isArray(value));
const minLengths = cell("minLengths", (value): value is ReadonlyArray<number> =>
  Array.isArray(value),
);
const evaluationsBefore = cell(
  "evaluationsBefore",
  (value): value is number => typeof value === "number",
);

const snapshotStatics = () => [
  PasswordFixture.id,
  PasswordFixture.apiVersion,
  PasswordFixture.contract,
  PasswordFixture.tables,
  PasswordFixture.migrations,
];

const minLengthUnder = (configuration: Layer.Layer<never>) =>
  Effect.gen(function* () {
    const password = yield* PasswordFixture;
    return password.minLength;
  }).pipe(Effect.provide(PasswordFixture.layer.pipe(Layer.provide(configuration))));

/** REQ-EA-014/015: the literal a scenario states maps to a real config Layer; an unknown literal fails instead of silently using the default. */
const configLayers = new Map<string, Layer.Layer<never>>([
  ["Password.config({ minLength: 16 })", fixtureConfig({ minLength: 16 })],
]);

export const pluginContractSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-001 ----

  Given("a plugin class {string} produced by {string}", function* (label: string, factory: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    const plugin = pluginNamed(label);
    assert.match(factory, /^AuthPlugin\.Service/);
    assert.equal(typeof plugin.layer, "object", "a plugin class carries its own layer static");
  });

  When(
    "application code depends on {string} the same way it depends on any other Effect service",
    function* (label: string) {
      const plugin = pluginNamed(label);
      const service = yield* Effect.gen(function* () {
        return yield* plugin;
      }).pipe(Effect.provide(PasswordFixture.layer));
      yield* put(requiredService, service);
    },
  );

  Then("{string} can be required with {string}", function* (_label: string, usage: string) {
    assert.equal(usage, "yield* Password");
    const service = yield* take(requiredService);
    assert.equal(yield* service.probe(), "password");
  });

  Then("{string} can be supplied with {string}", function* (label: string, usage: string) {
    assert.equal(usage, "Layer.provide");
    const plugin = pluginNamed(label);
    // A consumer layer that itself `yield*`s the plugin, provided through plain `Layer.provide`.
    const consumer = Layer.effectDiscard(Effect.flatMap(plugin, (service) => service.probe()));
    yield* Effect.scoped(Layer.build(consumer.pipe(Layer.provide(PasswordFixture.layer))));
  });

  When("{string} is composed into an application", function* (label: string) {
    const built = Auth.make([pluginNamed(label)]);
    yield* put(composition, describeComposition(built));
  });

  Then(
    "its resolution and lifecycle are handled entirely by the ordinary Effect {string} runtime",
    function* (_layer: string) {
      const built = yield* take(composition);
      assert.ok(built.isLayer, "the composed plugin surface is an ordinary Layer");
      // Built like any other Layer: resolving the plugin needs nothing but the composed Layer.
      const service = yield* Effect.gen(function* () {
        return yield* PasswordFixture;
      }).pipe(Effect.provide(Auth.make([PasswordFixture]).layer));
      assert.equal(yield* service.probe(), "password");
    },
  );

  Then("no bespoke plugin resolver or lifecycle manager is involved", function* () {
    const built = yield* take(composition);
    // Everything `Auth.make` produces: contract data and one Layer, no resolver/lifecycle object.
    assert.deepEqual([...built.keys].sort(), [
      "adminApi",
      "api",
      "layer",
      "manifest",
      "migrations",
      "publicApi",
    ]);
  });

  // ---- BEH-EA-002 ----

  Given("a plugin class {string} declared with id {string}", function* (label: string, id: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(pluginNamed(label).id, id);
  });

  When("{string}'s compiled service key is inspected", function* (label: string) {
    yield* put(claim, { gate: pluginNamed(label).key, accepted: true, id: label });
  });

  Then("the key is {string}", function* (key: string) {
    const inspected = yield* take(claim);
    assert.equal(inspected.gate, key);
  });

  Given(
    "a plugin {string} that depends on a plugin whose service key is {string}",
    function* (label: string, key: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(label, "TwoFactor");
      assert.equal(PasswordFixture.key, key);
      assertTypeGate("missing-dep", GATES, ["@ts-expect-error", "TwoFactorFixture"]);
    },
  );

  When("{string}'s dependency is reported as unsatisfied", function* (_label: string) {
    yield* put(claim, { gate: missingDepDiagnostic.awthaq, accepted: false, id: "twoFactor" });
  });

  Then("the diagnostic names the plugin {string} by id", function* (id: string) {
    const diagnostic = (yield* take(claim)).gate;
    assert.ok(
      diagnostic.includes(`"${id}"`),
      `expected the diagnostic to name "${id}": ${diagnostic}`,
    );
  });

  Then("the diagnostic does not merely report an opaque unsatisfied requirement", function* () {
    const diagnostic = (yield* take(claim)).gate;
    // The curated literal names both plugins by id; an opaque Effect diagnostic names a service key.
    assert.ok(!diagnostic.includes("awthaq/plugin/"), diagnostic);
    assert.ok(diagnostic.includes('"twoFactor"') && diagnostic.includes('"password"'), diagnostic);
  });

  // ---- BEH-EA-003 ----

  Given("a plugin declaring {string}", function* (declaration: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(declaration, "apiVersion: 1");
    assert.equal(PasswordFixture.apiVersion, 1);
  });

  Given(
    "{string} accepts Plugin API generation {int}",
    function* (_make: string, generation: number) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(generation, 1);
    },
  );

  When("the plugin is passed as an argument to {string}", function* (_make: string) {
    // Runtime half: a generation-1 plugin composes. (A different generation cannot be
    // written as a well-typed call at all — that is the compile-time half, asserted below.)
    yield* put(composition, describeComposition(Auth.make([PasswordFixture])));
  });

  Then("the plugin type-checks as an argument to {string}", function* (_make: string) {
    const built = yield* take(composition);
    assert.deepEqual(
      built.manifestPlugins.map((plugin) => [plugin.id, plugin.apiVersion]),
      [["password", 1]],
    );
    assertTypeGate("satisfied-dep", GATES, ["Auth.make([PasswordFixture, TwoFactorFixture])"]);
  });

  Given(
    "a plugin declaring an {string} other than the generation {string} accepts",
    function* (field: string, _make: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(field, "apiVersion");
      assertTypeGate("api-version-literal", GATES, ["apiVersion: 2", 'id: "future"']);
    },
  );

  Then("the plugin fails to type-check as an argument to {string}", function* (_make: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assertTypeGate("api-version-literal", GATES, ["@ts-expect-error", "satisfies AuthPlugin.Any"]);
  });

  Then("the failure names the offending plugin", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    // tsc prints the rejected argument's type, which carries `id: "future"`.
    assertTypeGate("api-version-literal", GATES, ['id: "future"']);
  });

  Then("the failure occurs before any other validation runs", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    // The generation is a property of `AuthPlugin.Any` itself — an argument type error, reported
    // before `Validate<P>` (duplicate id, missing dependency, ...) is even evaluated.
    assertTypeGate("api-version-literal", GATES, ["satisfies AuthPlugin.Any"]);
  });

  // ---- BEH-EA-004 / BEH-EA-005: namespaced groups and table prefixes ----

  Given("a plugin with id {string}", function* (id: string) {
    yield* put(claim, { gate: "", accepted: false, id });
  });

  When(
    "its contract declares an {string} with id {string}",
    function* (_kind: string, groupId: string) {
      const { id } = yield* take(claim);
      assert.equal(InviteFixture.id, id);
      if (groupId === "acme.invite" || groupId === "acme.invite.admin") {
        assert.ok(
          Object.keys(InviteFixture.contract.groups).includes(groupId),
          `the plugin's contract declares the group "${groupId}"`,
        );
        yield* put(claim, { gate: "contract-group-in-own-namespace", accepted: true, id });
      } else {
        assert.ok(!Object.keys(InviteFixture.contract.groups).includes(groupId));
        yield* put(claim, { gate: "contract-group-outside-namespace", accepted: false, id });
      }
    },
  );

  When("its {string} array declares the entry {string}", function* (_field: string, table: string) {
    const { id } = yield* take(claim);
    assert.equal(PasswordFixture.id, id);
    assert.ok(
      PasswordFixture.tables.some((declared) => declared === table),
      `"${table}" is a declared table`,
    );
    assert.ok(table.startsWith(`${id}_`));
    yield* put(claim, { gate: "table-prefixed", accepted: true, id });
  });

  When(
    "its {string} array declares the bare entry {string}",
    function* (_field: string, table: string) {
      const { id } = yield* take(claim);
      assert.ok(!table.startsWith(`${id}_`), `"${table}" is a bare name`);
      yield* put(claim, { gate: "table-bare", accepted: false, id });
    },
  );

  Then("the plugin's class definition type-checks", function* () {
    const { gate, accepted } = yield* take(claim);
    assert.equal(accepted, true);
    if (gate === "contract-group-in-own-namespace") {
      assertTypeGate(gate, GATES, ["InviteFixture.contract.groups"]);
    } else {
      assertTypeGate(gate, GATES, ['tables: ["password_account"]']);
    }
  });

  Then("the plugin's class definition fails to type-check", function* () {
    const { gate, accepted } = yield* take(claim);
    assert.equal(accepted, false);
    assert.equal(gate, "contract-group-outside-namespace");
    assertTypeGate(gate, GATES, ["@ts-expect-error", 'HttpApiGroup.make("invitations")']);
  });

  Then(
    "the failure occurs at the plugin's own definition site, not at {string}",
    function* (make: string) {
      assert.equal(make, "Auth.make");
      const { gate } = yield* take(claim);
      // The gate is a bare `AuthPlugin.Service(...)` class definition: no composition is involved.
      assertTypeGate(gate, GATES, ["AuthPlugin.Service"], ["Auth.make"]);
    },
  );

  Then(
    "the declaration fails to type-check as an argument to {string}",
    function* (factory: string) {
      assert.equal(factory, "AuthPlugin.Service");
      const { gate, accepted } = yield* take(claim);
      assert.equal(accepted, false);
      assertTypeGate(gate, GATES, ["@ts-expect-error", 'tables: ["account"]']);
    },
  );

  // ---- BEH-EA-006: migrations are static ----

  Given(
    "a plugin class {string} declaring a static {string} member",
    function* (label: string, member: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      const plugin = pluginNamed(label);
      assert.equal(member, "migrations");
      assert.ok(plugin.migrations.length > 0);
    },
  );

  When(
    "the CLI reads {string}'s manifest \\({string}, {string}\\)",
    function* (label: string, ...commands: ReadonlyArray<string>) {
      assert.deepEqual(commands, ["awthaq plugin list --graph", "schema"]);
      const plugin = pluginNamed(label);
      const before = layerEvaluations.password;
      yield* put(evaluationsBefore, before);
      // Everything a manifest/schema read needs, taken off the composed value without a Layer.
      const built = Auth.make([plugin]);
      yield* put(composition, describeComposition(built));
    },
  );

  Then(
    "{string} is resolved by reading {string}'s static class members alone",
    function* (member: string, label: string) {
      assert.equal(member, "migrations");
      const built = yield* take(composition);
      const plugin = pluginNamed(label);
      assert.deepEqual(
        built.migrationNames,
        plugin.migrations.map((migration) => `0001_${plugin.id}_${migration.name}`),
      );
    },
  );

  Then(
    "no {string} is evaluated and no configuration service is provided to resolve it",
    function* (_layer: string) {
      const before = yield* take(evaluationsBefore);
      assert.equal(layerEvaluations.password, before, "the plugin's own make never ran");
    },
  );

  When(
    "{string} is configured with two different runtime configurations",
    function* (label: string) {
      const plugin = pluginNamed(label);
      yield* put(statics, snapshotStatics());
      assert.equal(plugin, PasswordFixture);
      const first = yield* minLengthUnder(fixtureConfig({ minLength: 8 }));
      const second = yield* minLengthUnder(fixtureConfig({ minLength: 32 }));
      yield* put(minLengths, [first, second]);
    },
  );

  Then(
    "the resolved {string} value is identical under both configurations",
    function* (member: string) {
      assert.equal(member, "migrations");
      const [first, second] = yield* take(minLengths);
      assert.notEqual(first, second, "the two configurations really differ at make-time");
      const before = yield* take(statics);
      const after = snapshotStatics();
      assert.deepEqual(after, before);
      // Same reference, not merely an equal copy: the member is frozen for the class's lifetime.
      assert.equal(after[4], before[4]);
    },
  );

  // ---- BEH-EA-007: options reach only Layers ----

  Given(
    "a plugin {string} with a configuration Layer {string}",
    function* (label: string, expression: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(pluginNamed(label), PasswordFixture);
      assert.equal(expression, "Password.config(partial)");
    },
  );

  When("{string} is provided", function* (expression: string) {
    const layer = configLayers.get(expression);
    assert.ok(layer !== undefined, `no configuration Layer is defined for ${expression}`);
    yield* put(statics, snapshotStatics());
    const defaulted = yield* minLengthUnder(Layer.empty);
    const configured = yield* minLengthUnder(layer);
    yield* put(minLengths, [defaulted, configured]);
  });

  Then("only the value {string}'s {string} produces at make-time changes", function* () {
    const [defaulted, configured] = yield* take(minLengths);
    assert.equal(defaulted, 12);
    assert.equal(configured, 16);
    assert.deepEqual(snapshotStatics(), yield* take(statics));
  });

  Given(
    "a plugin {string} with static {string}, {string}, {string}, and {string} members",
    function* (label: string, ...members: ReadonlyArray<string>) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(pluginNamed(label), PasswordFixture);
      assert.deepEqual(members, ["id", "apiVersion", "contract", "tables"]);
    },
  );

  When("any value is passed to {string}", function* (_call: string) {
    yield* put(statics, snapshotStatics());
    // Several unrelated configurations, none of which can reach a static member.
    for (const minLength of [0, 1, 1000]) {
      yield* minLengthUnder(fixtureConfig({ minLength }));
    }
  });

  Then(
    "{string}'s {string}, {string}, {string}, and {string} remain unchanged",
    function* (_label: string, ...members: ReadonlyArray<string>) {
      assert.deepEqual(members, ["id", "apiVersion", "contract", "tables"]);
      const before = yield* take(statics);
      const after = snapshotStatics();
      assert.deepEqual(after.slice(0, 4), before.slice(0, 4));
      assert.equal(after[2], before[2], "the contract is the same object");
    },
  );

  // ---- BEH-EA-008: dependsOn ----

  Given(
    "a plugin {string} declaring {string} on its {string}",
    function* (_label: string, declaration: string, member: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(declaration, "dependsOn: [Sessions, Users]");
      assert.equal(member, "layer");
      assert.deepEqual(
        DependentFixture.dependsOn.map((dep) => dep.id),
        ["sessions", "users"],
      );
    },
  );

  When("{string}'s {string} type is inspected", function* (_label: string, member: string) {
    assert.equal(member, "layer");
    yield* put(claim, { gate: "dependson-joins-rin", accepted: true, id: DependentFixture.id });
  });

  Then("{string} and {string} both appear in the {string}'s {string}", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    // The compiler proves `[Sessions | Users] extends Layer.Services<typeof DependentFixture.layer>`.
    assertTypeGate("dependson-joins-rin", GATES, [
      "SessionsFixture | UsersFixture",
      "typeof DependentFixture.layer",
    ]);
  });

  Given("a plugin {string} declaring {string}", function* (_label: string, declaration: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(declaration, "dependsOn: [Sessions, Users]");
  });

  When(
    "the linker computes migration order and a consumer composes {string}'s {string}",
    function* (_label: string, member: string) {
      assert.equal(member, "layer");
      yield* put(
        composition,
        describeComposition(Auth.make([SessionsFixture, UsersFixture, DependentFixture])),
      );
    },
  );

  Then(
    "the linker orders {string}'s migrations after {string} and {string}",
    function* (_label: string, first: string, second: string) {
      const built = yield* take(composition);
      const names = built.migrationNames;
      const position = (id: string) => names.findIndex((name) => name.includes(`_${id}_`));
      assert.ok(position("dependent") > position(first.toLowerCase()));
      assert.ok(position("dependent") > position(second.toLowerCase()));
    },
  );

  Then(
    "any consumer of {string}'s {string} must satisfy {string} and {string} as a compile-time requirement",
    function* () {
      yield* Effect.void; // an assertion-only step: nothing to await
      assertTypeGate("dependson-joins-rin", GATES, [
        "extends [",
        "Layer.Services<typeof DependentFixture.layer>",
      ]);
    },
  );
});

// Referenced so the gate file's runtime diagnostics stay imported (they are asserted in REQ-EA-004).
export const diagnostics = { duplicateIdDiagnostic, missingDepDiagnostic };
