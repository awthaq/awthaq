// P20a/AH-003, decision 36 Tier 4: 00-foundations/03-ports-slots-hooks-registries.feature
// (BEH-EA-017..024). Configuration references, slots, hook points and registries are all real
// runtime objects here; the compile-time halves (a wrong override, a port left in `RIn`, an
// unhandled divert, a tap on a point nobody provides) go through `PluginTypeGates.ts`.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { Api } from "@awthaq/api";
import { Auth, HookPoint, Hooks, RateLimits, Slots } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { SubjectResolver } from "@awthaq/qadi";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { makeSubject } from "@qadi/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { assertTypeGate, cell, isObject, put, take, World } from "./FoundationsWorld.ts";
import {
  AfterSignIn,
  BeforeSignUp,
  CryptoUserOne,
  CryptoUserTwo,
  InviteOne,
  InviteTapper,
  NotifierFixture,
  NotifierNoMail,
  OrganizationFixture,
  PasskeyFixture,
  PasswordFixture,
  RolesFixture,
  SignInDivert,
  SignInOutcome,
  SignUpInput,
} from "./PluginFixtures.ts";
import { unhandledDivert } from "./PluginTypeGates.ts";

const GATES = "PluginTypeGates.ts";

/** BEH-EA-017: the tenants' own overrides, keyed by tenant — composed with Effect's own `LayerMap`. */
/** `LayerMap` needs a layer with an output; the tenant's name rides along, the override itself is `Password.config`. */
class TenantName extends Context.Service<TenantName, string>()("features/TenantName") {}

class TenantAuthConfig extends LayerMap.Service<TenantAuthConfig>()("features/TenantAuthConfig", {
  lookup: (tenant: string) =>
    Layer.merge(
      Password.config({ minLength: tenant === "acme" ? 16 : 20 }),
      Layer.succeed(TenantName, tenant),
    ),
}) {}

const minLengthOf = Effect.map(Password.PasswordConfig, (config) => config.minLength);

const numbers = cell("numbers", (value): value is ReadonlyArray<number> => Array.isArray(value));
const strings = cell("strings", (value): value is ReadonlyArray<string> => Array.isArray(value));
const gate = cell("gate", (value): value is string => typeof value === "string");
const exitStatus = cell("exitStatus", (value): value is "success" | "failure" =>
  value === "success" || value === "failure",
);
const abort = cell(
  "abort",
  (value): value is { readonly tag: string; readonly code: string } =>
    isObject(value) && "tag" in value && "code" in value,
);
const outcome = cell("outcome", (value): value is HookPoint.DivertResult<SignUpInput, SignInOutcome> =>
  isObject(value) && "_tag" in value,
);
const claims = cell(
  "claims",
  (value): value is ReadonlyArray<{ readonly plugin: string; readonly order: number }> =>
    Array.isArray(value),
);

const silent = Logger.layer([]);

const signUp = (email: string) => new SignUpInput({ email });

/** A tap owner for BEH-EA-022's ordering scenario: just an id and what it depends on. */
const owner = (id: string, dependsOn: ReadonlyArray<HookPoint.TapOwner> = []): HookPoint.TapOwner => ({
  id,
  dependsOn,
});

export const registriesSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-017: configuration is a Reference ----

  Given(
    "a plugin {string} whose options are declared as {string}, a {string} with a {string}",
    function* (plugin: string, options: string, kind: string, member: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([plugin, options, kind, member], [
        "Password",
        "PasswordConfig",
        "Context.Reference",
        "defaultValue",
      ]);
    },
  );

  When("{string}'s options are inspected", function* (_plugin: string) {
    yield* put(gate, "inspected");
  });

  Then(
    "the options are a {string}, not arguments to a factory function",
    function* (_kind: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.ok(Context.isReference(Password.PasswordConfig));
      assert.equal(typeof Password.PasswordConfig.defaultValue, "function");
      // The plugin itself is a class with a `layer` static, and its `config` yields a Layer — no
      // factory function takes the options as arguments.
      assert.ok(Layer.isLayer(Password.Password.layer));
      assert.ok(Layer.isLayer(Password.config({ minLength: 20 })));
    },
  );

  Given(
    "a plugin {string} whose {string} declares {string}",
    function* (_plugin: string, _reference: string, declaration: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.match(declaration, /^defaultValue: \(\) => \(\{ minLength: 12/);
      assert.equal(Password.PasswordConfig.defaultValue().minLength, 12);
    },
  );

  When("no {string} override is provided", function* (_override: string) {
    const exit = yield* Effect.exit(minLengthOf);
    yield* put(exitStatus, exit._tag === "Success" ? "success" : "failure");
    yield* put(numbers, exit._tag === "Success" ? [exit.value] : []);
  });

  Then("{string} resolves to its declared default value", function* (_reference: string) {
    const [minLength] = yield* take(numbers);
    assert.equal(minLength, Password.PasswordConfig.defaultValue().minLength);
    assert.equal(minLength, 12);
  });

  Then("no error is produced for the missing override", function* () {
    assert.equal(yield* take(exitStatus), "success");
  });

  Given(
    "a {string} composed via {string} from tenant-specific {string} Layers",
    function* (map: string, service: string, layers: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([map, service, layers], ["TenantAuthConfig", "LayerMap.Service", "Password.config(...)"]);
    },
  );

  When("a request is scoped to a given tenant", function* () {
    const acme = yield* minLengthOf.pipe(
      Effect.provide(TenantAuthConfig.get("acme").pipe(Layer.provide(TenantAuthConfig.layer))),
    );
    const globex = yield* minLengthOf.pipe(
      Effect.provide(TenantAuthConfig.get("globex").pipe(Layer.provide(TenantAuthConfig.layer))),
    );
    // What a plain application `Layer.provide` of the same override gives.
    const plain = yield* minLengthOf.pipe(Effect.provide(Password.config({ minLength: 16 })));
    yield* put(numbers, [acme, globex, plain]);
  });

  Then(
    "that tenant's {string} override is provided the same way any application {string} would be",
    function* () {
      const [acme, globex, plain] = yield* take(numbers);
      assert.equal(acme, plain, "the tenant's override is just an ordinary provided Layer");
      assert.notEqual(acme, globex, "each tenant gets its own override");
      assert.equal(globex, 20);
    },
  );

  Then("no plugin-specific override mechanism is required", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    // `TenantAuthConfig` above is Effect's own `LayerMap.Service` over `Password.config` Layers;
    // nothing from awthaq beyond the config Layer itself took part.
    assert.ok(Layer.isLayer(TenantAuthConfig.get("acme")));
    assert.ok(Layer.isLayer(Password.config({ minLength: 16 })));
  });

  // ---- BEH-EA-018: a wrong override is a type error ----

  Given(
    "{string}'s declared shape requires {string} to be a number",
    function* (_reference: string, key: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(key, "minLength");
      assert.equal(typeof Password.PasswordConfig.defaultValue().minLength, "number");
    },
  );

  When('"Password.config\\(\\{ minLength: "twelve" \\}\\)" is written', function* () {
    yield* put(gate, "config-wrong-type");
  });

  Given(
    "{string}'s declared shape does not include a key {string}",
    function* (_reference: string, key: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(key, "unknownOption");
      assert.ok(!(key in Password.PasswordConfig.defaultValue()));
    },
  );

  When('"Password.config\\(\\{ unknownOption: true \\}\\)" is written', function* () {
    yield* put(gate, "config-unknown-key");
  });

  Then("the call site fails to type-check", function* () {
    const name = yield* take(gate);
    assertTypeGate(name, GATES, ["@ts-expect-error", "Password.config("]);
  });

  Given("a wrong-typed {string} override", function* (_call: string) {
    yield* put(gate, "config-wrong-type");
  });

  When("the application is composed and run", function* () {
    // Were the override to reach runtime nothing would check it — `config` is a bare Layer.succeed.
    // (`JSON.parse` yields an untyped value, the only way to feed it past the compiler.)
    const smuggled = JSON.parse('{"minLength":"twelve"}');
    const value = yield* minLengthOf.pipe(Effect.provide(Password.config(smuggled)));
    yield* put(strings, [String(value)]);
  });

  Then("the override was already rejected at the call site", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    assertTypeGate("config-wrong-type", GATES, ["@ts-expect-error", 'minLength: "twelve"']);
  });

  Then("no runtime validation failure occurs at boot or at first use for this override", function* () {
    // Composition and first read both succeeded: there is no runtime validator to fail, which is
    // exactly why the call-site check above is the only defence.
    assert.deepEqual(yield* take(strings), ["twelve"]);
  });

  // ---- BEH-EA-019: variants ----

  Given(
    "a plugin {string} exposing a static variant {string} alongside its full {string}",
    function* (plugin: string, variant: string, full: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      // Stand-in: `NotifierFixture.layerNoMail` is the variant, `.layer` the full layer.
      assert.deepEqual([plugin, variant, full], ["Password", "Password.layerNoReset", "Password.layer"]);
      assert.ok(Layer.isLayer(NotifierFixture.layer) && Layer.isLayer(NotifierFixture.layerNoMail));
    },
  );

  When(
    "{string} is passed to {string} in place of {string}",
    function* (_variant: string, make: string, _plugin: string) {
      assert.equal(make, "Auth.make");
      const built = Auth.make([NotifierNoMail]);
      yield* put(strings, built.manifest.plugins.map((entry) => entry.id));
    },
  );

  Then(
    "{string} accepts {string} as a valid tuple entry",
    function* (_make: string, _variant: string) {
      assert.deepEqual(yield* take(strings), ["notifier"]);
      assertTypeGate("variant-drops-port", GATES, ["Auth.make([NotifierNoMail])"]);
    },
  );

  Given(
    "{string} whose {string} never reads {string}",
    function* (_variant: string, _member: string, port: string) {
      assert.equal(port, "Mailer");
      // With no Mailer provided anywhere the variant's layer still builds and works.
      const built = Auth.make([NotifierNoMail]);
      const notified = yield* Effect.gen(function* () {
        const notifier = yield* NotifierFixture;
        return yield* notifier.notify();
      }).pipe(Effect.provide(built.layer));
      assert.equal(notified, "silent");
    },
  );

  When("{string} composes the tuple", function* (_call: string) {
    yield* put(strings, Auth.make([NotifierNoMail, PasskeyFixture]).manifest.plugins.map((p) => p.id));
  });

  Then(
    "{string}'s type does not include {string} in its {string}",
    function* (_layer: string, port: string, _rin: string) {
      assert.equal(port, "Mailer");
      assert.deepEqual(yield* take(strings), ["notifier", "passkey"]);
      assertTypeGate("variant-drops-port", GATES, [
        "fullLayerRequiresMailer",
        "variantLayerDoesNotRequireMailer",
      ]);
    },
  );

  // ---- BEH-EA-020: ports stay in RIn ----

  Given(
    "a plugin {string} whose {string} uses the port {string}",
    function* (plugin: string, member: string, port: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([plugin, member, port], ["Password", "make", "PasswordHasher"]);
    },
  );

  When(
    "{string}'s {string} type is inspected before the application provides {string}",
    function* (_plugin: string, member: string, _port: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(member, "layer");
    },
  );

  Then("{string} remains in {string}'s Layer {string}", function* (port: string, _plugin: string, rin: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(port, "PasswordHasher");
    assert.equal(rin, "RIn");
    assertTypeGate("port-stays-in-rin", GATES, ["passwordRequiresHasher", "= true"]);
  });

  Given(
    "a plugin {string} whose {string} uses the ports {string} and {string}",
    function* (plugin: string, member: string, first: string, second: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([plugin, member, first, second], ["Password", "make", "PasswordHasher", "Mailer"]);
    },
  );

  When("{string}'s Layer {string} is inspected", function* (_plugin: string, rout: string) {
    assert.equal(rout, "ROut");
    // Runtime shadow with a plugin whose port is cheap to provide: build the layer with the port
    // supplied through `Layer.provide` (not `provideMerge`) and see what the built context holds.
    const context = yield* Effect.scoped(
      Layer.build(NotifierFixture.layer.pipe(Layer.provide(Mailer.layerMemory))),
    );
    yield* put(gate, Option.isNone(Context.getOption(context, Mailer.Mailer)) ? "port-absent" : "port-present");
  });

  Then(
    "neither {string} nor {string} appears in {string}'s Layer {string}",
    function* () {
      assert.equal(yield* take(gate), "port-absent");
      assertTypeGate("port-not-in-rout", GATES, ["passwordProvidesNoPort", "= true"]);
    },
  );

  Given(
    "two plugins {string} and {string} that both use the port {string}",
    function* (first: string, second: string, port: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([first, second, port], ["Password", "Passkey", "Crypto"]);
    },
  );

  When("both are composed by {string}", function* (make: string) {
    assert.equal(make, "Auth.make");
    const built = Auth.make([CryptoUserOne, CryptoUserTwo]);
    // One shared Crypto satisfies both; nothing conflicts.
    const outcomeOf = yield* Effect.exit(
      Effect.scoped(Layer.build(built.layer.pipe(Layer.provide(NodeCrypto.layer)))),
    );
    yield* put(exitStatus, outcomeOf._tag === "Success" ? "success" : "failure");
  });

  Then(
    "{string} remains a single shared entry in the composed Layer's {string}",
    function* (_port: string, _rin: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assertTypeGate("shared-port-is-one-entry", GATES, ["cryptoIsTheOnlyRequirement", "= true"]);
    },
  );

  Then(
    "no slot-conflict-style failure occurs between {string} and {string} over {string}",
    function* () {
      assert.equal(yield* take(exitStatus), "success");
    },
  );

  // ---- BEH-EA-021: slots ----

  const userPrincipal = new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: "u-1" }),
    sessionId: "s-1",
  });

  const grantingResolver = Slots.override(
    { id: "granting" },
    SubjectResolver.SubjectResolver,
    Effect.succeed({
      resolve: (principal: Api.Principal) =>
        Effect.succeed(
          makeSubject({
            id: `user:${principal._tag === "User" ? principal.ref.id : "x"}`,
            roles: ["admin"],
            permissions: ["orders:read"],
          }),
        ),
    }),
  ).pipe(Layer.provideMerge(Slots.layer));

  Given("no installed plugin overrides the {string} slot", function* (slot: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(slot, "SubjectResolver");
  });

  When("{string} is resolved", function* (_slot: string) {
    // Nothing provides it: the slot's own default answers.
    const subject = yield* Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      return yield* resolver.resolve(userPrincipal);
    });
    yield* put(strings, [subject.id, String(subject.roles.size), String(subject.permissions.size)]);
  });

  Then(
    "it resolves to the {string} default, granting no roles and no permissions beyond the subject's own id",
    function* (label: string) {
      assert.equal(label, "identity only");
      assert.deepEqual(yield* take(strings), ["user:u-1", "0", "0"]);
    },
  );

  Given("the {string} slot's declared default value", function* (slot: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(slot, "SubjectResolver");
  });

  When("the default is compared against any plugin's explicit {string} override", function* (_slot: string) {
    const defaultSubject = yield* Effect.flatMap(SubjectResolver.SubjectResolver, (resolver) =>
      resolver.resolve(userPrincipal),
    );
    const overridden = yield* Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      return yield* resolver.resolve(userPrincipal);
    }).pipe(Effect.provide(grantingResolver));
    const rolesCovered = [...defaultSubject.roles].every((role) => overridden.roles.has(role));
    const permissionsCovered = [...defaultSubject.permissions].every((permission) =>
      overridden.permissions.has(permission),
    );
    yield* put(strings, [
      String(defaultSubject.roles.size),
      String(defaultSubject.permissions.size),
      String(overridden.roles.size),
      String(overridden.permissions.size),
      String(rolesCovered && permissionsCovered),
    ]);
  });

  Then(
    "the default is at least as restrictive as any explicit override",
    function* () {
      const [defaultRoles, defaultPermissions, overrideRoles, overridePermissions, covered] =
        yield* take(strings);
      assert.equal(defaultRoles, "0");
      assert.equal(defaultPermissions, "0");
      // The override really does grant more, so the comparison is not vacuous.
      assert.notEqual(overrideRoles, "0");
      assert.notEqual(overridePermissions, "0");
      assert.equal(covered, "true");
    },
  );

  Given("a plugin {string} that overrides the {string} slot", function* (plugin: string, slot: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.deepEqual([plugin, slot], ["Roles", "SubjectResolver"]);
  });

  When("{string}'s Layer is built with its {string} claim", function* (_plugin: string, registry: string) {
    assert.equal(registry, "SlotsRegistry");
    const claimed = yield* Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const subject = yield* resolver.resolve(userPrincipal);
      const registered = yield* Effect.flatMap(Slots.SlotsRegistry, (registry) => registry.claimed);
      return [subject.id, ...registered.map((entry) => `${entry.slot}=${entry.owner}`)];
    }).pipe(Effect.provide(Auth.make([RolesFixture]).layer));
    yield* put(strings, claimed);
  });

  Then("{string} resolves to {string}'s implementation", function* (_slot: string, _plugin: string) {
    const [subjectId, claim] = yield* take(strings);
    assert.equal(subjectId, "user:u-1");
    // The override is recorded against the overriding plugin — that is what makes it observable.
    assert.equal(claim, `${SubjectResolver.SubjectResolver.key}=roles`);
  });

  Then(
    "a second plugin also overriding {string} is thereby detectable pairwise \\(BEH-EA-012\\)",
    function* (_slot: string) {
      const conflict = yield* Effect.scoped(
        Layer.build(Auth.make([RolesFixture, OrganizationFixture]).layer),
      ).pipe(Effect.flip);
      assert.equal(conflict._tag, "SlotConflict");
      assert.equal(conflict.firstOwner, "roles");
      assert.equal(conflict.secondOwner, "organization");
    },
  );

  // ---- BEH-EA-022: veto ----

  const runVeto = <R>(
    taps: Layer.Layer<never, never, BeforeSignUp>,
    email: string,
    then: (result: SignUpInput) => Effect.Effect<void, never, R>,
  ) =>
    Effect.gen(function* () {
      const point = yield* BeforeSignUp;
      const result = yield* point.run(signUp(email));
      yield* then(result);
    }).pipe(Effect.provide(taps.pipe(Layer.provideMerge(BeforeSignUp.layer))));

  Given(
    "a {string} hook point {string} tapped by {string}, which fails with {string} when the email does not end in {string}",
    function* (kind: string, point: string, tap: string, failure: string, suffix: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([kind, point, tap, failure, suffix], [
        "veto",
        "BeforeSignUp",
        "CompanyEmail",
        "HookAbort",
        "@acme.com",
      ]);
      assert.equal(BeforeSignUp.kind, "veto");
    },
  );

  When("{string} fires for an input whose email ends in {string}", function* (_point: string, suffix: string) {
    const CompanyEmail = BeforeSignUp.tap((input) =>
      input.email.endsWith("@acme.com")
        ? Effect.succeed(input)
        : Effect.fail(new HookPoint.HookAbort({ code: "EMAIL_DOMAIN_NOT_ALLOWED" })),
    );
    const failure = yield* runVeto(CompanyEmail, `x${suffix}`, () => Effect.void).pipe(Effect.flip);
    yield* put(abort, { tag: failure._tag, code: failure.code });
  });

  Then("the operation is aborted with the typed {string} {string}", function* (tag: string, code: string) {
    assert.deepEqual(yield* take(abort), { tag, code });
  });

  Given(
    "a {string} hook point {string} tapped by a plugin that transforms the input and does not abort",
    function* (kind: string, point: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([kind, point], ["veto", "BeforeSignUp"]);
    },
  );

  When("{string} fires", function* (_point: string) {
    const laterTapSaw = yield* Ref.make("");
    const Lowercase = BeforeSignUp.tap((input) => Effect.succeed(signUp(input.email.toLowerCase())), {
      order: 0,
    });
    const Recorder = BeforeSignUp.tap(
      (input) => Ref.set(laterTapSaw, input.email).pipe(Effect.as(input)),
      { order: 1 },
    );
    const operationSaw = yield* Ref.make("");
    yield* runVeto(
      Layer.merge(Lowercase, Recorder),
      "MixedCase@Example.COM",
      (result) => Ref.set(operationSaw, result.email),
    );
    yield* put(strings, [yield* Ref.get(laterTapSaw), yield* Ref.get(operationSaw)]);
  });

  Then("later taps observe the transformed value", function* () {
    assert.equal((yield* take(strings))[0], "mixedcase@example.com");
  });

  Then("the operation itself observes the transformed value", function* () {
    assert.equal((yield* take(strings))[1], "mixedcase@example.com");
  });

  Given(
    "a {string} hook point tapped by plugin {string} \\(declared order {int}\\), plugin {string} \\(declared order {int}, depends on {string}\\), and plugin {string} \\(declared order {int}\\)",
    function* (kind: string, b: string, bOrder: number, a: string, aOrder: number, dep: string, c: string, cOrder: number) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([kind, b, bOrder, a, aOrder, dep, c, cOrder], ["veto", "B", 2, "A", 1, "B", "C", 1]);
    },
  );

  When("the hook point fires", function* () {
    const ran = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (id: string) => (input: SignUpInput) =>
      Ref.update(ran, (existing) => [...existing, id]).pipe(Effect.as(input));
    const ownerB = owner("B");
    const ownerA = owner("A", [ownerB]);
    const ownerC = owner("C");
    // Registered in a scrambled order on purpose: only the ordering rule may decide the outcome.
    const taps = Layer.mergeAll(
      BeforeSignUp.tap(record("A"), { order: 1, owner: ownerA }),
      BeforeSignUp.tap(record("C"), { order: 1, owner: ownerC }),
      BeforeSignUp.tap(record("B"), { order: 2, owner: ownerB }),
    );
    yield* runVeto(taps, "a@example.com", () => Effect.void);
    yield* put(strings, yield* Ref.get(ran));
  });

  Then(
    "taps run in an order that places {string} before {string} \\(dependency order\\)",
    function* (first: string, second: string) {
      const order = yield* take(strings);
      assert.ok(order.indexOf(first) < order.indexOf(second), order.join(","));
    },
  );

  Then(
    "among taps with no dependency relationship, taps run by declared {string} and then by plugin id",
    function* (key: string) {
      assert.equal(key, "order");
      // C (order 1) before B (order 2) although B is registered last and depends on nothing;
      // and A follows its dependency B even though its own order (1) is lower.
      assert.deepEqual(yield* take(strings), ["C", "B", "A"]);
    },
  );

  // ---- BEH-EA-023: observe and divert ----

  Given(
    "an {string} hook point {string} tapped by {string}, which throws while sending a welcome email",
    function* (kind: string, point: string, tap: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([kind, point, tap], ["observe", "AfterSignIn", "Welcome"]);
      assert.equal(AfterSignIn.kind, "observe");
    },
  );

  When("{string} fires after a successful sign-in", function* (_point: string) {
    const auditRan = yield* Ref.make(false);
    const Welcome = AfterSignIn.tap(() => Effect.fail("smtp is down"), { order: 0 });
    const Audit = AfterSignIn.tap(() => Ref.set(auditRan, true), { order: 1 });
    // The "operation": a sign-in that succeeds, then fires the observe point.
    const operation = Effect.gen(function* () {
      const point = yield* AfterSignIn;
      const signedIn = "signed-in";
      yield* point.run(signUp("a@example.com"));
      return signedIn;
    }).pipe(
      Effect.provide(
        Layer.merge(Welcome, Audit).pipe(Layer.provideMerge(AfterSignIn.layer), Layer.merge(silent)),
      ),
    );
    const result = yield* Effect.exit(operation);
    yield* put(strings, [
      result._tag === "Success" ? result.value : "failed",
      String(yield* Ref.get(auditRan)),
    ]);
  });

  Then("the sign-in operation still succeeds", function* () {
    assert.equal((yield* take(strings))[0], "signed-in");
  });

  Then("{string}'s failure is isolated from the operation's outcome", function* (_tap: string) {
    // Not only the operation: the tap after the failing one still ran.
    assert.equal((yield* take(strings))[1], "true");
  });

  Given(
    "a {string} hook point tapped by a plugin that turns an ordinary sign-in into a {string} outcome",
    function* (kind: string, outcomeName: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([kind, outcomeName], ["divert", "TwoFactorRequired"]);
      assert.equal(SignInDivert.kind, "divert");
    },
  );

  When(
    "the divert tap returns {string} instead of the operation's ordinary success value",
    function* (outcomeName: string) {
      assert.equal(outcomeName, "TwoFactorRequired");
      const TwoFactor = SignInDivert.tap(() =>
        Effect.succeed(Option.some(new SignInOutcome({ tag: "TwoFactorRequired" }))),
      );
      const result = yield* Effect.gen(function* () {
        const point = yield* SignInDivert;
        return yield* point.run(signUp("a@example.com"));
      }).pipe(Effect.provide(TwoFactor.pipe(Layer.provideMerge(SignInDivert.layer))));
      yield* put(outcome, result);
    },
  );

  Then("the caller receives {string} as a typed alternative outcome", function* (name: string) {
    const result = yield* take(outcome);
    assert.equal(result._tag, "Diverted");
    if (result._tag !== "Diverted") return;
    assert.ok(result.value instanceof SignInOutcome);
    assert.equal(result.value.tag, name);
  });

  Then("the caller is required to handle {string} for the call to type-check", function* (name: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(name, "TwoFactorRequired");
    // `run` returns the two-case `DivertResult`; a caller that leaves "Diverted" unhandled does
    // not compile (`unhandledDivert`'s gate), one that handles both does (`handledDivert`).
    assertTypeGate("divert-must-be-handled", GATES, ["handledDivert", "@ts-expect-error"]);
    assert.equal(typeof unhandledDivert, "function");
  });

  // ---- BEH-EA-024: taps join RIn, registries aggregate and freeze ----

  Given("a plugin {string} that taps the hook point {string}", function* (plugin: string, point: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.deepEqual([plugin, point], ["Invite", "BeforeUserDelete"]);
    assert.equal(Hooks.BeforeUserDelete.kind, "veto");
  });

  When("{string}'s Layer type is inspected", function* (_plugin: string) {
    const built = Auth.make([InviteTapper]);
    yield* put(
      claims,
      (built.manifest.hooks[`awthaq/hook/${Hooks.BeforeUserDelete.id}`] ?? []).map((tap) => ({
        plugin: tap.plugin,
        order: tap.order,
      })),
    );
  });

  Then("{string} appears in {string}'s Layer {string}", function* (point: string, _plugin: string, rin: string) {
    assert.equal(point, "BeforeUserDelete");
    assert.equal(rin, "RIn");
    assertTypeGate("tap-joins-rin", GATES, ["tapPointJoinsRin", "= true"]);
    // The declared tap is also readable statically, with no Layer built.
    assert.deepEqual(yield* take(claims), [{ plugin: "inviteTap", order: 3 }]);
  });

  Given(
    "a plugin {string} that taps a hook point no installed plugin's Layer provides in its ROut",
    function* (plugin: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(plugin, "Invite");
    },
  );

  When("the composed application Layer is type-checked", function* () {
    yield* put(gate, "tap-on-undefined-point-fails");
  });

  Then("it fails to compile", function* () {
    assertTypeGate(yield* take(gate), GATES, ["@ts-expect-error", "Layer.launch(auth.layer)"]);
  });

  Then("the failure is the same shape as a missing-port failure \\(BEH-EA-014\\)", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    // Both gates use the identical construct: an unclosed launch effect over `Layer.Services`.
    assertTypeGate("launch-needs-ports", GATES, [
      "Effect.Effect<never, unknown, never> = Layer.launch(auth.layer)",
    ]);
    assertTypeGate("tap-on-undefined-point-fails", GATES, [
      "Effect.Effect<never, unknown, never> = Layer.launch(auth.layer)",
    ]);
  });

  const ruleFor = (group: string, endpoint: string): RateLimits.RuleInput => ({
    group,
    endpoint,
    key: "ip",
    limit: 5,
    window: "1 minute",
  });
  const ratePlugins = () => ({
    password: { owner: PasswordFixture, input: ruleFor("password", "probe") },
    invite: { owner: InviteOne, input: ruleFor("invite", "list") },
  });

  Given(
    "a registry {string} contributed to by plugin {string} \\(order {int}\\) and plugin {string} \\(order {int}, no dependency relationship\\)",
    function* (registry: string, first: string, firstOrder: number, second: string, secondOrder: number) {
    yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([registry, first, firstOrder, second, secondOrder], [
        "RateLimits",
        "Invite",
        10,
        "Password",
        5,
      ]);
    },
  );

  When("the registry's contributions are aggregated via {string}", function* (via: string) {
    assert.equal(via, "Layer.effectDiscard");
    const { password, invite } = ratePlugins();
    // Installed in the "wrong" order on purpose — `order` decides, not installation sequence.
    const contributions = Layer.mergeAll(
      RateLimits.rule(InviteOne, { ...invite.input, order: 10 }),
      RateLimits.rule(PasswordFixture, { ...password.input, order: 5 }),
    ).pipe(Layer.provideMerge(RateLimits.layer));
    const registered = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(contributions);
        return yield* Context.get(context, RateLimits.RateLimitsRegistry).registered;
      }),
    );
    yield* put(
      claims,
      registered.map((rule) => ({ plugin: rule.plugin, order: rule.order ?? 0 })),
    );
  });

  Then(
    "the aggregated writes are ordered by dependency first, then by declared {string}, then by plugin id",
    function* (key: string) {
      assert.equal(key, "order");
      assert.deepEqual(yield* take(claims), [
        { plugin: "password", order: 5 },
        { plugin: "invite", order: 10 },
      ]);
    },
  );

  Given("a registry {string} that has already been read once by the application", function* (registry: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(registry, "RateLimits");
  });

  When(
    "another plugin's Layer attempts to contribute a new rule to {string} after that first read",
    function* (_registry: string) {
      const { password, invite } = ratePlugins();
      const outcomes = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            RateLimits.rule(PasswordFixture, { ...password.input, order: 5 }).pipe(
              Layer.provideMerge(RateLimits.layer),
            ),
          );
          const registry = Context.get(context, RateLimits.RateLimitsRegistry);
          const first = yield* registry.registered;
          // A late contribution after the first read is refused (a defect: a composition-order bug).
          const late = yield* Effect.exit(registry.register(InviteOne, { ...invite.input, order: 1 }));
          const second = yield* registry.registered;
          return { first, late: late._tag, second };
        }),
      );
      yield* put(strings, [
        String(outcomes.first.length),
        outcomes.late,
        String(outcomes.second.length),
        outcomes.second.map((rule) => rule.plugin).join(","),
      ]);
    },
  );

  Then("the registry's contents no longer change for any subsequent read", function* () {
    // The late rule was refused, and the next read is the frozen first read.
    assert.deepEqual(yield* take(strings), ["1", "Failure", "1", "password"]);
  });
});
