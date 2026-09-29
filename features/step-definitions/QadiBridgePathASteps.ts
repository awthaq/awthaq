// AH-003 (decision 36, Tier 2): 19-qadi-bridge-path-a.feature.
//
// The Path A handlers driven here are the reference patterns in `QadiBridgeWorld.ts` (real
// `@qadi/core` calls over real HTTP). qadi's evaluator is never stubbed: a Given like "the evaluator
// would return a Deny decision for the caller" is *proved* by running the real evaluator against the
// subject and resource the scenario uses.
import { defineSteps } from "@effect-cucumber/vitest";
import {
  CurrentSubject,
  EvaluationServicesNone,
  decide,
  isAllowed,
  makeSubject,
  permissionKey,
} from "@qadi/core";
import type { PermissionKey } from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import assert from "node:assert/strict";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { AuthorizedSubject } from "@awthaq/qadi";
import { Api } from "@awthaq/api";
import {
  CALLER_TENANT,
  FixtureApi,
  PROJECTS,
  World,
  adminRole,
  canDeleteProject,
  canReadProject,
  canReadProjectSummary,
  configure,
  fetchAndKeep,
  fetchAs,
  outcome,
  projectDelete,
  projectRead,
  readerRole,
  sameTenant,
  setOutcome,
  signIn,
} from "./QadiBridgeWorld.ts";

/** "404 Not Found" -> 404: the scenario text names the reason phrase for readers; the code is what is asserted. */
const codeOf = (label: string) => Number.parseInt(label, 10);

/** The real evaluator's verdict for `policy` against `resource` and a subject with `permissions` (no role graph, no I/O). */
const verdictFor = (
  policy: Parameters<typeof decide>[0],
  resource: Readonly<Record<string, unknown>>,
  subjectId = "user:probe",
  permissions: ReadonlyArray<PermissionKey> = [],
) =>
  decide(policy, { resource }).pipe(
    Effect.provideService(CurrentSubject, makeSubject({ id: subjectId, permissions })),
    Effect.provide(EvaluationServicesNone),
    Effect.orDie,
  );

const projectRoute = (id: string) => `/a/projects/${id}`;

/** Which resolver-outage kind a Given arranged, so the shared When can pick the gated endpoint. */
const outageKindOf = (name: string) =>
  name === "AttributeResolveError"
    ? "attribute"
    : name === "RelationshipResolveError"
      ? "relationship"
      : name === "DecisionHistoryUnavailable"
        ? "history"
        : undefined;

export const pathASteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-145: AuthorizedSubject bridges CurrentPrincipal to CurrentSubject ----

  const assertChain = Effect.fn("features.pathA.assertChain")(function* (chain: string) {
    yield* Effect.void;
    // The chain text is the *reading* order; the shipped group declares AuthorizedSubject first and
    // Authentication last so Authentication runs first (AuthorizedSubject.ts header, YL-008).
    assert.match(chain, /Authentication.*AuthorizedSubject/);
    const found: Array<string> = [];
    HttpApi.reflect(FixtureApi, {
      onGroup: () => {},
      onEndpoint: ({ group, middleware }) => {
        if (group.identifier === "authz") {
          for (const service of middleware) found.push(service.key);
        }
      },
    });
    assert.ok(
      found.includes(AuthorizedSubject.AuthorizedSubject.key),
      "group carries AuthorizedSubject",
    );
    assert.ok(found.includes(Api.Authentication.key), "group carries Authentication");
  });

  Given("an endpoint group with middleware {string}", function* (chain: string) {
    yield* assertChain(chain);
  });

  Given("an endpoint group under {string}", function* (chain: string) {
    yield* assertChain(chain);
  });

  When("a signed-in user's request passes through the group's middleware chain", function* () {
    yield* signIn("user");
    yield* fetchAs("user", "/a/whoami");
  });

  When("a handler in the group runs", function* () {
    yield* signIn("user");
    yield* fetchAs("user", "/a/whoami");
  });

  Then(
    '"AuthorizedSubject" reads "CurrentPrincipal" already provided by "Authentication"',
    function* () {
      const world = yield* World;
      const response = yield* world.responses.get("last");
      const user = yield* world.actors.get("user");
      // Reaching the handler at all means Authentication had provided a principal by the time the
      // subject was resolved; the id it resolved is that very principal's user.
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).subjectId, `user:${user.userId}`);
    },
  );

  Then(
    `"AuthorizedSubject" provides qadi's "CurrentSubject" to every handler in the group via "SubjectResolver"`,
    function* () {
      const world = yield* World;
      const user = yield* world.actors.get("user");
      // A second handler of the group sees the same subject...
      const other = yield* fetchAs("user", "/a/repeated-subject");
      assert.equal(other.status, 200);
      assert.equal(JSON.parse(other.body)[0], `user:${user.userId}`);
      // ...and each of the two requests resolved the principal exactly once, through the slot.
      assert.equal(yield* Ref.get(world.resolutions), 2);
    },
  );

  Then('the handler reads "CurrentSubject" as an already-provided environment value', function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    const user = yield* world.actors.get("user");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.subjectId, `user:${user.userId}`);
  });

  Then('the handler performs no "SubjectResolver" call of its own', function* () {
    const world = yield* World;
    // The handler read `CurrentSubject` twice and the request resolved the principal once: the
    // middleware's own call is the only one.
    assert.equal(yield* Ref.get(world.resolutions), 1);
  });

  // ---- BEH-EA-147: cross-tenant denial becomes 404 ----

  const foreignProject = PROJECTS.find((project) => project.tenant !== CALLER_TENANT);

  Given(
    "a resource {string} that exists in a tenant the caller cannot access",
    function* (id: string) {
      yield* Effect.void;
      const project = PROJECTS.find((candidate) => candidate.id === id);
      assert.ok(project, `fixture defines "${id}"`);
      assert.notEqual(project.tenant, CALLER_TENANT);
    },
  );

  Given("a resource id {string} that does not exist anywhere", function* (id: string) {
    yield* Effect.void;
    assert.equal(
      PROJECTS.some((candidate) => candidate.id === id),
      false,
    );
  });

  Given(
    "qadi's evaluator would return a Deny decision for the caller against {string}",
    function* (id: string) {
      const project = PROJECTS.find((candidate) => candidate.id === id);
      assert.ok(project);
      // Both gates the scenarios use deny it: the tenant policy (the resource lives elsewhere) and the
      // permission-gated summary policy (the caller holds no role).
      assert.equal(isAllowed(yield* verdictFor(canReadProject, project)), false);
      assert.equal(isAllowed(yield* verdictFor(canReadProjectSummary, project)), false);
    },
  );

  Given(
    "qadi's evaluator would return a Deny decision for the caller against a tenant-scoped resource requested by id",
    function* () {
      assert.ok(foreignProject);
      const verdict = yield* verdictFor(canReadProject, foreignProject);
      assert.equal(isAllowed(verdict), false);
    },
  );

  When("the caller requests {string} by id", function* (id: string) {
    yield* signIn("caller");
    yield* fetchAs("caller", projectRoute(id));
  });

  When("the handler processes the request", function* () {
    assert.ok(foreignProject);
    yield* signIn("caller");
    yield* fetchAs("caller", projectRoute(foreignProject.id));
  });

  Then("the response is {string}", function* (label: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, codeOf(label));
  });

  Then('the response does not distinguish "denied" from "does not exist"', function* () {
    const world = yield* World;
    const denied = yield* world.responses.get("last");
    const missing = yield* fetchAs("caller", projectRoute("project-999"));
    assert.equal(missing.status, denied.status);
    assert.equal(missing.body, denied.body);
  });

  Then(
    "the response is indistinguishable from the response for a resource that exists in a tenant the caller cannot access",
    function* () {
      assert.ok(foreignProject);
      const world = yield* World;
      const missing = yield* world.responses.get("last");
      const denied = yield* fetchAs("caller", projectRoute(foreignProject.id));
      assert.equal(denied.status, missing.status);
      assert.equal(denied.body, missing.body);
    },
  );

  Then("{string} is mapped to the resource's own not-found error", function* (tag: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(JSON.parse(response.body)._tag, "NotFound");
    assert.ok(!response.body.includes(tag), `the body never names ${tag}`);
  });

  Then('the response is never "403 Forbidden"', function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.notEqual(response.status, 403);
  });

  // ---- BEH-EA-148: resolver outages stay 5xx ----

  Given("qadi's AttributeResolver fails while evaluating a policy for the caller", function* () {
    yield* configure({ outage: "attribute" });
    yield* setOutcome("kind", "attribute");
  });

  Given(
    "qadi's {string} occurs while evaluating a policy for the caller",
    function* (errorName: string) {
      const kind = outageKindOf(errorName);
      assert.ok(kind, `an outage kind for ${errorName}`);
      yield* configure({ outage: kind });
      yield* setOutcome("kind", kind);
    },
  );

  Given(
    'a handler that separately catches "AccessDenied" into 404 and resolver-outage errors into a defect',
    function* () {
      yield* Effect.void;
      // The reference handler is the fixture's `outage` endpoint: denials become NotFound, everything
      // else dies. Pin that it is part of the served contract.
      const paths: Array<string> = [];
      HttpApi.reflect(FixtureApi, {
        onGroup: () => {},
        onEndpoint: ({ endpoint }) => {
          paths.push(endpoint.path);
        },
      });
      assert.ok(paths.includes("/a/outage/:kind"));
    },
  );

  const requestGated = Effect.fn("features.pathA.requestGated")(function* () {
    const kind = yield* outcome("kind");
    yield* signIn("caller");
    yield* fetchAs("caller", `/a/outage/${kind}`);
  });

  When("the caller requests a resource gated by that policy", function* () {
    yield* requestGated();
  });

  When("a resolver-outage error occurs", function* () {
    yield* configure({ outage: "attribute" });
    yield* setOutcome("kind", "attribute");
    yield* requestGated();
  });

  Then("the response is a 5xx server error", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.ok(response.status >= 500 && response.status < 600, `got ${response.status}`);
  });

  Then('the response is never mapped to "403 Forbidden" or "404 Not Found"', function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.notEqual(response.status, 403);
    assert.notEqual(response.status, 404);
  });

  Then('it is not caught by the "AccessDenied" branch', function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    // The AccessDenied branch would have answered 404 NotFound.
    assert.notEqual(response.status, 404);
    assert.ok(!response.body.includes("NotFound"));
  });

  Then("it propagates as a defect", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 500);
  });

  // ---- BEH-EA-149: enforceProjected trims to granted fields ----

  Given(
    `qadi's evaluator would grant access to a subset of {string}'s fields for the caller`,
    function* (id: string) {
      yield* configure({ roles: [readerRole, adminRole] });
      const project = PROJECTS.find((candidate) => candidate.id === id);
      assert.ok(project);
      const verdict = yield* verdictFor(canReadProjectSummary, project, "user:probe", [
        permissionKey(projectRead),
      ]);
      assert.ok(isAllowed(verdict));
      assert.deepEqual(verdict.visibleFields, ["id", "name"]);
    },
  );

  When(
    "the caller requests {string} through a handler using {string}",
    function* (id: string, _call: string) {
      const caller = yield* signIn("caller", ["reader"]);
      assert.ok(caller);
      yield* fetchAs("caller", `${projectRoute(id)}/summary`);
    },
  );

  Then("the returned value is trimmed to exactly the fields the decision granted", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(response.body)).sort(), ["id", "name"]);
  });

  Given(
    `a handler pipeline using "enforceProjected", then the "AccessDenied"-to-not-found mapping, then the resolver-outage-to-defect mapping`,
    function* () {
      yield* configure({ roles: [readerRole, adminRole] });
    },
  );

  When("the caller requests {string}", function* (id: string) {
    // A caller holding no role: the summary policy needs `project:read`, so the evaluator denies.
    yield* signIn("caller");
    yield* fetchAs("caller", `${projectRoute(id)}/summary`);
  });

  Then(`{string}'s field-trimming plays no role in that denial path`, function* (_call: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    for (const field of ["id", "name", "budget", "secret"]) {
      assert.ok(!response.body.includes(`"${field}"`), `no projected field "${field}" in a denial`);
    }
  });

  // ---- BEH-EA-150: filter decides item by item ----

  const expectedAllowed = Effect.fn("features.pathA.expectedAllowed")(function* () {
    const allowed: Array<string> = [];
    for (const project of PROJECTS) {
      const verdict = yield* verdictFor(sameTenant, project);
      if (isAllowed(verdict)) allowed.push(project.id);
    }
    return allowed;
  });

  Given(
    "a caller requesting a list of resources, where qadi's evaluator would return a Deny decision for some items and an Allow decision for others",
    function* () {
      const allowed = yield* expectedAllowed();
      assert.ok(allowed.length > 0 && allowed.length < PROJECTS.length, "a mixed verdict set");
      yield* setOutcome("allowed", allowed);
    },
  );

  Given("a caller requesting a streamed list of resources", function* () {
    const allowed = yield* expectedAllowed();
    yield* setOutcome("allowed", allowed);
  });

  When('the handler serves the list using "filter"', function* () {
    yield* signIn("caller");
    yield* fetchAs("caller", "/a/projects");
  });

  When('the handler serves the stream using "filterStream"', function* () {
    yield* signIn("caller");
    yield* fetchAs("caller", "/a/projects-stream");
  });

  Then("only the items with an Allow decision are included in the response", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), yield* outcome("allowed"));
  });

  Then("items with a Deny decision are dropped before the response is produced", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    for (const project of PROJECTS.filter((candidate) => candidate.tenant !== CALLER_TENANT)) {
      assert.ok(!response.body.includes(project.id), `${project.id} never crosses the wire`);
    }
  });

  Then("each item is decided individually against the policy as it streams", function* () {
    const world = yield* World;
    const decisions = yield* Ref.get(world.decisions);
    assert.equal(decisions.length, PROJECTS.length, "one evaluation per streamed item");
  });

  Then("denied items are dropped from the stream before it reaches the caller", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.deepEqual(JSON.parse(response.body), yield* outcome("allowed"));
  });

  // ---- BEH-EA-151: guard hands the handler an unforgeable witness ----

  Given(
    `a handler deleting {string} where downstream code requires proof of "project.delete" for that specific resource`,
    function* (id: string) {
      yield* configure({ roles: [readerRole, adminRole] });
      const project = PROJECTS.find((candidate) => candidate.id === id);
      assert.ok(project);
      const verdict = yield* verdictFor(canDeleteProject, project, "user:probe", [
        permissionKey(projectDelete),
      ]);
      assert.ok(isAllowed(verdict));
    },
  );

  When("the handler uses {string}", function* (_call: string) {
    yield* signIn("admin", ["admin"]);
    yield* signIn("reader", ["reader"]);
    yield* fetchAs("admin", "/a/projects/project-42/remove");
  });

  Then(
    "the downstream removal function receives an unforgeable witness proving the permission was granted for that resource",
    function* () {
      const world = yield* World;
      const response = yield* world.responses.get("last");
      assert.equal(response.status, 200);
      const executed = yield* Ref.get(world.executed);
      // The removal ran once, and what it received names the permission `guard` proved.
      assert.deepEqual(executed, ["removed:project-42:delete"]);
    },
  );

  Then(
    'the removal cannot be invoked without that witness having been produced by "guard"',
    function* () {
      const world = yield* World;
      // A caller the evaluator denies never reaches the removal: no witness is minted.
      const refused = yield* fetchAs("reader", "/a/projects/project-42/remove");
      assert.equal(refused.status, 404);
      assert.deepEqual(yield* Ref.get(world.executed), ["removed:project-42:delete"]);
    },
  );

  // ---- BEH-EA-152: bare HttpRouter routes use addGuardedRoute ----

  Given(
    `a bare "HttpRouter" route {string} outside "HttpApi" that needs authorization`,
    function* (route: string) {
      yield* configure({ roles: [readerRole, adminRole] });
      assert.equal(route, "GET /projects/:id/export.csv");
    },
  );

  When(
    `the route is registered using "addGuardedRoute" with "project.read" and a policy`,
    function* () {
      // Registration is the fixture's composition; exercise it as a caller holding `project:read`.
      yield* signIn("reader", ["reader"]);
      yield* fetchAs("reader", "/projects/project-7/export.csv");
    },
  );

  Then('the route requires "SubjectExtractor" to supply the subject', function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    const reader = yield* world.actors.get("reader");
    assert.equal(response.status, 200);
    // The subject inside the route is the one the extractor built from the raw request's cookie...
    assert.match(response.body, new RegExp(`subject=user:${reader.userId}`));
    // ...and a request with no credential extracts `anonymous`, which the policy refuses.
    const anonymous = yield* fetchAs(undefined, "/projects/project-7/export.csv");
    assert.equal(anonymous.status, 403);
  });

  Then(
    'a successful decision mints the same kind of witness "guard" produces for handlers inside "HttpApi"',
    function* () {
      const world = yield* World;
      const reader = yield* world.actors.get("reader");
      const served = yield* fetchAs("reader", "/projects/project-7/export.csv");
      // The route's handler received an `Authorized<"project:read">` witness: the same brand `guard` mints.
      assert.match(served.body, /witness=project:read/);
      assert.ok(reader);
    },
  );

  // ---- BEH-EA-152 (second scenario): one application, two plumbings ----

  Given(
    `a contract-shaped endpoint using "AuthorizedSubject" and a bare "HttpRouter" route using "addGuardedRoute" in the same application`,
    function* () {
      yield* configure({ roles: [readerRole, adminRole] });
    },
  );

  When("each is authorized", function* () {
    yield* signIn("alice", ["reader"]);
    yield* fetchAndKeep("contract", "alice", "/a/whoami");
    yield* fetchAndKeep("bare", "alice", "/projects/project-7/export.csv");
  });

  Then(
    `the contract-shaped endpoint is resolved via "AuthorizedSubject"'s "CurrentSubject" and the bare route via "SubjectExtractor"`,
    function* () {
      const world = yield* World;
      const alice = yield* world.actors.get("alice");
      const contract = yield* world.responses.get("contract");
      const bare = yield* world.responses.get("bare");
      assert.equal(JSON.parse(contract.body).subjectId, `user:${alice.userId}`);
      assert.match(bare.body, new RegExp(`subject=user:${alice.userId}`));
      // Both plumbings ran the one resolver slot: once through the middleware, once through the extractor.
      assert.equal(yield* Ref.get(world.resolutions), 2);
    },
  );

  Then("neither route reaches qadi's evaluator through a second, ad hoc check", function* () {
    const world = yield* World;
    const alice = yield* world.actors.get("alice");
    // The contract endpoint gates on the middleware alone and the bare route evaluates its one
    // declared policy once: a single evaluation in the whole application, for alice.
    const decisions = yield* Ref.get(world.decisions);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.subjectId, `user:${alice.userId}`);
    assert.equal(decisions[0]?.policyTag, "AllOf");
    assert.equal(decisions[0]?.verdict, "Allow");
  });
});
