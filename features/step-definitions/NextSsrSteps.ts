// BEH-EA-185..192 (24-nextjs-ssr.feature). See NextSsrWorld.ts for the seam.
import { Sessions, Users } from "@awthaq/core";
import { getSession, hasSessionCookie, withNextCookies } from "@awthaq/next";
import { Password } from "@awthaq/password";
import { SubjectResolver } from "@awthaq/qadi";
import { dehydrateDecisions, hydrateDecisions, makeQadiAtoms } from "@awthaq/react";
import { TestAuth } from "@awthaq/test";
import { defineSteps } from "@effect-cucumber/vitest";
import {
  CurrentSubject,
  EvaluationServicesNone,
  allOf,
  currentSubjectLayer,
  decide,
  eq,
  filter,
  hasPermission,
  hasResourceAttribute,
  literal,
  makeSubject,
  permission,
  project,
} from "@qadi/core";
import type { AuthSubject, Decision, Policy } from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import assert from "node:assert/strict";
import { CSRF_COOKIE_NAME, CSRF_TEST_COOKIE_VALUE } from "./CsrfTestSupport.ts";
import { headersWithCookie, SESSION_COOKIE, send, World } from "./NextSsrWorld.ts";
import { isBoolean, isNumber, isString, isStringArray } from "./shared/Outcomes.ts";

/** What a Server Component / server action sees of `getSession`'s answer. */
interface Seen {
  readonly found: boolean;
  readonly userId: string | undefined;
  readonly principalId: string | undefined;
}

const isSeen = (value: unknown): value is Seen =>
  typeof value === "object" &&
  value !== null &&
  isBoolean(Reflect.get(value, "found"));

const readSession = (cookieHeader: string) =>
  Effect.gen(function* () {
    const { runtime } = yield* World;
    const session = yield* Effect.promise(() =>
      getSession(headersWithCookie(cookieHeader), runtime),
    );
    return {
      found: session !== undefined,
      userId: session?.user.id,
      principalId: session?.principal.ref.id,
    } satisfies Seen;
  });

const signInAlice = (email: string) =>
  Effect.gen(function* () {
    const { runtime } = yield* World;
    return yield* Effect.promise(() => runtime.runPromise(TestAuth.signInAs({ email })));
  });

const revokeEverything = (userId: Users.UserId) =>
  Effect.gen(function* () {
    const { runtime } = yield* World;
    yield* Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          yield* sessions.revokeAll(userId, "admin");
        }),
      ),
    );
  });

const forgedCookie = `${SESSION_COOKIE}=00000000-0000-0000-0000-000000000000.not-a-real-secret`;

/** An application's `deleteProject` server action, as BEH-EA-190 describes it: fresh `getSession`, then a fresh subject for its principal. */
const invokeAction = (cookieHeader: string) =>
  Effect.gen(function* () {
    const { runtime } = yield* World;
    const session = yield* Effect.promise(() => getSession(headersWithCookie(cookieHeader), runtime));
    if (session === undefined) return undefined;
    return yield* Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const resolver = yield* SubjectResolver.SubjectResolver;
          return yield* resolver.resolve(session.principal);
        }),
      ),
    );
  });

// ---- policies and resources the qadi-facing scenarios decide over ---------------------------

const readProject = permission("project", "read");
const deleteProject = permission("project", "delete");
const inviteToProject = permission("project", "invite");

const canReadProject = hasPermission(readProject);
const canDeleteProject = hasPermission(deleteProject);
const canInvite = hasPermission(inviteToProject);

const projectsFor = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `project-${index}`,
    name: `Project ${index}`,
    ownerId: "alice",
    secretNotes: `notes-${index}-do-not-ship`,
  }));

const aliceSubject = makeSubject({
  id: "user:alice",
  roles: ["member"],
  permissions: ["project:read", "project:delete", "project:invite"],
});

const decideFor = (subject: AuthSubject, policy: Policy, resource?: Readonly<Record<string, unknown>>) =>
  decide(policy, resource === undefined ? {} : { resource }).pipe(
    Effect.provide(Layer.mergeAll(EvaluationServicesNone, currentSubjectLayer(subject))),
  );

const isSubject = (value: unknown): value is AuthSubject =>
  typeof value === "object" && value !== null && "roles" in value && "permissions" in value;

const isDecisionList = (value: unknown): value is ReadonlyArray<Decision> =>
  Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && "_tag" in item);

export const nextSsrSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-185: getSession verifies the cookie against the database ---------------------

  Given(
    "a valid session cookie for {string} that matches a live session row",
    function* (name: string) {
      const { outcomes } = yield* World;
      const signedIn = yield* signInAlice(`${name}@example.com`);
      yield* outcomes.set("cookie", signedIn.cookieHeader);
      yield* outcomes.set("expectedUserId", signedIn.userId);
    },
  );

  When("a React Server Component calls {string}", function* (_call: string) {
    const { outcomes } = yield* World;
    const cookie = yield* outcomes.getAs("cookie", isString);
    yield* outcomes.set("seen", yield* readSession(cookie));
  });

  Then("it returns a database-verified {string} for {string}", function* (_view: string, _name: string) {
    const { outcomes } = yield* World;
    const seen = yield* outcomes.getAs("seen", isSeen);
    assert.equal(seen.found, true);
    assert.equal(seen.userId, yield* outcomes.getAs("expectedUserId", isString));
    assert.equal(seen.principalId, seen.userId);
  });

  Given("a session cookie that is present but does not match any live session row", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("cookie", forgedCookie);
  });

  When("a server action calls {string}", function* (_call: string) {
    const { outcomes } = yield* World;
    const cookie = yield* outcomes.getAs("cookie", isString);
    yield* outcomes.set("seen", yield* readSession(cookie));
    yield* outcomes.set("presence", hasSessionCookie({ headers: headersWithCookie(cookie) }));
  });

  Then("it returns {string}", function* (literalValue: string) {
    const { outcomes } = yield* World;
    assert.equal(literalValue, "undefined");
    assert.equal((yield* outcomes.getAs("seen", isSeen)).found, false);
  });

  Then(
    "the page or action does not rely on the cookie's mere presence to treat the caller as authenticated",
    function* () {
      const { outcomes } = yield* World;
      // The cookie is there, and that is exactly what must not be enough.
      assert.equal(yield* outcomes.getAs("presence", isBoolean), true);
      assert.equal((yield* outcomes.getAs("seen", isSeen)).found, false);
    },
  );

  Given("a request carrying a session cookie", function* () {
    const { outcomes } = yield* World;
    const signedIn = yield* signInAlice("carrier@example.com");
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    yield* outcomes.set("liveBefore", (yield* readSession(signedIn.cookieHeader)).found);
    // The row goes away underneath the cookie, which is still sitting in the browser.
    yield* revokeEverything(signedIn.userId);
  });

  When("a page or server action performs its own authorization", function* () {
    const { outcomes } = yield* World;
    const cookie = yield* outcomes.getAs("cookie", isString);
    yield* outcomes.set("presence", hasSessionCookie({ headers: headersWithCookie(cookie) }));
    yield* outcomes.set("seen", yield* readSession(cookie));
  });

  Then("it calls {string} to verify the cookie against the session store", function* (_call: string) {
    const { outcomes } = yield* World;
    // The same cookie was a live session moments ago; only a lookup against the store can know it is not now.
    assert.equal(yield* outcomes.getAs("liveBefore", isBoolean), true);
    assert.equal((yield* outcomes.getAs("seen", isSeen)).found, false);
  });

  Then("it never treats cookie presence alone as sufficient for that authorization check", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("presence", isBoolean), true);
    assert.equal((yield* outcomes.getAs("seen", isSeen)).found, false);
  });

  // ---- BEH-EA-186: server-side decide produces the client seed -----------------------------

  Given(
    "qadi's evaluator would return decisions for {string} and {string} against each of the page's resources",
    function* (_delete: string, _invite: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("resources", projectsFor(3).map((entry) => entry.id));
    },
  );

  When("the page's server-side data-loading Effect runs", function* () {
    const { outcomes } = yield* World;
    const resources = projectsFor(3);
    const decisions = yield* Effect.forEach(resources, (resource) =>
      Effect.all([
        decideFor(aliceSubject, canDeleteProject, resource),
        decideFor(aliceSubject, canInvite, resource),
      ]),
    );
    const flat = decisions.flat();
    yield* outcomes.set("decisions", flat);
    yield* outcomes.set("decidedCount", flat.length);
    yield* outcomes.set("evaluationIds", flat.map((decision) => decision.evaluationId));
  });

  Then("all of those decisions are computed once during that server render", function* () {
    const { outcomes } = yield* World;
    const ids = yield* outcomes.getAs("evaluationIds", isStringArray);
    // Two policies over three resources: six evaluations, each with its own id — none repeated.
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, ids.length);
  });

  Then("the results are passed to the client via {string}", function* (_call: string) {
    const { outcomes } = yield* World;
    const decisions = yield* outcomes.getAs("decisions", isDecisionList);
    const resources = projectsFor(3);
    const entries = decisions.map((decision, index) => ({
      policy: index % 2 === 0 ? canDeleteProject : canInvite,
      resource: resources[Math.floor(index / 2)],
      decision,
    }));
    const dehydrated = dehydrateDecisions(entries);
    assert.equal(dehydrated.subjectId, aliceSubject.id);
    assert.equal(dehydrated.entries.length, decisions.length);
  });

  /** A composite policy: its full evaluation trace names both children, so a leaked trace is visible. */
  const canManage = allOf([canDeleteProject, canInvite]);

  Given("the decisions computed during a page's server render", function* () {
    const { outcomes } = yield* World;
    const decision = yield* decideFor(aliceSubject, canManage, projectsFor(1)[0]);
    yield* outcomes.set("decisions", [decision]);
  });

  When("they are passed through {string}", function* (_call: string) {
    const { outcomes } = yield* World;
    const decisions = yield* outcomes.getAs("decisions", isDecisionList);
    const entries = decisions.map((decision) => ({ policy: canManage, decision }));
    // What actually crosses the RSC boundary: JSON text.
    yield* outcomes.set("wire", JSON.stringify(dehydrateDecisions(entries)));
    // The control: the same decisions with the trace explicitly opted in.
    yield* outcomes.set("wireWithTrace", JSON.stringify(dehydrateDecisions(entries, { includeTrace: true })));
  });

  Then("the resulting payload is plain JSON", function* () {
    const { outcomes } = yield* World;
    const wire = yield* outcomes.getAs("wire", isString);
    assert.equal(JSON.stringify(JSON.parse(wire)), wire);
  });

  Then("it carries no evaluation trace by default", function* () {
    const { outcomes } = yield* World;
    const traceChildren = (wire: string) => {
      const entries = Reflect.get(Object(JSON.parse(wire)), "entries");
      assert.ok(Array.isArray(entries) && entries.length === 1);
      const trace = Reflect.get(Object(entries[0]), "trace");
      const children = Reflect.get(Object(trace), "children");
      return Array.isArray(children) ? children.length : -1;
    };
    // By default only a reduced stub crosses: no per-node breakdown of the policy tree...
    assert.equal(traceChildren(yield* outcomes.getAs("wire", isString)), 0);
    // ...whereas the opted-in payload does disclose it (the two children of `allOf`).
    assert.equal(traceChildren(yield* outcomes.getAs("wireWithTrace", isString)), 2);
  });

  // ---- BEH-EA-187: decide against attributes; project content separately -------------------

  const ownedByAlice = hasResourceAttribute("ownerId", eq(literal("alice")));

  Given(
    "a project resource with both policy-relevant attributes and additional content fields",
    function* () {
      const { outcomes } = yield* World;
      yield* outcomes.set("project", projectsFor(1)[0]);
    },
  );

  When(
    "{string} is called",
    function* (call: string) {
      const { outcomes } = yield* World;
      assert.match(call, /decide\(canReadProject/);
      const full = projectsFor(1)[0];
      // `policyResource(project)`: exactly the attributes the policy inspects, nothing else.
      const policyResource = { ownerId: full?.ownerId };
      const decision = yield* decideFor(aliceSubject, ownedByAlice, policyResource);
      yield* outcomes.set("passedKeys", Object.keys(policyResource));
      yield* outcomes.set("allowed", decision._tag === "Allow");
    },
  );

  Then("the value passed to {string} contains only the attributes the policy inspects", function* (_call: string) {
    const { outcomes } = yield* World;
    assert.deepEqual(yield* outcomes.getAs("passedKeys", isStringArray), [
      ownedByAlice._tag === "HasResourceAttribute" ? ownedByAlice.attribute : "",
    ]);
    // And those attributes were enough: had one been missing the decision would not allow.
    assert.equal(yield* outcomes.getAs("allowed", isBoolean), true);
  });

  Then("it does not contain the resource's full content", function* () {
    const { outcomes } = yield* World;
    const keys = yield* outcomes.getAs("passedKeys", isStringArray);
    assert.ok(!keys.includes("secretNotes") && !keys.includes("name"));
  });

  const readableFields = hasPermission(readProject, { fields: ["id", "name"] });

  Given("a decision that grants only a subset of {string}'s fields", function* (_name: string) {
    const { outcomes } = yield* World;
    const decision = yield* decideFor(aliceSubject, readableFields, projectsFor(1)[0]);
    yield* outcomes.set("decisions", [decision]);
    yield* outcomes.set("granted", decision._tag === "Allow" ? (decision.visibleFields ?? []) : []);
  });

  When("the page produces its rendered output via {string}", function* (_call: string) {
    const { outcomes } = yield* World;
    const [decision] = yield* outcomes.getAs("decisions", isDecisionList);
    assert.ok(decision !== undefined);
    const trimmed = project(decision, projectsFor(1)[0] ?? {});
    yield* outcomes.set("projectedKeys", Object.keys(trimmed));
    // Serialization happens after projection: what is serialized is only what was granted.
    yield* outcomes.set("serialized", JSON.stringify(trimmed));
  });

  Then("the returned value contains only the fields the decision grants", function* () {
    const { outcomes } = yield* World;
    assert.deepEqual(
      [...(yield* outcomes.getAs("projectedKeys", isStringArray))].sort(),
      [...(yield* outcomes.getAs("granted", isStringArray))].sort(),
    );
  });

  Then("this trimming happens before the page's output is serialized", function* () {
    const { outcomes } = yield* World;
    const serialized = yield* outcomes.getAs("serialized", isString);
    assert.equal(serialized.includes("secretNotes"), false);
    assert.equal(serialized.includes("notes-0-do-not-ship"), false);
  });

  Given("a field of {string} that the decision does not grant", function* (_name: string) {
    const { outcomes } = yield* World;
    const decision = yield* decideFor(aliceSubject, readableFields, projectsFor(1)[0]);
    yield* outcomes.set("decisions", [decision]);
  });

  When("the page renders its output using {string}", function* (_call: string) {
    const { outcomes } = yield* World;
    const [decision] = yield* outcomes.getAs("decisions", isDecisionList);
    assert.ok(decision !== undefined);
    const trimmed = project(decision, projectsFor(1)[0] ?? {});
    // The page's markup is built from the projected value only.
    yield* outcomes.set("html", `<article>${JSON.stringify(trimmed)}</article>`);
  });

  Then("that field is absent from the server-rendered HTML entirely", function* () {
    const { outcomes } = yield* World;
    const html = yield* outcomes.getAs("html", isString);
    assert.equal(html.includes("secretNotes"), false);
    assert.equal(html.includes("do-not-ship"), false);
  });

  Then("it is not merely hidden by a client component that received it anyway", function* () {
    const { outcomes } = yield* World;
    // Nothing was sent that a client component could have hidden: the value never held the field.
    assert.equal((yield* outcomes.getAs("html", isString)).includes("secretNotes"), false);
  });

  // ---- BEH-EA-188: proxy.ts is an optimistic redirect, never the boundary ------------------

  /** An application's `proxy.ts`: an optimistic, synchronous, cookie-presence-only redirect. */
  const proxyDecision = (request: { readonly headers: ReturnType<typeof headersWithCookie> }) =>
    hasSessionCookie(request) ? { action: "next" } : { action: "redirect", to: "/sign-in" };

  Given("a request to a path under {string} carrying no session cookie", function* (_path: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("cookie", "");
    yield* outcomes.set("noCookie", true);
  });

  When("{string} runs against that request", function* (_proxy: string) {
    const { outcomes } = yield* World;
    const cookie = yield* outcomes.getAs("cookie", isString);
    const decision = proxyDecision({ headers: headersWithCookie(cookie === "" ? null : cookie) });
    yield* outcomes.set("proxyAction", decision.action);
    yield* outcomes.set("proxyTo", decision.to ?? "");
    // No promise, no runtime: the decision is reached synchronously from the headers alone.
    yield* outcomes.set("proxySync", !(decision instanceof Promise));
  });

  Then("it redirects to {string}", function* (target: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("proxyAction", isString), "redirect");
    assert.equal(yield* outcomes.getAs("proxyTo", isString), target);
  });

  Then("it performs no database check to reach that decision", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("proxySync", isBoolean), true);
  });

  Given(
    "a request to a path under {string} carrying a session cookie that is present but stale",
    function* (_path: string) {
      const { outcomes } = yield* World;
      const signedIn = yield* signInAlice("stale@example.com");
      yield* revokeEverything(signedIn.userId);
      yield* outcomes.set("cookie", signedIn.cookieHeader);
    },
  );

  Then(
    "the request is allowed past {string} on the strength of the cookie's presence",
    function* (_proxy: string) {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("proxyAction", isString), "next");
    },
  );

  Then("the page's own {string} call independently rejects the stale session", function* (_call: string) {
    const { outcomes } = yield* World;
    const cookie = yield* outcomes.getAs("cookie", isString);
    assert.equal((yield* readSession(cookie)).found, false);
  });

  Given("a request that has passed {string}'s cookie-presence check", function* (_proxy: string) {
    const { outcomes } = yield* World;
    const signedIn = yield* signInAlice("passed@example.com");
    yield* revokeEverything(signedIn.userId);
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    const decision = proxyDecision({ headers: headersWithCookie(signedIn.cookieHeader) });
    yield* outcomes.set("passedProxy", decision.action === "next");
  });

  When("the page or server action reached past {string} runs", function* (_proxy: string) {
    const { outcomes } = yield* World;
    const cookie = yield* outcomes.getAs("cookie", isString);
    yield* outcomes.set("seen", yield* readSession(cookie));
  });

  Then("it independently verifies the session itself", function* () {
    const { outcomes } = yield* World;
    assert.equal((yield* outcomes.getAs("seen", isSeen)).found, false);
  });

  Then(
    "it does not treat having passed {string} as proof of authentication or authorization",
    function* (_proxy: string) {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("passedProxy", isBoolean), true);
      assert.equal((yield* outcomes.getAs("seen", isSeen)).found, false);
    },
  );

  // ---- BEH-EA-189: withNextCookies bridges Set-Cookie from server actions ------------------

  Given("a server action that results in {string}", function* (trigger: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("trigger", trigger);
  });

  /** Produces the `Response` the action's Effect program would write `Set-Cookie` onto. */
  const responseForTrigger = (trigger: string) =>
    Effect.gen(function* () {
      const { runtime } = yield* World;
      if (trigger === "a rotated CSRF token") {
        // A cold client's first call through a guarded group: the response carries a fresh `__Host-csrf`.
        return yield* send(new Request("http://localhost/session"));
      }
      // A privilege change: the password change issues a fresh, superseding session.
      const password = Redacted.make("correct horse battery staple");
      const email = "privilege@example.com";
      const issued = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const passwords = yield* Password.Password;
            const users = yield* Users.Users;
            const signedUp = yield* passwords.signUp({ email, password });
            yield* users.verifyEmail(signedUp.session.userId);
            return signedUp;
          }),
        ),
      );
      return yield* send(
        new Request("http://localhost/change-password", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${SESSION_COOKIE}=${Redacted.value(issued.token)}; ${CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`,
            "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
          },
          body: JSON.stringify({
            currentPassword: Redacted.value(password),
            newPassword: "a different and equally strong passphrase",
          }),
        }),
      );
    });

  When("the action runs {string}", function* (_call: string) {
    const { outcomes, jar } = yield* World;
    const trigger = yield* outcomes.getAs("trigger", isString);
    const response = yield* responseForTrigger(trigger);
    yield* outcomes.set("status", response.status);
    yield* outcomes.set("setCookie", response.headers.get("set-cookie") ?? "");
    withNextCookies(response, jar);
  });

  Then(
    "the resulting {string} header reaches Next's cookie jar via {string}",
    function* (_header: string, _module: string) {
      const { outcomes, jar } = yield* World;
      const trigger = yield* outcomes.getAs("trigger", isString);
      const written = yield* Ref.get(jar.written);
      const expectedName = trigger === "a rotated CSRF token" ? CSRF_COOKIE_NAME : SESSION_COOKIE;
      const raw = yield* outcomes.getAs("setCookie", isString);
      assert.match(raw, new RegExp(`^${expectedName}=`));
      const cookie = written.find((entry) => entry.name === expectedName);
      assert.ok(cookie !== undefined, `no ${expectedName} reached the jar: ${JSON.stringify(written)}`);
      assert.ok(cookie.value.length > 0);
    },
  );

  Given(
    "a server action whose Effect program would ordinarily write {string} onto its own response object",
    function* (_header: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("trigger", "a rotated CSRF token");
    },
  );

  When("the action runs inside a Next.js server action", function* () {
    const { outcomes, jar } = yield* World;
    // The Effect program ran and produced a response with the header — which a server action never sees.
    const response = yield* responseForTrigger(yield* outcomes.getAs("trigger", isString));
    yield* outcomes.set("headerOnResponse", (response.headers.get("set-cookie") ?? "").length > 0);
    yield* outcomes.set("jarBefore", (yield* Ref.get(jar.written)).length);
    withNextCookies(response, jar);
    yield* outcomes.set("jarAfter", (yield* Ref.get(jar.written)).length);
  });

  Then(
    "it does not rely on that response object, because a server action never sees it",
    function* () {
      const { outcomes } = yield* World;
      // The header exists only on the response object; the jar next/headers hands the action was empty.
      assert.equal(yield* outcomes.getAs("headerOnResponse", isBoolean), true);
      assert.equal(yield* outcomes.getAs("jarBefore", isNumber), 0);
    },
  );

  Then("it instead relies on {string} to carry the header across the boundary", function* (_bridge: string) {
    const { outcomes } = yield* World;
    assert.ok((yield* outcomes.getAs("jarAfter", isNumber)) > 0);
  });

  // ---- BEH-EA-190: server actions re-resolve the subject per invocation --------------------

  Given("a server action {string}", function* (name: string) {
    const { outcomes } = yield* World;
    const signedIn = yield* signInAlice("actor@example.com");
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    yield* outcomes.set("action", name);
  });

  When("it is invoked", function* () {
    const { outcomes, roles } = yield* World;
    yield* Ref.set(roles, ["member"]);
    const subject = yield* invokeAction(yield* outcomes.getAs("cookie", isString));
    yield* outcomes.set("resolvedRoles", subject === undefined ? [] : [...subject.roles]);
  });

  Then(
    "it calls {string} and {string} fresh, within that invocation",
    function* (_session: string, _resolver: string) {
      const { outcomes, resolverCalls } = yield* World;
      // One invocation, one resolution — and the subject it got came from the live session's principal.
      assert.equal(yield* Ref.get(resolverCalls), 1);
      assert.deepEqual(yield* outcomes.getAs("resolvedRoles", isStringArray), ["member"]);
    },
  );

  Given("a page rendered while {string} held a role granting {string}", function* (name: string, _action: string) {
    const { outcomes, roles } = yield* World;
    const signedIn = yield* signInAlice(`${name}@example.com`);
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    yield* Ref.set(roles, ["owner"]);
    const rendered = yield* invokeAction(signedIn.cookieHeader);
    yield* outcomes.set("renderRoles", rendered === undefined ? [] : [...rendered.roles]);
  });

  Given("{string}'s role is revoked after the page rendered, while her tab remains open", function* (_name: string) {
    const { roles } = yield* World;
    yield* Ref.set(roles, []);
  });

  When(
    "{string} later triggers the {string} server action from that same open tab",
    function* (_name: string, _action: string) {
      const { outcomes } = yield* World;
      const subject = yield* invokeAction(yield* outcomes.getAs("cookie", isString));
      yield* outcomes.set("actionRoles", subject === undefined ? ["<no subject>"] : [...subject.roles]);
    },
  );

  Then(
    "the action re-resolves {string}'s subject fresh and reflects the revoked role",
    function* (_name: string) {
      const { outcomes, resolverCalls } = yield* World;
      assert.deepEqual(yield* outcomes.getAs("renderRoles", isStringArray), ["owner"]);
      assert.deepEqual(yield* outcomes.getAs("actionRoles", isStringArray), []);
      assert.equal(yield* Ref.get(resolverCalls), 2);
    },
  );

  Then("it does not reuse the subject resolved during the page's initial server render", function* () {
    const { outcomes } = yield* World;
    const render = yield* outcomes.getAs("renderRoles", isStringArray);
    const action = yield* outcomes.getAs("actionRoles", isStringArray);
    assert.notDeepEqual(render, action);
  });

  Given("a subject resolved once during a page's initial server render", function* () {
    const { outcomes, roles } = yield* World;
    const signedIn = yield* signInAlice("renderer@example.com");
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    yield* Ref.set(roles, ["member"]);
    const subject = yield* invokeAction(signedIn.cookieHeader);
    yield* outcomes.set("renderSubject", subject);
  });

  When("a server action on that page is invoked afterward", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("actionSubject", yield* invokeAction(yield* outcomes.getAs("cookie", isString)));
  });

  Then("it does not reuse the subject resolved during the page's initial render", function* () {
    const { outcomes } = yield* World;
    const rendered = yield* outcomes.getAs("renderSubject", isSubject);
    const action = yield* outcomes.getAs("actionSubject", isSubject);
    // A distinct value produced by a distinct resolution, not the render's subject handed back.
    assert.notEqual(action, rendered);
  });

  Then("the action resolves its own subject fresh", function* () {
    const { resolverCalls } = yield* World;
    assert.equal(yield* Ref.get(resolverCalls), 2);
  });

  // ---- BEH-EA-191: one subject, provided once per page render ------------------------------

  /** A page's data-loading Effect: resolve the subject once, then decide/filter everything under it. */
  const loadPage = (cookieHeader: string, resourceCount: number) =>
    Effect.gen(function* () {
      const { runtime } = yield* World;
      const session = yield* Effect.promise(() => getSession(headersWithCookie(cookieHeader), runtime));
      assert.ok(session !== undefined);
      return yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const resolver = yield* SubjectResolver.SubjectResolver;
            const subject = yield* resolver.resolve(session.principal);
            const projects = projectsFor(resourceCount);
            const scoped = Layer.mergeAll(EvaluationServicesNone, currentSubjectLayer(subject));
            return yield* Effect.gen(function* () {
              const current = yield* CurrentSubject;
              const readable = yield* filter(canReadProject, projects);
              const decisions = yield* Effect.forEach(readable, (resource) =>
                Effect.all([
                  decide(canDeleteProject, { resource }),
                  decide(canInvite, { resource }),
                ]),
              );
              return { subjectId: current.id, evaluated: decisions.flat() };
            }).pipe(Effect.provide(scoped));
          }),
        ),
      );
    });

  Given("a page's server-side data-loading {string} block", function* (_block: string) {
    const { outcomes, roles } = yield* World;
    const signedIn = yield* signInAlice("pager@example.com");
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    yield* Ref.set(roles, ["member"]);
  });

  When("the block begins", function* () {
    const { outcomes } = yield* World;
    const page = yield* loadPage(yield* outcomes.getAs("cookie", isString), 1);
    yield* outcomes.set("subjectId", page.subjectId);
  });

  Then("it resolves {string} exactly once", function* (_service: string) {
    const { resolverCalls } = yield* World;
    assert.equal(yield* Ref.get(resolverCalls), 1);
  });

  Given("the subject resolved once at the top of a page's data-loading Effect", function* () {
    const { outcomes, roles } = yield* World;
    const signedIn = yield* signInAlice("subject-once@example.com");
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    yield* Ref.set(roles, ["member"]);
  });

  When(
    "the page evaluates read access for every project, then delete and invite decisions for the readable subset",
    function* () {
      const { outcomes } = yield* World;
      const page = yield* loadPage(yield* outcomes.getAs("cookie", isString), 4);
      yield* outcomes.set("subjectId", page.subjectId);
      yield* outcomes.set("evaluated", page.evaluated.length);
      yield* outcomes.set("decisionSubjects", page.evaluated.map((decision) => decision.subjectId));
    },
  );

  Then(
    "all of those {string}\\/{string} calls are provided the same subject via {string}",
    function* (_decide: string, _filter: string, _layer: string) {
      const { outcomes, resolverCalls } = yield* World;
      const subjects = yield* outcomes.getAs("decisionSubjects", isStringArray);
      assert.ok(subjects.length > 0);
      assert.deepEqual([...new Set(subjects)], [yield* outcomes.getAs("subjectId", isString)]);
      assert.equal(yield* Ref.get(resolverCalls), 1);
    },
  );

  Given("a page that evaluates policies for {string} resources during one render", function* (_n: string) {
    const { outcomes, roles } = yield* World;
    const signedIn = yield* signInAlice("many@example.com");
    yield* outcomes.set("cookie", signedIn.cookieHeader);
    yield* Ref.set(roles, ["member"]);
  });

  When("that page render completes", function* () {
    const { outcomes } = yield* World;
    const page = yield* loadPage(yield* outcomes.getAs("cookie", isString), 5);
    yield* outcomes.set("evaluated", page.evaluated.length);
  });

  Then("exactly one subject resolution occurred", function* () {
    const { resolverCalls } = yield* World;
    assert.equal(yield* Ref.get(resolverCalls), 1);
  });

  Then("the subject was not re-resolved once per policy evaluated", function* () {
    const { outcomes, resolverCalls } = yield* World;
    // Ten decisions (delete + invite over five projects), one resolution.
    assert.ok((yield* outcomes.getAs("evaluated", isNumber)) >= 10);
    assert.equal(yield* Ref.get(resolverCalls), 1);
  });

  // ---- BEH-EA-192: hydrateDecisions seeds the client before first re-decide ----------------

  Given(
    "a server-dehydrated {string} payload and the resolved {string} for the current user",
    function* (_payload: string, _subject: string) {
      const { outcomes } = yield* World;
      const decision = yield* decideFor(aliceSubject, canDeleteProject, projectsFor(1)[0]);
      yield* outcomes.set(
        "wire",
        JSON.stringify(dehydrateDecisions([{ policy: canDeleteProject, decision }])),
      );
    },
  );

  When(
    "the client computes {string} and passes the result as {string}'s {string}",
    function* (_call: string, _provider: string, _prop: string) {
      const { outcomes } = yield* World;
      const wire: unknown = JSON.parse(yield* outcomes.getAs("wire", isString));
      const atoms = makeQadiAtoms(EvaluationServicesNone);
      const subjectId = String(Reflect.get(Object(wire), "subjectId"));
      const entries = Reflect.get(Object(wire), "entries");
      const payload = { subjectId, entries: Array.isArray(entries) ? entries : [] };
      const seeded = hydrateDecisions(atoms, payload, aliceSubject);
      const foreign = hydrateDecisions(atoms, payload, makeSubject({ id: "user:mallory" }));
      yield* outcomes.set("seeded", Array.from(seeded).length);
      yield* outcomes.set("foreignSeeded", Array.from(foreign).length);
    },
  );

  Then("the atoms are seeded from that payload before {string} mounts", function* (_provider: string) {
    const { outcomes } = yield* World;
    assert.ok((yield* outcomes.getAs("seeded", isNumber)) >= 1);
    // Bound to the subject: the same payload seeds nothing for anyone else.
    assert.equal(yield* outcomes.getAs("foreignSeeded", isNumber), 0);
  });
});
