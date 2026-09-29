// AH-003 (decision 36, Tier 2): 18-roles-subject-resolver.feature.
//
// The subject a principal resolves to is awthaq's own contract (the `SubjectResolver` slot, its
// identity-only default, `@awthaq/roles`' exclusive override). What qadi *decides* about a subject
// stays qadi's: where a scenario needs "the evaluator would deny", the real evaluator is run over
// the resolved subject.
import { Api } from "@awthaq/api";
import { Auth, Slots } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { Password } from "@awthaq/password";
import { Roles } from "@awthaq/roles";
import { SubjectResolver } from "@awthaq/qadi";
import { defineSteps } from "@effect-cucumber/vitest";
import {
  AttributeResolver,
  CurrentSubject,
  EvaluationServicesNone,
  anonymous,
  decide,
  exists,
  hasAttribute,
  hasPermission,
  isAllowed,
  makeSubject,
  makeSubjectId,
} from "@qadi/core";
import { SubjectContract } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { Users } from "@awthaq/core";
import { Resolvers } from "@awthaq/qadi";
import {
  CoreLive,
  World,
  adminRole,
  app,
  configure,
  fetchAs,
  fetchOn,
  mintActor,
  outcome,
  projectRead,
  readerRole,
  resolve,
  resolveIn,
  setOutcome,
  setPrincipal,
  signIn,
  startApp,
  userPrincipal,
} from "./QadiBridgeWorld.ts";

const currentSubject = Effect.fn("features.roles.currentSubject")(function* (name = "subject") {
  const world = yield* World;
  return yield* world.subjects.get(name);
});

const keys = (values: ReadonlySet<unknown>) => [...values].map(String).sort();

/** The real evaluator's verdict for `policy` against exactly `subject`, with no ports and no role graph. */
const verdictFor = (subject: Parameters<typeof makeSubject>[0], policy: Parameters<typeof decide>[0]) =>
  decide(policy, { resource: {} }).pipe(
    Effect.provideService(CurrentSubject, makeSubject(subject)),
    Effect.provide(EvaluationServicesNone),
    Effect.orDie,
  );

export const rolesSubjectResolverSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-137: the slot defaults to identity-only ----

  const assertNoRolesPlugin = Effect.fn("features.roles.assertNoRolesPlugin")(function* () {
    const world = yield* World;
    assert.equal((yield* Ref.get(world.options)).roles, undefined);
  });

  Given("no plugin overrides the {string} slot", function* (_slot: string) {
    yield* assertNoRolesPlugin();
  });

  Given("no roles-providing plugin is installed", function* () {
    yield* assertNoRolesPlugin();
  });

  const resolveSignedInUser = Effect.fn("features.roles.resolveSignedInUser")(function* () {
    const actor = yield* signIn("user");
    return yield* resolve("subject", userPrincipal(actor.userId));
  });

  When("{string} resolves a signed-in user's principal", function* (_resolver: string) {
    yield* resolveSignedInUser();
  });

  Then("the resulting {string} carries only {string}", function* (_type: string, field: string) {
    assert.equal(field, "id");
    const world = yield* World;
    const actor = yield* world.actors.get("user");
    const subject = yield* currentSubject();
    assert.equal(subject.id, `user:${actor.userId}`);
    assert.equal(subject.roles.size, 0);
    assert.equal(subject.permissions.size, 0);
    assert.deepEqual(Object.keys(subject.attributes), []);
  });

  Then(
    "the resulting {string}'s {string} and {string} are empty",
    function* (_type: string, roles: string, permissions: string) {
      const subject = yield* currentSubject();
      assert.equal(roles, "roles");
      assert.equal(permissions, "permissions");
      assert.equal(subject.roles.size, 0);
      assert.equal(subject.permissions.size, 0);
    },
  );

  Then("no role or permission is invented for the subject", function* () {
    const subject = yield* currentSubject();
    assert.deepEqual([...subject.roles], []);
    assert.deepEqual([...subject.permissions], []);
  });

  Given(
    "no roles plugin is installed, so the default {string} produces an {string} with empty {string} and empty {string}",
    function* (_slot: string, _type: string, _roles: string, _permissions: string) {
      yield* assertNoRolesPlugin();
      const subject = yield* resolveSignedInUser();
      assert.equal(subject.roles.size, 0);
      assert.equal(subject.permissions.size, 0);
    },
  );

  Given(
    "qadi's evaluator would return a Deny decision for a policy requiring any permission, evaluated against that subject",
    function* () {
      const subject = yield* currentSubject();
      const verdict = yield* verdictFor(
        { id: subject.id, roles: [...subject.roles], permissions: [...subject.permissions] },
        hasPermission(projectRead),
      );
      assert.equal(isAllowed(verdict), false);
    },
  );

  When("a permission-gated policy is evaluated for that subject", function* () {
    const subject = yield* currentSubject();
    const verdict = yield* verdictFor(
      { id: subject.id, roles: [...subject.roles], permissions: [...subject.permissions] },
      hasPermission(projectRead),
    );
    yield* setOutcome("allowed", isAllowed(verdict));
    yield* setOutcome("reason", isAllowed(verdict) ? "" : verdict.reason);
  });

  Then(
    "the Deny decision follows from the subject carrying no permissions",
    function* () {
      const subject = yield* currentSubject();
      assert.equal(yield* outcome("allowed"), false);
      assert.equal(subject.permissions.size, 0);
      assert.match(String(yield* outcome("reason")), /permission|project/i);
    },
  );

  Then(
    "no implicit {string} default is applied anywhere in awthaq's own resolution",
    function* (_default: string) {
      // Not a wildcard, not a stand-in identity: the subject is the user's own id with nothing granted.
      const subject = yield* currentSubject();
      const world = yield* World;
      const actor = yield* world.actors.get("user");
      assert.equal(subject.id, `user:${actor.userId}`);
      assert.equal(subject.permissions.size, 0);
      assert.equal(subject.roles.size, 0);
    },
  );

  // ---- BEH-EA-138: Roles overrides the slot exclusively ----

  Given(
    "a plugin tuple containing {string}, {string}, and {string}, where only {string} overrides the {string} slot",
    function* (a: string, b: string, c: string, _owner: string, _slot: string) {
      yield* Effect.void;
      assert.deepEqual([a, b, c], ["Password", "Organization", "Roles"]);
    },
  );

  When("{string} composes the tuple", function* (_make: string) {
    const built = Auth.make([Password.Password, Organization.Organization, Roles.Roles]);
    yield* setOutcome("composed", built.manifest.plugins.map((plugin) => plugin.id).join(","));
  });

  Then("composition succeeds", function* () {
    assert.equal(yield* outcome("composed"), "password,organization,roles");
  });

  Given(
    "a plugin tuple containing {string} and {string}, both overriding the {string} slot",
    function* (a: string, b: string, _slot: string) {
      yield* Effect.void;
      assert.deepEqual([a, b], ["Roles", "Organization"]);
    },
  );

  // Roles' real layer claims the exclusive slot; Organization is the second claimant (its own layer
  // does not override the slot today, so the exclusivity mechanism is exercised with it as the owner).
  const buildBothClaimants = Effect.fn("features.roles.buildBothClaimants")(function* () {
    const claimants = Layer.mergeAll(
      Roles.Roles.layer.pipe(Layer.provide(Roles.config([]))),
      Slots.override(
        Organization.Organization,
        SubjectResolver.SubjectResolver,
        Effect.succeed({
          resolve: (principal: Api.Principal) =>
            Effect.succeed(SubjectResolver.resolveIdentityOnly(principal)),
        }),
      ),
    ).pipe(Layer.provide(CoreLive));
    return yield* Effect.scoped(Layer.build(claimants)).pipe(Effect.exit);
  });

  When("the composition's layers are built with the slots registry provided", function* () {
    const exit = yield* buildBothClaimants();
    yield* setOutcome("conflict", Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "built");
  });

  When("an application attempts to build and run a server from that tuple", function* () {
    // The only way to serve is to build the layers first; do exactly that, before any request exists.
    const exit = yield* buildBothClaimants();
    yield* setOutcome("conflict", Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "built");
  });

  Then("composition is rejected", function* () {
    const text = String(yield* outcome("conflict"));
    assert.notEqual(text, "built");
    assert.match(text, /SlotConflict/);
  });

  Then(
    "the rejection names {string}, {string}, and {string}",
    function* (a: string, b: string, slot: string) {
      const text = String(yield* outcome("conflict")).toLowerCase();
      assert.ok(text.includes(a.toLowerCase()), `names ${a}`);
      assert.ok(text.includes(b.toLowerCase()), `names ${b}`);
      assert.ok(text.includes(slot.toLowerCase()), `names ${slot}`);
    },
  );

  Then(
    "no server ever starts, because composition already failed while the layers were being built",
    function* () {
      const world = yield* World;
      assert.match(String(yield* outcome("conflict")), /SlotConflict/);
      assert.equal(yield* Ref.get(world.app), undefined, "no application was ever served");
    },
  );

  Then("the conflict is never surfaced as a first-request runtime error", function* () {
    const world = yield* World;
    // The failure is a build-time `SlotConflict`; there is no served handler for a request to fail in.
    assert.match(String(yield* outcome("conflict")), /SlotConflict/);
    assert.equal(yield* Ref.get(world.app), undefined);
  });

  // ---- BEH-EA-139: roles flatten through the DAG once per resolution ----

  const arrangeAlice = Effect.fn("features.roles.arrangeAlice")(function* () {
    yield* configure({ roles: [readerRole, adminRole] });
    return yield* signIn("alice", ["admin"]);
  });

  Given(
    "a user {string} whose assigned roles carry inherited permissions through qadi's role graph",
    function* (_name: string) {
      yield* arrangeAlice();
    },
  );

  When("{string} resolves {string}'s principal", function* (_resolver: string, name: string) {
    const world = yield* World;
    const actor = yield* world.actors.get(name);
    yield* resolve("subject", userPrincipal(actor.userId));
  });

  Then(
    "the resulting {string} carries a {string} set already flattened through the role graph",
    function* (_type: string, _field: string) {
      const subject = yield* currentSubject();
      assert.deepEqual(keys(subject.roles), ["admin", "reader"]);
      // `project:read` is not on `admin` itself: it came through `reader`, via inheritance.
      assert.deepEqual(keys(subject.permissions), ["project:admin", "project:delete", "project:read"]);
    },
  );

  Then("the flattening happens exactly once, during resolution", function* () {
    const world = yield* World;
    const served = yield* app();
    const alice = yield* world.actors.get("alice");
    const resolved = yield* currentSubject();
    // Revoke after resolution: a re-walk at check time would notice; the resolved snapshot does not.
    yield* Effect.promise(() =>
      served.run(
        Effect.gen(function* () {
          const roles = yield* Effect.serviceOption(Roles.Roles);
          if (roles._tag === "Some") yield* roles.value.revoke(alice.userId, "admin");
        }),
      ),
    );
    assert.deepEqual(keys(resolved.permissions), ["project:admin", "project:delete", "project:read"]);
    const again = yield* resolveIn(served, userPrincipal(alice.userId));
    assert.deepEqual(keys(again.permissions), [], "a fresh resolution sees the revocation");
  });

  Given(
    "an {string} whose {string} set was already flattened by {string}",
    function* (_type: string, _field: string, _resolver: string) {
      const alice = yield* arrangeAlice();
      const subject = yield* resolve("subject", userPrincipal(alice.userId));
      assert.ok(subject.permissions.size > 0);
    },
  );

  When("a policy evaluation checks whether the subject holds a permission", function* () {
    const subject = yield* currentSubject();
    // The evaluator gets the permission set and *nothing else*: no roles, no role graph, no ports.
    const verdict = yield* verdictFor(
      { id: subject.id, roles: [], permissions: [...subject.permissions] },
      hasPermission(projectRead),
    );
    yield* setOutcome("allowed", isAllowed(verdict));
  });

  Then(
    "the check is a membership test against the pre-computed {string} set",
    function* (_field: string) {
      assert.equal(yield* outcome("allowed"), true);
    },
  );

  Then("the policy evaluation does not walk the role inheritance graph itself", function* () {
    // The subject handed to the evaluator carried no roles (nothing to walk) and yet the inherited
    // permission granted access: it was found in the flattened set.
    const subject = yield* currentSubject();
    assert.ok(subject.roles.size > 0, "the resolver did flatten roles into the subject");
    assert.equal(yield* outcome("allowed"), true);
  });

  Given(
    "an {string} resolved once for the current request, with permissions already flattened",
    function* (_type: string) {
      yield* configure({ roles: [readerRole, adminRole] });
      yield* signIn("alice", ["admin"]);
    },
  );

  When(
    "the request's handler makes several separate qadi calls, such as {string}, {string}, and {string}, against that subject",
    function* (_a: string, _b: string, _c: string) {
      yield* fetchAs("alice", "/a/multi-call");
    },
  );

  Then(
    "each call performs a set-membership test against the same pre-computed {string}",
    function* (_field: string) {
      const world = yield* World;
      const response = yield* world.responses.get("last");
      assert.equal(response.status, 200);
      const alice = yield* world.actors.get("alice");
      assert.deepEqual(JSON.parse(response.body), [
        `user:${alice.userId}`,
        "check=true",
        "enforce=ok",
        "filter=2",
      ]);
    },
  );

  Then("none of them triggers a fresh role-graph walk", function* () {
    const world = yield* World;
    // The role graph is walked inside `SubjectResolver.resolve`; three qadi calls, one resolution.
    assert.equal(yield* Ref.get(world.resolutions), 1);
  });

  // ---- BEH-EA-140/141: API-key scopes and service scopes become permissions ----

  const apiKey = (scopes: ReadonlyArray<string>, id = "key-1") =>
    new Api.ApiKeyPrincipal({ ref: new Api.PrincipalRef({ type: "apikey", id }), scopes });

  const service = (name: string, scopes: ReadonlyArray<string>) =>
    new Api.ServicePrincipal({ ref: new Api.PrincipalRef({ type: "service", id: name }), scopes });

  Given(
    "an {string} with keyId {string} and scopes [{string}]",
    function* (_type: string, keyId: string, scope: string) {
      yield* setPrincipal(apiKey([scope], keyId));
    },
  );

  Given("an {string} with scopes [{string}]", function* (_type: string, scope: string) {
    yield* setPrincipal(apiKey([scope]));
  });

  Given(
    "an {string} with scopes [{string}], for a key belonging to a user who also holds roles",
    function* (_type: string, scope: string) {
      yield* configure({ roles: [readerRole, adminRole] });
      // A user with roles exists alongside; the key's principal names no user, so nothing links them.
      yield* signIn("owner", ["admin"]);
      yield* setPrincipal(apiKey([scope]));
    },
  );

  const resolveStoredPrincipal = Effect.fn("features.roles.resolveStoredPrincipal")(function* () {
    const world = yield* World;
    const principal = yield* Ref.get(world.principal);
    assert.ok(principal, "a Given constructed a principal");
    return yield* resolve("subject", principal);
  });

  When("{string} resolves the {string}", function* (_resolver: string, _type: string) {
    yield* resolveStoredPrincipal();
  });

  Then("the resulting {string} has id {string}", function* (_type: string, id: string) {
    assert.equal((yield* currentSubject()).id, id);
  });

  Then("{string} equals exactly [{string}]", function* (_field: string, permission: string) {
    assert.deepEqual(keys((yield* currentSubject()).permissions), [permission]);
  });

  Then("{string} contains no permission beyond {string}", function* (_field: string, permission: string) {
    assert.deepEqual(keys((yield* currentSubject()).permissions), [permission]);
  });

  Then("no additional scope is granted beyond what the key was issued with", function* () {
    const world = yield* World;
    const principal = yield* Ref.get(world.principal);
    assert.ok(principal && principal._tag === "ApiKey");
    assert.deepEqual(keys((yield* currentSubject()).permissions), [...principal.scopes].sort());
  });

  Then("the resulting permissions come only from the key's own scopes", function* () {
    assert.deepEqual(keys((yield* currentSubject()).permissions), ["project:read"]);
  });

  Then("the user's role assignments are not consulted", function* () {
    const subject = yield* currentSubject();
    assert.equal(subject.roles.size, 0);
    assert.ok(!keys(subject.permissions).includes("project:delete"));
  });

  Given(
    "a {string} named {string} with declared scopes [{string}]",
    function* (_type: string, name: string, scope: string) {
      yield* setPrincipal(service(name, [scope]));
    },
  );

  Given(
    "a {string} named {string} with its own declared scopes, resolved within a background job with no associated user or API key",
    function* (_type: string, name: string) {
      yield* setPrincipal(service(name, ["reports:read"]));
    },
  );

  Then("the resolved permissions come only from the service's own declared scopes", function* () {
    assert.deepEqual(keys((yield* currentSubject()).permissions), ["reports:read"]);
  });

  Then("no user or API-key subject data is borrowed or consulted", function* () {
    const subject = yield* currentSubject();
    assert.ok(subject.id.startsWith("service:"));
    assert.equal(subject.roles.size, 0);
    assert.deepEqual(Object.keys(subject.attributes), []);
  });

  // ---- BEH-EA-142: impersonation is a static subject attribute ----

  Given("a {string} carrying {string}", function* (_type: string, _actingAs: string) {
    yield* setPrincipal(userPrincipal("user-1", { type: "user", id: "admin-1" }));
  });

  When("{string} resolves that principal", function* (_resolver: string) {
    yield* resolveStoredPrincipal();
  });

  Then("the resulting {string} equals {string}", function* (_path: string, expected: string) {
    const match = /type: '(\w+)', id: '([\w-]+)'/.exec(expected);
    assert.ok(match, "the scenario names a { type, id } value");
    assert.deepEqual((yield* currentSubject()).attributes["actingAs"], {
      type: match[1],
      id: match[2],
    });
  });

  Given("a policy that branches on whether the caller is impersonating another user", function* () {
    yield* setPrincipal(userPrincipal("user-1", { type: "user", id: "admin-1" }));
  });

  When("that policy reads the {string} value for evaluation", function* (_name: string) {
    const subject = yield* resolveStoredPrincipal();
    let resolverCalls = 0;
    const spy = Layer.succeed(
      AttributeResolver,
      AttributeResolver.of({
        name: "spy",
        resolve: () =>
          Effect.sync(() => {
            resolverCalls += 1;
            return undefined;
          }),
      }),
    );
    const verdict = yield* decide(hasAttribute("actingAs", exists()), { resource: {} }).pipe(
      Effect.provideService(CurrentSubject, subject),
      Effect.provide(Layer.mergeAll(EvaluationServicesNone, spy)),
      Effect.orDie,
    );
    yield* setOutcome("allowed", isAllowed(verdict));
    yield* setOutcome("resolverCalls", resolverCalls);
  });

  Then("it reads {string} from the subject's static {string}", function* (_name: string, _where: string) {
    // The policy was satisfied by the value already on the subject.
    assert.equal(yield* outcome("allowed"), true);
    assert.deepEqual((yield* currentSubject()).attributes["actingAs"], { type: "user", id: "admin-1" });
  });

  Then("no {string} round-trip is made to obtain it", function* (_resolver: string) {
    assert.equal(yield* outcome("resolverCalls"), 0);
  });

  Given(
    "a subject attribute that can change independently of the current session, such as a subscription plan",
    function* () {
      // `emailVerified` is the shipped resolver-backed attribute that changes on its own (a mailed link).
      const served = yield* app();
      const actor = yield* mintActor(served, "member");
      const world = yield* World;
      yield* world.actors.set("member", actor);
      yield* resolve("subject", userPrincipal(actor.userId));
    },
  );

  When("a policy needs that attribute's current value", function* () {
    const world = yield* World;
    const served = yield* app();
    const actor = yield* world.actors.get("member");
    const subjectId = `user:${actor.userId}`;
    const readEmailVerified = Effect.gen(function* () {
      const resolver = yield* AttributeResolver;
      return yield* resolver.resolve(makeSubjectId(subjectId), "emailVerified");
    }).pipe(Effect.provide(Resolvers.UserAttributes));
    const before = yield* Effect.promise(() => served.run(readEmailVerified));
    yield* Effect.promise(() =>
      served.run(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          yield* users.verifyEmail(actor.userId);
        }),
      ),
    );
    const after = yield* Effect.promise(() => served.run(readEmailVerified));
    yield* setOutcome("before", before);
    yield* setOutcome("after", after);
  });

  Then(
    "it is resolved through {string}, not placed statically on the subject the way {string} is",
    function* (_resolver: string, _static: string) {
      // The session's subject (resolved at sign-in) carries no such attribute...
      const subject = yield* currentSubject();
      assert.equal("emailVerified" in subject.attributes, false);
      // ...while the resolver answers the live value, which moved without the session changing.
      assert.equal(yield* outcome("before"), false);
      assert.equal(yield* outcome("after"), true);
    },
  );

  // ---- BEH-EA-143: no credential resolves to qadi's anonymous subject ----

  Given("{string} is {string}", function* (_service: string, _principal: string) {
    yield* setPrincipal(Api.anonymousPrincipal);
  });

  When("{string} resolves the principal", function* (_resolver: string) {
    yield* resolveStoredPrincipal();
  });

  Then("the resulting subject is qadi's canonical {string} subject", function* (_name: string) {
    assert.strictEqual(yield* currentSubject(), anonymous);
  });

  Then("no awthaq-specific representation of {string} is synthesized", function* (_none: string) {
    const subject = yield* currentSubject();
    assert.strictEqual(subject, anonymous);
    assert.equal(subject.id, "anonymous");
  });

  Then(
    "the same {string} subject value that any other qadi-fronted service produces is used",
    function* (_name: string) {
      assert.deepEqual(yield* currentSubject(), anonymous);
    },
  );

  Given("a request with no credential at all", function* () {
    yield* configure({ roles: [readerRole, adminRole] });
  });

  When("{string} resolves {string} for that request", function* (_resolver: string, _principal: string) {
    // Path B's extractor resolves the raw, credential-less request; the evaluator sees the result.
    yield* fetchAs(undefined, "/b/read");
  });

  Then(
    "the same {string} subject value reaches qadi's evaluator that any other qadi-fronted service would have produced",
    function* (_name: string) {
      const world = yield* World;
      const decisions = yield* Ref.get(world.decisions);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.subjectId, anonymous.id);
      assert.equal(decisions[0]?.verdict, "Deny");
    },
  );

  // ---- BEH-EA-144: the session view exposes the resolved subject ----

  const decodeDto = Schema.decodeUnknownSync(SubjectContract.SubjectDto);

  Given("a signed-in user {string}", function* (name: string) {
    yield* signIn(name);
  });

  Given("a signed-in user {string} and no roles plugin installed", function* (name: string) {
    yield* signIn(name);
  });

  When("{string} requests {string}", function* (name: string, route: string) {
    yield* fetchAs(name, route.replace(/^GET /, ""));
  });

  Then("the response body is the resolved subject", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 200);
    const dto = decodeDto(JSON.parse(response.body));
    const alice = yield* world.actors.get("alice");
    assert.equal(dto.id, `user:${alice.userId}`);
  });

  Then(
    "the body is encoded as {string} with {string} and {string} as plain arrays",
    function* (_type: string, _roles: string, _permissions: string) {
      const world = yield* World;
      const body = JSON.parse((yield* world.responses.get("last")).body);
      assert.ok(Array.isArray(body.roles));
      assert.ok(Array.isArray(body.permissions));
    },
  );

  Then("the response still includes the resolved subject", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 200);
    assert.equal(decodeDto(JSON.parse(response.body)).id.startsWith("user:"), true);
  });

  Then(
    "{string} and {string} are present as empty arrays, not omitted",
    function* (roles: string, permissions: string) {
      const world = yield* World;
      const body = JSON.parse((yield* world.responses.get("last")).body);
      assert.deepEqual(body[roles.replace("subject.", "")], []);
      assert.deepEqual(body[permissions.replace("subject.", "")], []);
    },
  );

  Given("two applications, one with a roles plugin installed and one without", function* () {
    const world = yield* World;
    yield* world.apps.set("with roles", yield* startApp({ roles: [readerRole, adminRole] }));
    yield* world.apps.set("without roles", yield* startApp({}));
  });

  When("each requests {string} for a signed-in user", function* (route: string) {
    const world = yield* World;
    for (const name of ["with roles", "without roles"]) {
      const served = yield* world.apps.get(name);
      const actor = yield* mintActor(served, "member", name === "with roles" ? ["reader"] : []);
      const captured = yield* fetchOn(served, actor.cookie, route.replace(/^GET /, ""));
      yield* world.responses.set(name, captured);
    }
  });

  Then(
    "both responses include a resolved subject with the same shape",
    function* () {
      const world = yield* World;
      const shape = (label: string) =>
        world.responses.get(label).pipe(
          Effect.map((response) => {
            assert.equal(response.status, 200);
            const dto = decodeDto(JSON.parse(response.body));
            return Object.keys(dto).sort();
          }),
        );
      assert.deepEqual(yield* shape("with roles"), yield* shape("without roles"));
    },
  );

  Then(
    "the client's subject derivation can rely on that field being present regardless of which plugins are installed",
    function* () {
      const world = yield* World;
      for (const label of ["with roles", "without roles"]) {
        const dto = decodeDto(JSON.parse((yield* world.responses.get(label)).body));
        assert.ok(Array.isArray(dto.roles) && Array.isArray(dto.permissions));
      }
    },
  );
});
