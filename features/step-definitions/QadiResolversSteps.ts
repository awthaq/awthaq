// AH-003 (decision 36, Tier 2): 21-qadi-resolvers-obligations.feature.
//
// awthaq's contributions to qadi's evaluation (its user-table `AttributeResolver`, the organization
// `RelationshipResolver`, the `reauth` obligation handler, the audit `DecisionSink`) are exercised
// through the real qadi evaluator. INV-EA-012 is the through-line: a resolver failure is a typed
// error, never a silent denial.
import { Api } from "@awthaq/api";
import { Auth, AuthEvents, AuthPlugin, Sessions, Slots, Users } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { DecisionLogging, Resolvers } from "@awthaq/qadi";
import { defineSteps } from "@effect-cucumber/vitest";
import {
  AttributeResolver,
  CurrentSubject,
  EvaluationServicesNone,
  RelationshipResolver,
  allOf,
  decide,
  enforce,
  hasPermission,
  hasRelationship,
  isAllowed,
  makeResourceId,
  makeSubject,
  makeSubjectId,
  obliged,
  relationshipResolverFromEdges,
} from "@qadi/core";
import { NO_RESOURCE, SubjectExtractor, reauthCheck } from "@qadi/http";
import { Roles } from "@awthaq/roles";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import assert from "node:assert/strict";
import {
  CoreLive,
  World,
  app,
  configure,
  fetchAs,
  inDomain,
  mintActor,
  outcome,
  projectAdmin,
  adminRole,
  readerRole,
  setOutcome,
  signIn,
} from "./QadiBridgeWorld.ts";
import { organizationFixture } from "./QadiOrganizationFixture.ts";

// ---- BEH-EA-161: the user-table resolver ----

/** A `Users` whose every read is down (a store outage), as `packages/qadi/test/Resolvers.test.ts` builds one. */
const DyingUsers = Layer.succeed(Users.Users, {
  create: () => Effect.die("create is not used"),
  createOrGet: () => Effect.die("createOrGet is not used"),
  findById: () => Effect.die(new Error("users store is down")),
  findByEmail: () => Effect.die("findByEmail is not used"),
  findByPhone: () => Effect.die("findByPhone is not used"),
  updateProfile: () => Effect.die("updateProfile is not used"),
  verifyEmail: () => Effect.die("verifyEmail is not used"),
  verifyPhone: () => Effect.die("verifyPhone is not used"),
  promoteIdentity: () => Effect.die("promoteIdentity is not used"),
  changeEmail: () => Effect.die("changeEmail is not used"),
  setStatus: () => Effect.die("setStatus is not used"),
  delete: () => Effect.die("delete is not used"),
  list: () => Effect.die("list is not used"),
});

const askResolver = (subjectId: string, attribute: string) =>
  Effect.gen(function* () {
    const resolver = yield* AttributeResolver;
    return yield* resolver.resolve(makeSubjectId(subjectId), attribute);
  });

const askHealthy = (subjectId: string, attribute: string) =>
  askResolver(subjectId, attribute).pipe(Effect.provide(Resolvers.UserAttributes));

const askDown = (subjectId: string, attribute: string) =>
  askResolver(subjectId, attribute).pipe(
    Effect.provide(Resolvers.UserAttributes.pipe(Layer.provide(DyingUsers))),
  );

const describe = (value: unknown) => (value === undefined ? "undefined" : JSON.stringify(value));

// ---- BEH-EA-163: two plugins, one attribute ----

const BillingApi = HttpApi.make("auth").add(
  HttpApiGroup.make("billing").add(
    HttpApiEndpoint.get("get", "/billing", { success: Schema.Void }),
  ),
);

/** The scenario's "hypothetical Billing plugin": a real plugin (so `Auth.make` composes it) that contributes a `plan` attribute. */
class Billing extends AuthPlugin.Service<Billing, Record<string, never>>()("billing", {
  apiVersion: 1,
  contract: BillingApi,
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(Billing, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(BillingApi, "billing", (handlers) =>
      handlers.handle("get", () => Effect.void),
    ),
  });
}

const planResolver = (name: string, plan: string) =>
  Layer.effect(
    AttributeResolver,
    Effect.succeed(
      AttributeResolver.of({
        name,
        resolve: (_subject, attribute) => Effect.succeed(attribute === "plan" ? plan : undefined),
      }),
    ),
  );

// ---- BEH-EA-167: a broken audit write ----

const BrokenAuditEvents = Layer.effect(
  AuthEvents.AuthEvents,
  Effect.gen(function* () {
    const real = yield* AuthEvents.AuthEvents;
    return {
      ...real,
      publish: () => Effect.die(new Error("audit table unreachable")),
    };
  }),
).pipe(Layer.provide(CoreLive));

const userPrincipal = (userId: string, sessionId: string) =>
  new Api.UserPrincipal({ ref: new Api.PrincipalRef({ type: "user", id: userId }), sessionId });

export const resolversSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-161: attributes resolved from the user table ----

  Given("awthaq's user-table-backed AttributeResolver", function* () {
    // Nothing to build yet: the resolver layer is applied per ask, over whichever `Users` the ask names.
    yield* Effect.void;
  });

  When("it is asked to resolve an attribute it does not recognize for a subject", function* () {
    const served = yield* app();
    const actor = yield* mintActor(served, "member");
    const subject = `user:${actor.userId}`;
    const unrecognized = yield* Effect.promise(() => served.run(askHealthy(subject, "plan")));
    // a recognized attribute on the same subject, so "undefined" can be told apart from "no answer at all"
    const recognized = yield* Effect.promise(() =>
      served.run(askHealthy(subject, "emailVerified")),
    );
    yield* setOutcome("unrecognized", describe(unrecognized));
    yield* setOutcome("recognized", describe(recognized));
  });

  Then("it returns undefined", function* () {
    assert.equal(yield* outcome("unrecognized"), "undefined");
  });

  Then(
    `undefined is understood to mean only "this resolver has no opinion on this attribute"`,
    function* () {
      // The same resolver does hold opinions (a real boolean for a recognized attribute): `undefined`
      // is what it says about *this* attribute, not what it says about everything.
      assert.equal(yield* outcome("recognized"), "false");
    },
  );

  Given(
    "the user table is unreachable while resolving the {string} attribute for a subject",
    function* (attribute: string) {
      yield* setOutcome("attribute", attribute);
    },
  );

  Given("the user table is experiencing an outage", function* () {
    yield* setOutcome("attribute", "emailVerified");
  });

  const askWhileDown = Effect.fn("features.resolvers.askWhileDown")(function* (attribute: string) {
    const exit = yield* askDown("user:u-1", attribute).pipe(Effect.exit);
    yield* setOutcome("succeeded", Exit.isSuccess(exit));
    yield* setOutcome("uncaught", Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error) && error.value._tag === "AttributeResolveError") {
        yield* setOutcome("failureTag", error.value._tag);
        yield* setOutcome("failureAttribute", error.value.attribute);
      }
    }
  });

  When("it is asked to resolve that attribute", function* () {
    yield* askWhileDown(String(yield* outcome("attribute")));
  });

  When(
    "it is asked to resolve the {string} attribute for a subject who does have a verified email",
    function* (attribute: string) {
      yield* askWhileDown(attribute);
    },
  );

  Then("it fails with a typed AttributeResolveError naming the attribute", function* () {
    assert.equal(yield* outcome("failureTag"), "AttributeResolveError");
    assert.equal(yield* outcome("failureAttribute"), yield* outcome("attribute"));
  });

  Then("it does not return undefined", function* () {
    assert.equal(yield* outcome("succeeded"), false);
  });

  Then("it does not swallow the failure as an uncaught exception", function* () {
    assert.equal(yield* outcome("uncaught"), false);
  });

  Then("the outage surfaces as a typed AttributeResolveError", function* () {
    assert.equal(yield* outcome("failureTag"), "AttributeResolveError");
  });

  Then(
    `it is never reported the same way as a subject who genuinely has no {string} attribute`,
    function* (_attribute: string) {
      // A healthy resolver answers "no such attribute" with `undefined` *success*; the outage was a failure.
      const served = yield* app();
      const actor = yield* mintActor(served, "member");
      const healthy = yield* Effect.promise(() =>
        served.run(askHealthy(`user:${actor.userId}`, "plan")),
      );
      assert.equal(healthy, undefined);
      assert.equal(yield* outcome("succeeded"), false);
    },
  );

  // ---- BEH-EA-162: relationships resolved from organization membership ----

  Given("awthaq's Organization.relationships resolver", function* () {
    const world = yield* World;
    const context = yield* Layer.build(organizationFixture(world.walk));
    yield* Ref.set(world.organization, context);
  });

  const organizationServices = Effect.fn("features.resolvers.organization")(function* () {
    const world = yield* World;
    const context = yield* Ref.get(world.organization);
    assert.ok(context, "the Organization.relationships resolver was built by a Given");
    return context;
  });

  const owner = new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: "owner-1" }),
    sessionId: "session-owner-1",
  });

  Given("a project that belongs to an organization a subject is a member of", function* () {
    const world = yield* World;
    const context = yield* organizationServices();
    const record = yield* Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      return yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
    }).pipe(Effect.provide(context));
    yield* Ref.update(world.walk.parents, (existing) => ({ ...existing, "project-1": record.id }));
    yield* setOutcome("organizationId", record.id);
  });

  const checkMember = (resourceId: string, subject: string, depth?: number) =>
    Effect.gen(function* () {
      const resolver = yield* RelationshipResolver;
      return yield* resolver.check({
        subjectId: makeSubjectId(subject),
        relation: "member",
        resourceId: makeResourceId(resourceId),
        depth,
      });
    });

  When(
    "it is asked whether the subject has a {string} relation to that project at depth {int}",
    function* (_relation: string, depth: number) {
      const context = yield* organizationServices();
      const member = yield* checkMember("project-1", "user:owner-1", depth).pipe(
        Effect.provide(context),
      );
      const stranger = yield* checkMember("project-1", "user:stranger-1", depth).pipe(
        Effect.provide(context),
      );
      yield* setOutcome("member", member);
      yield* setOutcome("stranger", stranger);
    },
  );

  Then("it walks from the project to its owning organization", function* () {
    const world = yield* World;
    assert.ok((yield* Ref.get(world.walk.consulted)).includes("project-1"));
  });

  Then("it checks the subject's membership in that organization", function* () {
    // The walk led to the organization, and membership *there* decided: the member is related, a stranger is not.
    assert.equal(yield* outcome("member"), "Related");
    assert.equal(yield* outcome("stranger"), "Unrelated");
  });

  Given(
    "the organization-membership lookup fails while walking from a resource to its owning organization",
    function* () {
      const world = yield* World;
      yield* Ref.set(world.walk.failing, true);
    },
  );

  When(
    "it is asked to check a {string} relation for a subject against that resource",
    function* (_relation: string) {
      const context = yield* organizationServices();
      const exit = yield* checkMember("project-1", "user:owner-1", 2).pipe(
        Effect.provide(context),
        Effect.exit,
      );
      yield* setOutcome("succeeded", Exit.isSuccess(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isSome(error) && error.value._tag === "RelationshipResolveError") {
          yield* setOutcome("failureTag", error.value._tag);
          yield* setOutcome("failureRelation", error.value.relation);
          yield* setOutcome("failureResource", error.value.resourceId);
        }
      }
    },
  );

  Then(
    "it fails with a typed RelationshipResolveError naming the relation and resource",
    function* () {
      assert.equal(yield* outcome("failureTag"), "RelationshipResolveError");
      assert.equal(yield* outcome("failureRelation"), "member");
      assert.equal(yield* outcome("failureResource"), "project-1");
    },
  );

  Then('it does not report "Unrelated"', function* () {
    assert.equal(yield* outcome("succeeded"), false);
  });

  // ---- BEH-EA-163: fixed graphs use relationshipResolverFromEdges ----

  const edges = [{ subjectId: "user:u1", relation: "member", resourceId: "p1" }];

  Given(
    "a fixed set of relationship edges, such as \\{subjectId: {string}, relation: {string}, resourceId: {string}\\}",
    function* (subjectId: string, relation: string, resourceId: string) {
      yield* Effect.void;
      assert.deepEqual(edges, [{ subjectId, relation, resourceId }]);
    },
  );

  When(
    "relationshipResolverFromEdges is provided in place of Organization.relationships",
    function* () {
      const built = yield* Layer.build(relationshipResolverFromEdges(edges));
      const member = yield* checkMember("p1", "user:u1").pipe(Effect.provide(built));
      const other = yield* checkMember("p2", "user:u1").pipe(Effect.provide(built));
      const stranger = yield* checkMember("p1", "user:u2").pipe(Effect.provide(built));
      yield* setOutcome("edge", member);
      yield* setOutcome("otherResource", other);
      yield* setOutcome("otherSubject", stranger);
    },
  );

  Then("it implements the same RelationshipResolver interface", function* () {
    // It was reached as `RelationshipResolver` and answered `check` in the interface's own vocabulary.
    assert.ok(["Related", "Unrelated", "Unknown"].includes(String(yield* outcome("edge"))));
  });

  Then("it answers relation checks against that fixed edge set", function* () {
    assert.equal(yield* outcome("edge"), "Related");
    assert.equal(yield* outcome("otherResource"), "Unrelated");
    assert.equal(yield* outcome("otherSubject"), "Unrelated");
  });

  Given("a policy using hasRelationship", function* () {
    // Narrative Given: the policy is built inside the When, next to the resolver under test.
    yield* Effect.void;
  });

  When(
    "it is evaluated once with Organization.relationships providing RelationshipResolver and once with relationshipResolverFromEdges providing it",
    function* () {
      const world = yield* World;
      const context = yield* Effect.gen(function* () {
        yield* Ref.set(world.organization, yield* Layer.build(organizationFixture(world.walk)));
        return yield* organizationServices();
      });
      const record = yield* Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        return yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      }).pipe(Effect.provide(context));

      const policy = hasRelationship("member");
      const evaluateFor = (subject: string, resolver: Layer.Layer<RelationshipResolver>) =>
        decide(policy, { resource: { id: record.id } }).pipe(
          Effect.provideService(CurrentSubject, makeSubject({ id: subject })),
          Effect.provide(Layer.mergeAll(EvaluationServicesNone, resolver)),
          Effect.map(isAllowed),
          Effect.orDie,
        );
      const organizationBacked = Layer.succeedContext(context);
      const edgeBacked = relationshipResolverFromEdges([
        { subjectId: "user:owner-1", relation: "member", resourceId: record.id },
      ]);
      yield* setOutcome("orgMember", yield* evaluateFor("user:owner-1", organizationBacked));
      yield* setOutcome("orgStranger", yield* evaluateFor("user:stranger-1", organizationBacked));
      yield* setOutcome("edgeMember", yield* evaluateFor("user:owner-1", edgeBacked));
      yield* setOutcome("edgeStranger", yield* evaluateFor("user:stranger-1", edgeBacked));
    },
  );

  Then("the policy is written and evaluated the same way in both cases", function* () {
    // One policy value, two backings, identical verdicts for a member and for a stranger.
    assert.equal(yield* outcome("orgMember"), true);
    assert.equal(yield* outcome("edgeMember"), true);
    assert.equal(yield* outcome("orgStranger"), false);
    assert.equal(yield* outcome("edgeStranger"), false);
  });

  Then("it does not need to know or care which implementation is in effect", function* () {
    assert.equal(yield* outcome("orgMember"), yield* outcome("edgeMember"));
    assert.equal(yield* outcome("orgStranger"), yield* outcome("edgeStranger"));
  });

  // ---- two plugins contributing an AttributeResolver for the same attribute ----

  Given(
    "a plugin {string} and a hypothetical plugin {string}, each providing a Layer.effect\\(AttributeResolver, ...) for the {string} attribute",
    function* (_a: string, _b: string, _attribute: string) {
      // Narrative Given: the two plugins are constructed in the When that composes them.
      yield* Effect.void;
    },
  );

  When("{string} composes a tuple containing both plugins", function* (_make: string) {
    const built = Auth.make([Organization.Organization, Billing]);
    yield* setOutcome("plugins", built.manifest.plugins.map((plugin) => plugin.id).join(","));
    // ...and the two contributions build side by side: no slot claims, so no conflict to raise.
    const claimed = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          Layer.mergeAll(
            planResolver("organization", "org-plan"),
            planResolver("billing", "billing-plan"),
          ),
        );
        const registry = yield* Slots.SlotsRegistry;
        return yield* registry.claimed;
      }),
    ).pipe(Effect.provide(Slots.layer));
    yield* setOutcome("claimed", claimed.map((entry) => entry.slot).join(","));
  });

  Then(
    `composition succeeds without naming {string}, {string}, or {string} as a conflict`,
    function* (a: string, b: string, attribute: string) {
      assert.equal(yield* outcome("plugins"), "organization,billing");
      const claimed = String(yield* outcome("claimed"));
      for (const name of [a, b, attribute]) {
        assert.ok(
          !claimed.toLowerCase().includes(name.toLowerCase()),
          `${name} is not a claimed slot`,
        );
      }
    },
  );

  Then(
    "AttributeResolver is not one of awthaq's own declared slots that SlotConflict<P> inspects",
    function* () {
      // qadi's service, not an awthaq slot (`Slots.define` keys are `awthaq/slot/<name>`), and nothing claimed it.
      assert.ok(!AttributeResolver.key.startsWith("awthaq/slot/"));
      assert.equal(yield* outcome("claimed"), "");
    },
  );

  When(
    "both Layers are composed into one application, with {string}'s provided after {string}'s",
    function* (later: string, earlier: string) {
      assert.deepEqual([later, earlier], ["Billing", "Organization"]);
      const composed = Layer.mergeAll(
        planResolver("organization", "org-plan"),
        planResolver("billing", "billing-plan"),
      );
      const reached = yield* askPlan().pipe(Effect.provide(composed));
      yield* setOutcome("reached", reached);
    },
  );

  const askPlan = () =>
    Effect.gen(function* () {
      const resolver = yield* AttributeResolver;
      return `${resolver.name}:${String(yield* resolver.resolve(makeSubjectId("user:u1"), "plan"))}`;
    });

  Then(
    "{string}'s AttributeResolver is the one reachable for the {string} attribute",
    function* (_plugin: string, _attribute: string) {
      assert.equal(yield* outcome("reached"), "billing:billing-plan");
    },
  );

  Then(
    "{string}'s contribution for {string} becomes unreachable with no compiler error naming either plugin",
    function* (_plugin: string, _attribute: string) {
      // Only the later resolver answers; the earlier one's value never appears (and this file compiles).
      assert.ok(!String(yield* outcome("reached")).includes("org-plan"));
    },
  );

  // ---- BEH-EA-165: the reauth obligation ----

  Given(
    "the {string} obligation configured with maxAgeSeconds {int}",
    function* (_name: string, maxAge: number) {
      assert.equal(Resolvers.reauth(maxAge).attributes["maxAgeSeconds"], maxAge);
      yield* setOutcome("maxAgeSeconds", maxAge);
    },
  );

  const arrangeSession = Effect.fn("features.resolvers.arrangeSession")(function* (
    name: string,
    ageSeconds: number,
  ) {
    const arranged = yield* inDomain(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({
          identity: { _tag: "Email", email: `${name}@example.com` },
          name,
        });
        const { session, token } = yield* sessions.issue({ userId: user.id });
        // Time passes after sign-in: `authenticatedAt` is now `ageSeconds` in the past.
        yield* TestClock.adjust(Duration.seconds(ageSeconds));
        return { userId: user.id, sessionId: session.id, token: Redacted.value(token) };
      }),
    );
    yield* setOutcome("userId", arranged.userId);
    yield* setOutcome("sessionId", arranged.sessionId);
    yield* setOutcome("token", arranged.token);
  });

  Given(
    "a signed-in user {string} whose session's authenticatedAt is {int} seconds ago",
    function* (name: string, seconds: number) {
      yield* arrangeSession(name, seconds);
    },
  );

  Given(
    "a signed-in user {string} whose session is otherwise unexpired but whose authenticatedAt is {int} seconds ago",
    function* (name: string, seconds: number) {
      yield* arrangeSession(name, seconds);
      // "otherwise unexpired": the very same credential still verifies as a live session.
      const token = String(yield* outcome("token"));
      const verified = yield* inDomain(
        Sessions.Sessions.pipe(
          Effect.flatMap((sessions) => sessions.verify(Redacted.make(token))),
          Effect.exit,
        ),
      );
      assert.ok(Exit.isSuccess(verified), "the session is still valid");
    },
  );

  const reauthPolicy = Effect.fn("features.resolvers.reauthPolicy")(function* () {
    return obliged(Resolvers.reauth(Number(yield* outcome("maxAgeSeconds"))), allOf([]));
  });

  Given(
    "qadi's evaluator would return an Allow decision carrying the {string} obligation for {string}'s request",
    function* (_obligation: string, _name: string) {
      const userId = String(yield* outcome("userId"));
      const verdict = yield* decide(yield* reauthPolicy(), { resource: {} }).pipe(
        Effect.provideService(CurrentSubject, makeSubject({ id: `user:${userId}` })),
        Effect.provide(EvaluationServicesNone),
        Effect.orDie,
      );
      assert.ok(isAllowed(verdict));
      assert.deepEqual(
        verdict.obligations.map((duty) => duty.id),
        [Resolvers.REAUTH_OBLIGATION_ID],
      );
    },
  );

  When(
    "{string} calls an endpoint enforced with ObligationHandlers.reauth",
    function* (_name: string) {
      const userId = String(yield* outcome("userId"));
      const sessionId = String(yield* outcome("sessionId"));
      const policy = yield* reauthPolicy();
      const exit = yield* inDomain(
        enforce(policy, { onObligations: Resolvers.ObligationHandlers.reauth })(
          Effect.succeed("proceeded"),
        ).pipe(
          Effect.provideService(Api.CurrentPrincipal, userPrincipal(userId, sessionId)),
          Effect.provideService(CurrentSubject, makeSubject({ id: `user:${userId}` })),
          Effect.provide(EvaluationServicesNone),
          Effect.exit,
        ),
      );
      yield* setOutcome("proceeded", Exit.isSuccess(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        yield* setOutcome("failureTag", Option.isSome(error) ? error.value._tag : "defect");
      }
    },
  );

  Then("the reauth obligation discharges", function* () {
    assert.equal(yield* outcome("proceeded"), true);
  });

  Then("the request proceeds", function* () {
    assert.equal(yield* outcome("proceeded"), true);
  });

  Then("discharge fails with a typed re-authentication error", function* () {
    assert.equal(yield* outcome("failureTag"), "ReauthRequired");
  });

  Then("the request does not proceed", function* () {
    assert.equal(yield* outcome("proceeded"), false);
  });

  Then(
    "the session's own current validity does not substitute for authenticatedAt freshness",
    function* () {
      // Valid (asserted in the Given) and yet refused: freshness, not validity, is what discharges.
      assert.equal(yield* outcome("failureTag"), "ReauthRequired");
      const token = String(yield* outcome("token"));
      const verified = yield* inDomain(
        Sessions.Sessions.pipe(
          Effect.flatMap((sessions) => sessions.verify(Redacted.make(token))),
          Effect.exit,
        ),
      );
      assert.ok(Exit.isSuccess(verified));
    },
  );

  // ---- BEH-EA-167 (new): a failing audit write never changes a decision ----

  Given("awthaq's DecisionSinkAudit whose durable audit write fails", function* () {
    yield* setOutcome("sink", "audit-broken");
  });

  Given("qadi's evaluator would return a Deny decision for a request", function* () {
    const verdict = yield* decide(hasPermission(projectAdmin), { resource: {} }).pipe(
      Effect.provideService(CurrentSubject, makeSubject({ id: "user:nobody" })),
      Effect.provide(EvaluationServicesNone),
      Effect.orDie,
    );
    assert.equal(isAllowed(verdict), false);
  });

  When("that request's decision is routed to the sink", function* () {
    const sink = DecisionLogging.DecisionSinkAudit.pipe(Layer.provide(BrokenAuditEvents));
    const verdict = yield* decide(hasPermission(projectAdmin), { resource: {} }).pipe(
      Effect.provideService(CurrentSubject, makeSubject({ id: "user:nobody" })),
      Effect.provide(Layer.mergeAll(EvaluationServicesNone, sink)),
      Effect.orDie,
    );
    yield* setOutcome("routedAllowed", isAllowed(verdict));
    yield* setOutcome("routedTag", verdict._tag);
  });

  Then("the request still receives the Deny decision's outcome unchanged", function* () {
    assert.equal(yield* outcome("routedTag"), "Deny");
    assert.equal(yield* outcome("routedAllowed"), false);
  });

  // ---- BEH-EA-168: the guarded devtools decision stream ----

  Given("decisionStreamRoute is registered behind a policy", function* () {
    yield* configure({ roles: [readerRole, adminRole] });
    const operator = yield* signIn("operator", ["admin"]);
    assert.ok(operator);
    // The route registered itself with the permission registry, like any guarded bare route.
    const registry = yield* fetchAs("operator", "/__permissions");
    assert.equal(registry.status, 200);
    assert.ok(registry.body.includes("/__decisions"));
  });

  Given(
    "qadi's evaluator would return a Deny decision for that policy for a caller with no admin access",
    function* () {
      const verdict = yield* decide(hasPermission(projectAdmin), { resource: {} }).pipe(
        Effect.provideService(CurrentSubject, makeSubject({ id: "user:caller", permissions: [] })),
        Effect.provide(EvaluationServicesNone),
        Effect.orDie,
      );
      assert.equal(isAllowed(verdict), false);
    },
  );

  When("that caller requests the decision stream", function* () {
    yield* signIn("caller", ["reader"]);
    yield* fetchAs("caller", "/__decisions");
  });

  Then("the stream is not opened for them", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 403);
    assert.equal(response.body, "");
  });

  Given(
    "decisionStreamRoute is configured with reauth every {int} seconds",
    function* (_seconds: number) {
      yield* configure({ roles: [readerRole, adminRole] });
      const operator = yield* signIn("operator", ["admin"]);
      assert.ok(operator);
      const registry = yield* fetchAs("operator", "/__permissions");
      assert.ok(registry.body.includes("/__decisions"), "the stream route is mounted");
    },
  );

  Given("a signed-in admin {string} is viewing the stream", function* (name: string) {
    yield* signIn(name, ["admin"]);
  });

  const recheck = Effect.fn("features.resolvers.recheck")(function* (name: string) {
    const world = yield* World;
    const served = yield* app();
    const actor = yield* world.actors.get(name);
    // The same request the stream was opened with: a re-check re-extracts the subject from it.
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/__decisions", { headers: { cookie: actor.cookie } }),
    );
    return yield* Effect.promise(() =>
      served.run(
        Effect.gen(function* () {
          const exit = yield* reauthCheck(request, hasPermission(projectAdmin), NO_RESOURCE).pipe(
            Effect.exit,
          );
          return Exit.isSuccess(exit)
            ? "still-allowed"
            : Cause.findErrorOption(exit.cause).pipe(Option.getOrElse(() => "defect"));
        }),
      ),
    );
  });

  When(
    "{string}'s admin access is revoked and the next {int}-second re-check runs",
    function* (name: string, _seconds: number) {
      const world = yield* World;
      const served = yield* app();
      const actor = yield* world.actors.get(name);
      yield* setOutcome("before", yield* recheck(name));
      yield* Effect.promise(() =>
        served.run(
          Effect.gen(function* () {
            const roles = yield* Effect.serviceOption(Roles.Roles);
            if (Option.isSome(roles)) yield* roles.value.revoke(actor.userId, "admin");
          }),
        ),
      );
      yield* setOutcome("after", yield* recheck(name));
    },
  );

  Then(
    "qadi's evaluator returns a Deny decision for {string} against the stream's guarding policy",
    function* (name: string) {
      const world = yield* World;
      const served = yield* app();
      const actor = yield* world.actors.get(name);
      // Re-resolve alice's subject exactly as the stream's re-check does, then ask the real evaluator.
      const refused = yield* Effect.promise(() =>
        served.run(
          Effect.gen(function* () {
            const extractor = yield* SubjectExtractor;
            const subject = yield* extractor.extract(
              HttpServerRequest.fromWeb(
                new Request("http://localhost/__decisions", { headers: { cookie: actor.cookie } }),
              ),
            );
            return subject;
          }),
        ),
      );
      assert.equal(refused.permissions.size, 0);
      const verdict = yield* decide(hasPermission(projectAdmin), { resource: {} }).pipe(
        Effect.provideService(CurrentSubject, refused),
        Effect.provide(EvaluationServicesNone),
        Effect.orDie,
      );
      assert.equal(isAllowed(verdict), false);
    },
  );

  Then("{string} stops receiving further decisions from the stream", function* (_name: string) {
    // Connected: the re-check allowed. After revocation it fails "denied" — and a failing re-check
    // is what ends the merged stream (`decisionStreamRoute`'s contract).
    assert.equal(yield* outcome("before"), "still-allowed");
    assert.equal(yield* outcome("after"), "denied");
  });
});
