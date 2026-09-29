// AH-003 (decision 36, Tier 2): 20-qadi-bridge-path-b.feature.
//
// Path B is qadi's `RequirePermission` middleware over awthaq's `SubjectExtractor`. Everything
// asserted here is the bridge's own contract: which subject the extractor resolves (and that it
// reuses Authentication's session logic), which statuses a missing annotation / outage / denial end
// in, what the registry route serves. qadi's policy evaluation is real and never stubbed.
import { Authentication } from "@awthaq/server";
import { Sessions, Users } from "@awthaq/core";
import { AuthorizedSubject } from "@awthaq/qadi";
import { defineSteps } from "@effect-cucumber/vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AccessDenied,
  AttributeResolveError,
  CurrentSubject,
  EvaluationServicesNone,
  UndischargedObligation,
  decide,
  hasPermission,
  hasRole,
  isAllowed,
  makeSubject,
  makeSubjectId,
  permissionKey,
} from "@qadi/core";
import type { Permission, Trace } from "@qadi/core";
import {
  PublicEndpoint,
  RequirePermission,
  RequiredPermission,
  SubjectExtractor as QadiSubjectExtractor,
  toResponse,
} from "@qadi/http";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import assert from "node:assert/strict";
import type { OutageKind } from "./QadiBridgeWorld.ts";
import {
  FixtureApi,
  World,
  adminRole,
  configure,
  fetchAs,
  inDomain,
  outcome,
  ownerPolicy,
  projectAdmin,
  projectRead,
  readerRole,
  setOutcome,
  plan,
  setOwner,
  setPlan,
  signIn,
} from "./QadiBridgeWorld.ts";

const denialTrace: Trace = {
  policyTag: "HasPermission",
  allowed: false,
  children: [],
  obligations: [],
};
const attributeOutage: OutageKind = "attribute";

const codeOf = (label: string) => Number.parseInt(label, 10);

interface Declared {
  readonly path: string;
  readonly group: string;
  readonly required: Option.Option<{ readonly permission: Permission; readonly policyTag: string }>;
  readonly publicReason: Option.Option<string>;
}

/** Everything the contract declares, read without executing a handler (BEH-EA-154's point). */
const declared = (): ReadonlyArray<Declared> => {
  const found: Array<Declared> = [];
  HttpApi.reflect(FixtureApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group, mergedAnnotations }) => {
      found.push({
        path: endpoint.path,
        group: group.identifier,
        required: Option.map(Context.getOption(mergedAnnotations, RequiredPermission), (r) => ({
          permission: r.permission,
          policyTag: r.policy._tag,
        })),
        publicReason: Option.map(
          Context.getOption(mergedAnnotations, PublicEndpoint),
          (declaration) => declaration.reason,
        ),
      });
    },
  });
  return found;
};

const endpointAt = (path: string) => {
  const found = declared().find((candidate) => candidate.path === path);
  assert.ok(found, `the fixture contract declares ${path}`);
  return found;
};

/** Path for each "outcome" a scenario names, plus whether it needs a resolver outage configured. */
const outcomeRoute = (name: string) => {
  switch (name) {
    case "an AccessDenied decision":
      return { path: "/b/delete", outage: false };
    case "an UndischargedObligation":
      return { path: "/b/duty", outage: false };
    case "a resolver outage":
      return { path: "/b/plan", outage: true };
    case "a missing annotation":
      return { path: "/b/forgotten", outage: false };
    default:
      throw new Error(`unknown outcome "${name}"`);
  }
};

/** Signs in whoever the Given planned (if anyone) and sends the planned request. */
const runPlan = Effect.fn("features.pathB.runPlan")(function* () {
  const planned = yield* plan();
  if (planned.who !== undefined) yield* signIn(planned.who.name, planned.who.roles);
  yield* fetchAs(planned.who?.name, planned.path);
});

const reader = { name: "user", roles: ["reader"] };

export const pathBSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-153: SubjectExtractor runs session resolution on the raw request ----

  Given(
    "an endpoint middlewared only by qadi's RequirePermission, with SubjectExtractor provided over the raw request",
    function* () {
      yield* configure({ roles: [readerRole, adminRole] });
      // The Path B group carries RequirePermission and *no* awthaq contract middleware.
      const keys: Array<string> = [];
      HttpApi.reflect(FixtureApi, {
        onGroup: () => {},
        onEndpoint: ({ group, middleware }) => {
          if (group.identifier === "gated")
            for (const service of middleware) keys.push(service.key);
        },
      });
      assert.deepEqual(
        keys.filter((key, index) => keys.indexOf(key) === index),
        [RequirePermission.key],
      );
      yield* setPlan({ path: "/b/read", who: reader });
    },
  );

  When("a request reaches that endpoint", function* () {
    yield* runPlan();
  });

  When("any request reaches that endpoint", function* () {
    yield* runPlan();
  });

  Then(
    "SubjectExtractor resolves a subject before any awthaq contract middleware has executed",
    function* () {
      const world = yield* World;
      const user = yield* world.actors.get("user");
      const response = yield* world.responses.get("last");
      // The endpoint's policy needs `project:read`, which only the resolved user subject holds.
      assert.equal(response.status, 200);
      const decisions = yield* Ref.get(world.decisions);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.subjectId, `user:${user.userId}`);
      assert.equal(decisions[0]?.verdict, "Allow");
    },
  );

  Then(
    "it does so without depending on Authentication's own middleware pipeline having run first",
    function* () {
      // Neither awthaq contract middleware is on the group (asserted in the Given) yet the request
      // was authorized above: no Authentication ran, so the extractor did its own resolution.
      const world = yield* World;
      assert.equal((yield* world.responses.get("last")).status, 200);
      assert.equal(
        declared()
          .filter((endpoint) => endpoint.group === "gated")
          .some((endpoint) => endpoint.path.startsWith("/a/")),
        false,
      );
    },
  );

  Given("a request carrying a session credential", function* () {
    const issued = yield* inDomain(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "agree@example.com" },
          name: "Agree",
        });
        const { token } = yield* sessions.issue({ userId: user.id });
        return { userId: user.id, token: Redacted.value(token) };
      }),
    );
    yield* setOutcome("userId", issued.userId);
    yield* setOutcome("token", issued.token);
  });

  When(
    "SubjectExtractor and Authentication's middleware each resolve a session from that credential",
    function* () {
      const userId = String(yield* outcome("userId"));
      const token = String(yield* outcome("token"));
      const dot = token.indexOf(".");
      const sessionId = token.slice(0, dot);
      const secret = token.slice(dot + 1);

      const resolveBoth = (credential: string) =>
        inDomain(
          Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const principals = yield* Authentication.PrincipalResolver;
            const extractor = yield* QadiSubjectExtractor;
            const request = HttpServerRequest.fromWeb(
              new Request("http://localhost/x", {
                headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${credential}` },
              }),
            );
            const viaExtractor = (yield* extractor.extract(request)).id;
            const viaAuthentication = yield* Authentication.resolvePrincipal(
              sessions,
              principals,
              Redacted.make(credential),
              "cookie",
            ).pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
              Effect.map((principal) => `user:${principal.ref.id}`),
              Effect.catchTag("Unauthenticated", () => Effect.succeed("anonymous")),
            );
            return { viaExtractor, viaAuthentication };
          }),
        );

      const cases = {
        valid: yield* resolveBoth(token),
        // same session id, a secret that does not hash to the stored one
        wrongSecret: yield* resolveBoth(
          `${sessionId}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`,
        ),
        unknownSession: yield* resolveBoth(`00000000-0000-0000-0000-000000000000.${secret}`),
        // past the absolute lifetime: the very same credential that was valid above
        expired: yield* Effect.gen(function* () {
          yield* TestClock.adjust(Duration.days(400));
          return yield* resolveBoth(token);
        }),
      };
      yield* setOutcome("cases", cases);
      yield* setOutcome("expectedSubject", `user:${userId}`);
    },
  );

  const casesOutcome = Effect.fn("features.pathB.cases")(function* () {
    const cases = yield* outcome("cases");
    assert.ok(typeof cases === "object" && cases !== null);
    return {
      valid: Reflect.get(cases, "valid"),
      wrongSecret: Reflect.get(cases, "wrongSecret"),
      unknownSession: Reflect.get(cases, "unknownSession"),
      expired: Reflect.get(cases, "expired"),
    };
  });

  Then(
    "both apply the identical hash-comparison and absolute\\/idle-expiry logic over Sessions",
    function* () {
      const cases = yield* casesOutcome();
      const user = String(yield* outcome("expectedSubject"));
      // hash comparison: the right secret resolves the user, a wrong one or an unknown id resolves nobody
      assert.deepEqual(cases.valid, { viaExtractor: user, viaAuthentication: user });
      assert.deepEqual(cases.wrongSecret, {
        viaExtractor: "anonymous",
        viaAuthentication: "anonymous",
      });
      assert.deepEqual(cases.unknownSession, {
        viaExtractor: "anonymous",
        viaAuthentication: "anonymous",
      });
      // absolute expiry: the once-valid credential is refused by both after 400 days
      assert.deepEqual(cases.expired, {
        viaExtractor: "anonymous",
        viaAuthentication: "anonymous",
      });
    },
  );

  Then(
    "SubjectExtractor's resolution and Authentication's resolution agree on whether the session is valid",
    function* () {
      const cases = yield* casesOutcome();
      for (const [name, both] of Object.entries(cases)) {
        assert.equal(
          both.viaExtractor,
          both.viaAuthentication,
          `${name}: the two resolutions agree`,
        );
      }
    },
  );

  // ---- REQ-EA-430: SubjectExtractor has no session-validity logic of its own ----

  const extractorSource = () =>
    readFileSync(
      fileURLToPath(new URL("../../packages/qadi/src/SubjectExtractor.ts", import.meta.url)),
      "utf8",
    );

  Given("a SubjectExtractor implementation", function* () {
    yield* Effect.void;
    assert.ok(extractorSource().includes("SubjectExtractorLive"));
  });

  When("its session-validity logic is inspected", function* () {
    yield* Effect.void;
  });

  Then(
    "it contains no hash-comparison or expiry check distinct from the one Authentication's middleware uses",
    function* () {
      yield* Effect.void;
      // Code only: what the header comments say about the comparison is not the comparison.
      const code = extractorSource()
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
        .join("\n");
      for (const own of [
        /timingSafeEqual/,
        /Hmac/,
        /secretHash/,
        /createHash/,
        /absoluteExpiresAt/,
        /idleExpiresAt/,
        /Date\.now/,
        /Clock\./,
      ]) {
        assert.doesNotMatch(code, own, `SubjectExtractor.ts carries its own ${own}`);
      }
    },
  );

  Then("there is only one place a session-validity bug could be fixed, not two", function* () {
    yield* Effect.void;
    // Every credential kind the extractor reads goes through the one shared function.
    const code = extractorSource();
    const calls = code.match(/Authentication\.resolvePrincipal\(/g) ?? [];
    assert.ok(calls.length >= 2, "the cookie and impersonation credentials both go through it");
    assert.doesNotMatch(code, /sessions\.verify\(/);
  });

  // ---- BEH-EA-154: RequirePermission reads the RequiredPermission annotation ----

  Given(
    "an endpoint annotated with RequiredPermission via requiresPermission, declaring a permission and a policy",
    function* () {
      yield* configure({ roles: [readerRole, adminRole] });
      const read = endpointAt("/b/read");
      assert.ok(Option.isSome(read.required));
      yield* setPlan({ path: "/b/read", who: reader });
    },
  );

  Given("qadi's evaluator would return an Allow decision for that declared policy", function* () {
    const verdict = yield* decide(hasPermission(projectRead), { resource: {} }).pipe(
      Effect.provideService(
        CurrentSubject,
        makeSubject({ id: "user:probe", permissions: [permissionKey(projectRead)] }),
      ),
      Effect.provide(EvaluationServicesNone),
      Effect.orDie,
    );
    assert.ok(isAllowed(verdict));
  });

  Then("RequirePermission evaluates exactly the policy declared in the annotation", function* () {
    const world = yield* World;
    const decisions = yield* Ref.get(world.decisions);
    const read = endpointAt("/b/read");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.policyTag, Option.getOrUndefined(read.required)?.policyTag);
  });

  Then("the request is allowed to proceed", function* () {
    const world = yield* World;
    assert.equal((yield* world.responses.get("last")).status, 200);
    assert.deepEqual(yield* Ref.get(world.executed), ["read"]);
  });

  Given("an endpoint annotated with RequiredPermission", function* () {
    yield* Effect.void;
    assert.ok(Option.isSome(endpointAt("/b/read").required));
  });

  When("the contract is inspected without invoking the endpoint's handler", function* () {
    // Pure reflection over the contract value; no app is even built.
    yield* setOutcome("declaration", endpointAt("/b/read"));
  });

  Then("the declared permission and policy are visible directly from the annotation", function* () {
    const world = yield* World;
    const read = endpointAt("/b/read");
    const required = Option.getOrUndefined(read.required);
    assert.equal(required?.permission.resource, "project");
    assert.equal(required?.permission.action, "read");
    assert.equal(required?.policyTag, "HasPermission");
    assert.deepEqual(yield* Ref.get(world.executed), [], "no handler ran to learn this");
  });

  Given(
    "an endpoint annotated with RequiredPermission declaring one specific policy",
    function* () {
      yield* configure({ roles: [readerRole, adminRole] });
      assert.ok(Option.isSome(endpointAt("/b/read").required));
      yield* setPlan({ path: "/b/read", who: reader });
    },
  );

  Then("only the declared policy is evaluated", function* () {
    const world = yield* World;
    const decisions = yield* Ref.get(world.decisions);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.policyTag, "HasPermission");
  });

  Then("no other, undeclared policy is additionally consulted", function* () {
    const world = yield* World;
    // Every evaluation the evaluator reported is the one declared above; nothing else ran.
    const decisions = yield* Ref.get(world.decisions);
    assert.ok(decisions.every((decision) => decision.policyTag === "HasPermission"));
    assert.equal((yield* world.responses.get("last")).status, 200);
  });

  // ---- BEH-EA-155: PublicEndpoint is the only other legal annotation ----

  Given(
    "an endpoint in a RequirePermission-middlewared group with no subject to evaluate, such as a liveness probe",
    function* () {
      const health = endpointAt("/b/health");
      assert.equal(health.group, "gated");
      yield* setPlan({ path: "/b/health" });
    },
  );

  Given("it is annotated PublicEndpoint with the reason {string}", function* (reason: string) {
    yield* Effect.void;
    assert.equal(Option.getOrUndefined(endpointAt("/b/health").publicReason), reason);
  });

  Then("it is treated as legitimately public", function* () {
    const world = yield* World;
    assert.equal((yield* world.responses.get("last")).status, 200);
    assert.deepEqual(yield* Ref.get(world.executed), ["health"]);
  });

  Then("no permission is evaluated for it", function* () {
    const world = yield* World;
    assert.deepEqual(yield* Ref.get(world.decisions), []);
  });

  // ---- BEH-EA-156: absence of either annotation is refusal ----

  Given(
    "an endpoint in a RequirePermission-middlewared group carrying neither RequiredPermission nor PublicEndpoint",
    function* () {
      const forgotten = endpointAt("/b/forgotten");
      assert.equal(forgotten.group, "gated");
      assert.ok(Option.isNone(forgotten.required));
      assert.ok(Option.isNone(forgotten.publicReason));
      yield* setPlan({ path: "/b/forgotten" });
    },
  );

  Given("an endpoint carrying neither RequiredPermission nor PublicEndpoint", function* () {
    const forgotten = endpointAt("/b/forgotten");
    assert.ok(Option.isNone(forgotten.required) && Option.isNone(forgotten.publicReason));
    yield* setPlan({ path: "/b/forgotten" });
  });

  Given(
    "a signed-in user {string} with a fully valid, unexpired session",
    function* (name: string) {
      yield* configure({ roles: [readerRole, adminRole] });
      // Even the most privileged caller: an unannotated endpoint is not gated by who you are.
      yield* signIn(name, ["admin"]);
    },
  );

  When("{string} requests that endpoint", function* (name: string) {
    yield* fetchAs(name, "/b/forgotten");
  });

  When("{int} separate requests reach that endpoint over time", function* (count: number) {
    const statuses: Array<number> = [];
    for (let i = 0; i < count; i++)
      statuses.push((yield* fetchAs(undefined, "/b/forgotten")).status);
    yield* setOutcome("statuses", statuses);
  });

  Then("the response is {string}", function* (label: string) {
    const world = yield* World;
    assert.equal((yield* world.responses.get("last")).status, codeOf(label));
  });

  Then("the log names the endpoint that was reached unannotated", function* () {
    const world = yield* World;
    const logs = yield* Ref.get(world.logs);
    assert.ok(
      logs.some((line) => line.includes('"forgotten"')),
      `a log line names the endpoint (saw ${JSON.stringify(logs)})`,
    );
  });

  Then("the response is never {string}", function* (label: string) {
    const world = yield* World;
    assert.notEqual((yield* world.responses.get("last")).status, codeOf(label));
  });

  Then(
    "the 500 response is produced without qadi's evaluator ever being asked to decide anything",
    function* () {
      const world = yield* World;
      assert.equal((yield* world.responses.get("last")).status, 500);
      assert.deepEqual(yield* Ref.get(world.decisions), []);
    },
  );

  Then("every one of the {int} responses is {string}", function* (count: number, label: string) {
    const statuses = yield* outcome("statuses");
    assert.ok(Array.isArray(statuses));
    assert.equal(statuses.length, count);
    assert.ok(statuses.every((status) => status === codeOf(label)));
  });

  Then("none of them is ever {string}", function* (label: string) {
    const statuses = yield* outcome("statuses");
    assert.ok(Array.isArray(statuses));
    assert.ok(statuses.every((status) => status !== codeOf(label)));
  });

  // ---- BEH-EA-157: status mapping is qadi's, not awthaq's ----

  Given(
    "a request to an endpoint middlewared by RequirePermission that results in {string}",
    function* (name: string) {
      const route = outcomeRoute(name);
      yield* configure({
        roles: [readerRole, adminRole],
        ...(route.outage ? { outage: attributeOutage } : {}),
      });
      yield* setOutcome("path", route.path);
      yield* signIn("caller", ["reader"]);
    },
  );

  When("the response is served", function* () {
    yield* fetchAs("caller", String(yield* outcome("path")));
  });

  Then("the response body is empty", function* () {
    const world = yield* World;
    assert.equal((yield* world.responses.get("last")).body, "");
  });

  Given(
    "qadi's RequirePermission middleware maps an outcome to one of its designated statuses",
    function* () {
      yield* configure({ roles: [readerRole, adminRole], outage: "attribute" });
      yield* signIn("caller", ["reader"]);
    },
  );

  When("awthaq's own bridge code serves that response", function* () {
    const served: Record<string, number> = {};
    for (const name of [
      "an AccessDenied decision",
      "an UndischargedObligation",
      "a resolver outage",
      "a missing annotation",
    ]) {
      served[name] = (yield* fetchAs("caller", outcomeRoute(name).path)).status;
    }
    yield* setOutcome("served", served);
  });

  Then("the status served matches qadi's mapping exactly", function* () {
    const served = yield* outcome("served");
    assert.ok(typeof served === "object" && served !== null);
    const qadi = (error: Parameters<typeof toResponse>[0]) => toResponse(error).status;
    const subjectId = makeSubjectId("user:probe");
    assert.equal(
      Reflect.get(served, "an AccessDenied decision"),
      qadi(
        new AccessDenied({
          subjectId,
          policyTag: "HasPermission",
          reason: "x",
          trace: denialTrace,
        }),
      ),
    );
    assert.equal(
      Reflect.get(served, "an UndischargedObligation"),
      qadi(new UndischargedObligation({ subjectId, obligationIds: ["test/duty"] })),
    );
    assert.equal(
      Reflect.get(served, "a resolver outage"),
      qadi(new AttributeResolveError({ attribute: "plan", cause: "down" })),
    );
    // A missing annotation is `RequirePermissionLive`'s own 500 (INV-QD-034): qadi's, not awthaq's.
    assert.equal(Reflect.get(served, "a missing annotation"), 500);
  });

  Then("no additional mapping layer inside awthaq changes it", function* () {
    yield* Effect.void;
    // The bridge adds no middleware of its own on Path B: the group's only middleware is qadi's.
    const keys = new Set<string>();
    HttpApi.reflect(FixtureApi, {
      onGroup: () => {},
      onEndpoint: ({ group, middleware }) => {
        if (group.identifier === "gated") for (const service of middleware) keys.add(service.key);
      },
    });
    assert.deepEqual([...keys], [RequirePermission.key]);
  });

  Given(
    "qadi's AttributeResolver fails while evaluating a policy for an endpoint middlewared by RequirePermission",
    function* () {
      yield* configure({ roles: [readerRole, adminRole], outage: "attribute" });
      yield* setPlan({ path: "/b/plan", who: { name: "caller", roles: ["reader"] } });
    },
  );

  // ---- BEH-EA-158: the permission registry route ----

  Given("a contract whose endpoints carry various RequiredPermission annotations", function* () {
    yield* configure({ roles: [readerRole, adminRole] });
    const annotated = declared().filter((endpoint) => Option.isSome(endpoint.required));
    assert.ok(annotated.length > 1);
  });

  When("registerApi derives the permission registry from that contract", function* () {
    // `registerApi(FixtureApi)` runs when the app is built; the registry route publishes what it derived.
    yield* signIn("operator", ["admin"]);
    yield* fetchAs("operator", "/__permissions");
  });

  Then("the registry lists each declared permission and its endpoints", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 200);
    const listed: Array<string> = [];
    const entries = JSON.parse(response.body);
    assert.ok(Array.isArray(entries));
    for (const entry of entries) {
      for (const endpoint of entry.endpoints) listed.push(`${entry.permission} ${endpoint.path}`);
    }
    for (const endpoint of declared()) {
      const required = Option.getOrUndefined(endpoint.required);
      if (required === undefined) continue;
      assert.ok(
        listed.includes(`${permissionKey(required.permission)} ${endpoint.path}`),
        `the registry lists ${endpoint.path}`,
      );
    }
    // a public or unannotated endpoint declares no permission, so it is not listed
    assert.ok(!listed.some((line) => line.endsWith("/b/health") || line.endsWith("/b/forgotten")));
  });

  Then("no handler for any of those endpoints is executed to produce it", function* () {
    const world = yield* World;
    assert.deepEqual(yield* Ref.get(world.executed), []);
  });

  Given("permissionRegistryRoute is registered behind a policy", function* () {
    yield* configure({ roles: [readerRole, adminRole] });
  });

  Given(
    "qadi's evaluator would return an Allow decision for that policy for a signed-in user {string}",
    function* (_name: string) {
      const verdict = yield* decide(hasPermission(projectAdmin), { resource: {} }).pipe(
        Effect.provideService(
          CurrentSubject,
          makeSubject({ id: "user:probe", permissions: [permissionKey(projectAdmin)] }),
        ),
        Effect.provide(EvaluationServicesNone),
        Effect.orDie,
      );
      assert.ok(isAllowed(verdict));
    },
  );

  Given(
    "qadi's evaluator would return a Deny decision for that policy for a caller with no valid session",
    function* () {
      const verdict = yield* decide(hasPermission(projectAdmin), { resource: {} }).pipe(
        Effect.provideService(CurrentSubject, makeSubject({ id: "anonymous" })),
        Effect.provide(EvaluationServicesNone),
        Effect.orDie,
      );
      assert.equal(isAllowed(verdict), false);
    },
  );

  When("{string} requests {string}", function* (name: string, route: string) {
    // "alice" holds the admin role (the Given proved the policy allows a holder of `project:admin`).
    yield* signIn(name, ["admin"]);
    yield* fetchAs(name, route.replace(/^GET /, ""));
  });

  When("that caller requests {string}", function* (route: string) {
    yield* fetchAs(undefined, route.replace(/^GET /, ""));
  });

  Then("{string} receives the permission registry", function* (_name: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 200);
    const entries = JSON.parse(response.body);
    assert.ok(Array.isArray(entries) && entries.length > 0);
    assert.ok(entries.some((entry: { permission: string }) => entry.permission === "project:read"));
  });

  Then("the registry is not served to them", function* () {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, 403);
    assert.ok(!response.body.includes("project:read"));
  });

  // ---- BEH-EA-159: choosing Path B over Path A ----

  Given(
    'an endpoint whose policy needs only the caller\'s own subject state, such as hasRole\\("admin"\\)',
    function* () {
      yield* configure({ roles: [readerRole, adminRole] });
      const verdict = yield* decide(hasRole("admin"), { resource: {} }).pipe(
        Effect.provideService(CurrentSubject, makeSubject({ id: "user:probe", roles: ["admin"] })),
        Effect.provide(EvaluationServicesNone),
        Effect.orDie,
      );
      assert.ok(isAllowed(verdict));
      yield* setPlan({ path: "/b/admin-only", who: { name: "admin", roles: ["admin"] } });
    },
  );

  When("the endpoint is wired for authorization", function* () {
    const planned = yield* plan();
    if (planned.path === "/b/owned") {
      const owner = yield* signIn("owner", ["reader"]);
      yield* signIn("stranger", ["reader"]);
      yield* setOwner("project-own", `user:${owner.userId}`);
      // Path B: annotation-only, so the policy sees the empty placeholder resource; even the owner is refused.
      yield* fetchAs("owner", "/b/owned");
    } else {
      yield* runPlan();
    }
  });

  Then(
    "it is wired through Path B's RequiredPermission annotation, with no resource loaded beforehand",
    function* () {
      const world = yield* World;
      assert.equal(
        Option.getOrUndefined(endpointAt("/b/admin-only").required)?.policyTag,
        "HasRole",
      );
      assert.equal((yield* world.responses.get("last")).status, 200);
      const decisions = yield* Ref.get(world.decisions);
      assert.equal(decisions.length, 1);
      // nothing was loaded: the evaluated resource is qadi's empty placeholder
      assert.equal(decisions[0]?.resourceKeys, 0);
    },
  );

  Given(
    "an endpoint whose policy needs an attribute of a resource only available once a handler has loaded it, such as a project's ownerId",
    function* () {
      yield* configure({ roles: [readerRole, adminRole] });
      assert.equal(ownerPolicy._tag, "HasResourceAttribute");
      yield* setPlan({ path: "/b/owned" });
    },
  );

  Then(
    "Path B's annotation-only evaluation has no loaded resource to hand the policy",
    function* () {
      const world = yield* World;
      const owner = yield* world.actors.get("owner");
      assert.ok(owner);
      // The rightful owner is denied: there was no `ownerId` to compare against.
      assert.equal((yield* world.responses.get("last")).status, 403);
      const decisions = yield* Ref.get(world.decisions);
      assert.equal(decisions[0]?.resourceKeys, 0);
      assert.equal(decisions[0]?.verdict, "Deny");
    },
  );

  Then(
    "the endpoint must instead be wired through Path A's guard or enforce inside the handler",
    function* () {
      const world = yield* World;
      // Path A loads the resource first: the owner is allowed, a stranger is not.
      const owner = yield* fetchAs("owner", "/a/owned/project-own");
      assert.equal(owner.status, 200);
      const stranger = yield* fetchAs("stranger", "/a/owned/project-own");
      assert.equal(stranger.status, 404);
      assert.ok(world);
    },
  );

  // ---- BEH-EA-160: both bridges share one wiring root ----

  Given("an application using both Path A and Path B", function* () {
    yield* configure({ roles: [readerRole, adminRole] });
    yield* signIn("alice", ["reader"]);
  });

  When("its authorization wiring is composed", function* () {
    // The one merged `AuthzLive` over one core: both bridges are built and serve requests.
    yield* fetchAs("alice", "/a/whoami");
    yield* fetchAs("alice", "/b/whoami");
  });

  Then(
    "AuthorizedSubjectLive and the RequirePermissionLive\\/SubjectExtractorLive pair are merged into one AuthzLive Layer",
    function* () {
      const world = yield* World;
      const built = yield* Ref.get(world.app);
      assert.ok(built, "the application was built");
      const { run } = built;
      // One layer provides all three services.
      const present = yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const pathA = yield* AuthorizedSubject.AuthorizedSubject;
            const pathB = yield* RequirePermission;
            const extractor = yield* QadiSubjectExtractor;
            return [pathA, pathB, extractor].every((service) => service !== undefined);
          }),
        ),
      );
      assert.ok(present);
    },
  );

  When("its authorization wiring is inspected", function* () {
    // Serve one request through each path: the counting wrapper over the resolver in effect sees both.
    yield* fetchAs("alice", "/a/whoami");
    yield* fetchAs("alice", "/b/whoami");
  });

  Then("that merged Layer is built over the same auth.layer", function* () {
    const world = yield* World;
    // A session minted straight into the app's own Sessions store is honored by *both* paths.
    assert.equal((yield* world.responses.get("last")).status, 200);
    const alice = yield* world.actors.get("alice");
    const viaA = yield* fetchAs("alice", "/a/whoami");
    assert.equal(JSON.parse(viaA.body).subjectId, `user:${alice.userId}`);
  });

  Then(
    "both paths are built over the identical SubjectResolver instance provided by auth.layer",
    function* () {
      const world = yield* World;
      // One counting wrapper sits over the resolver in effect; each path's request went through it.
      assert.equal(yield* Ref.get(world.resolutions), 2);
    },
  );

  Then(
    "no second, independently-configured SubjectResolver instance backs either path",
    function* () {
      const world = yield* World;
      const before = yield* Ref.get(world.resolutions);
      yield* fetchAs("alice", "/a/whoami");
      yield* fetchAs("alice", "/b/whoami");
      // Two further requests, exactly two further resolutions on the same counter: no other instance.
      assert.equal((yield* Ref.get(world.resolutions)) - before, 2);
    },
  );

  Given(
    "a signed-in user {string} and an application wired with one shared AuthzLive",
    function* (name: string) {
      yield* configure({ roles: [readerRole, adminRole] });
      yield* signIn(name, ["reader"]);
    },
  );

  When(
    "{string} makes one request to a Path-A-gated endpoint and another request to a Path-B-gated endpoint",
    function* (name: string) {
      const a = yield* fetchAs(name, "/a/whoami");
      const b = yield* fetchAs(name, "/b/whoami");
      yield* setOutcome("pathA", JSON.parse(a.body));
      yield* setOutcome("pathB", JSON.parse(b.body));
    },
  );

  Then(
    "both requests resolve {string} to the identical underlying AuthSubject",
    function* (name: string) {
      const world = yield* World;
      const actor = yield* world.actors.get(name);
      const a = yield* outcome("pathA");
      const b = yield* outcome("pathB");
      assert.deepEqual(a, b);
      assert.equal(Reflect.get(a as object, "subjectId"), `user:${actor.userId}`);
      // and it is the fully-resolved subject (roles flattened), not merely the same id
      assert.deepEqual(Reflect.get(a as object, "permissions"), ["project:read"]);
    },
  );
});
