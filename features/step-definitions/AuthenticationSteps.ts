// P20a/AH-003 tier 1, OCM-004: 09-authentication-middleware.feature over the real
// `Authentication`/`OptionalAuthentication`/`MachineAuthentication` middleware — see
// `AuthenticationWorld.ts` for how "which handler was tried, in what order" is observed.
import { Api } from "@awthaq/api";
import type { Sessions } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  arrange,
  configureApp,
  expiredSessionCookie,
  getActor,
  getOutcome,
  issueSecondSession,
  lastObservation,
  mintMachineCredentials,
  ProbeApi,
  ReorderedAuthentication,
  resolveCredentialPrincipal,
  pendingRequest,
  resolveSessionPrincipal,
  send,
  setOutcome,
  signIn,
  soleActor,
  type AppOptions,
  type World,
  type Observation,
} from "./AuthenticationWorld.ts";

// BEH-EA-072/REQ-EA-202: `Authentication` is built from `Sessions` and a `PrincipalResolver` and
// from nothing else — there is no configuration service, priority number or flag for it to read. A
// compile-time fact, checked by `tsc`: this stops type-checking the day the layer grows a knob.
type AuthenticationNeeds = Layer.Services<typeof Authentication.AuthenticationLive>;
const authenticationNeedsOnlySessionsAndResolver: [AuthenticationNeeds] extends [
  Sessions.Sessions | Authentication.PrincipalResolver,
]
  ? true
  : false = true;

/** The path of each probe group, by the middleware (or group) name a scenario uses. */
const pathOf = (name: string) => {
  switch (name) {
    case "Authentication":
    case "app":
      return "/app/who";
    case "OptionalAuthentication":
    case "optional":
      return "/optional/who";
    case "MachineAuthentication":
    case "machine":
      return "/machine/who";
    default:
      throw new Error(`no probe group for "${name}"`);
  }
};

/** The middleware key names a probe group's endpoints carry (what "carrying X" means). */
const middlewaresOf = (group: keyof typeof ProbeApi.groups) =>
  Object.values(ProbeApi.groups[group].endpoints).flatMap((endpoint) =>
    [...endpoint.middlewares].map((middleware) => middleware.key),
  );

/** `{ cookie: SessionCookie, bearer: BearerToken }` → ["cookie", "bearer"]. */
const declaredKeys = (record: string) => [...record.matchAll(/(\w+):/g)].map((match) => match[1]);

const subsequence = (sub: ReadonlyArray<string | undefined>, all: ReadonlyArray<string>) => {
  let next = 0;
  for (const item of all) if (item === sub[next]) next++;
  return next === sub.length;
};

const sameAnswer = (a: Observation, b: Observation) =>
  a.status === b.status &&
  a.principalTag === b.principalTag &&
  a.id === b.id &&
  a.sessionId === b.sessionId;

const groupKey = (group: string) => {
  switch (group) {
    case "app":
    case "optional":
    case "machine":
    case "reordered":
    case "open":
      return group;
    default:
      throw new Error(`no probe group named "${group}"`);
  }
};

/** Narrowing for the `unknown` outcome cells (no casts). */
const isObservation = (value: unknown): value is Observation =>
  typeof value === "object" && value !== null && "attempts" in value && "handlerRuns" in value;

const isMachineCredentials = (
  value: unknown,
): value is {
  readonly keyId: string;
  readonly apiKey: string;
  readonly clientId: string;
  readonly serviceToken: string;
} =>
  typeof value === "object" &&
  value !== null &&
  "apiKey" in value &&
  "serviceToken" in value &&
  "keyId" in value &&
  "clientId" in value;

export const authenticationSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-185/186/193/197: a signed-in user with a live session cookie ----

  Given(
    "a signed-in user {string} with a live, unexpired session cookie {string}",
    function* (name: string, cookieName: string) {
      assert.equal(cookieName, Api.SESSION_COOKIE_NAME);
      const actor = yield* signIn(name);
      yield* arrange({ cookie: actor.cookie });
    },
  );

  Given(
    "a signed-in user {string} with a live, unexpired session cookie",
    function* (name: string) {
      const actor = yield* signIn(name);
      yield* arrange({ cookie: actor.cookie });
    },
  );

  Given(
    "the {string} middleware's security record declares {string} before {string}",
    (middleware: string, first: string, second: string) =>
      Effect.sync(() => {
        assert.equal(middleware, "Authentication");
        const declared = Object.keys(Api.Authentication.security);
        assert.ok(declared.includes(first) && declared.includes(second));
        assert.ok(
          declared.indexOf(first) < declared.indexOf(second),
          `${first} must be declared before ${second}: ${declared.join(", ")}`,
        );
      }),
  );

  When(
    "{string} sends a request under {string} carrying only the session cookie",
    function* (name: string, middleware: string) {
      const actor = yield* getActor(name);
      yield* send(pathOf(middleware), { cookie: actor.cookie });
    },
  );

  Then(
    "the request resolves to {string}'s session via the cookie handler",
    function* (name: string) {
      const actor = yield* getActor(name);
      const observed = yield* lastObservation();
      assert.equal(observed.status, 200);
      assert.equal(observed.principalTag, "User");
      assert.equal(observed.id, actor.userId);
      assert.equal(observed.sessionId, actor.sessionId);
      assert.deepEqual(observed.resolvedBy, ["cookie"]);
    },
  );

  Then("the bearer handler is never attempted", function* () {
    const observed = yield* lastObservation();
    assert.ok(!observed.attempts.includes("bearer"), `attempted: ${observed.attempts.join(", ")}`);
  });

  Given(
    "{string} also presents an {string} header on the same request",
    function* (name: string, header: string) {
      assert.match(header, /^Authorization: Bearer /);
      // A second, independent session of the same user, so which credential resolved is visible.
      const second = yield* issueSecondSession(name);
      yield* setOutcome("bearerSessionId", second.sessionId);
      yield* arrange({ bearer: second.token });
    },
  );

  When("{string} sends the request under {string}", function* (_name: string, middleware: string) {
    const pending = yield* pendingRequest();
    yield* send(pathOf(middleware), pending);
  });

  Then(
    "the cookie handler resolves the session before the bearer handler is attempted",
    function* () {
      const observed = yield* lastObservation();
      const bearerSessionId = yield* getOutcome("bearerSessionId");
      assert.equal(observed.status, 200);
      assert.deepEqual(observed.resolvedBy, ["cookie"]);
      assert.notEqual(observed.sessionId, bearerSessionId, "the cookie's session must win");
      assert.ok(observed.attempts.includes("cookie"));
    },
  );

  Then(
    "the bearer handler is not consulted because the cookie handler already succeeded",
    function* () {
      const observed = yield* lastObservation();
      assert.ok(
        !observed.attempts.includes("bearer"),
        `attempted: ${observed.attempts.join(", ")}`,
      );
    },
  );

  // ---- REQ-EA-187/188: the bearer handler ----

  Given(
    "a signed-in user {string} whose session token is presented as {string} with no cookie jar",
    function* (name: string, header: string) {
      assert.match(header, /^Authorization: Bearer /);
      const actor = yield* signIn(name);
      yield* arrange({ bearer: actor.token });
    },
  );

  When(
    "{string}'s native client sends a request under {string}",
    function* (_name: string, middleware: string) {
      const pending = yield* pendingRequest();
      assert.equal(pending.cookie, undefined, "a native client has no cookie jar");
      yield* send(pathOf(middleware), pending);
    },
  );

  Then(
    "the bearer handler resolves the same session through the shared {string}\\/{string} path the cookie handler uses",
    function* (_sessions: string, _resolver: string) {
      const observed = yield* lastObservation();
      const actor = yield* soleActor();
      assert.equal(observed.status, 200);
      assert.deepEqual(observed.resolvedBy, ["bearer"]);
      // The very session row the cookie names — no second, bearer-only session model.
      assert.equal(observed.sessionId, actor.sessionId);
    },
  );

  Then(
    "the resulting Principal has the same shape as if {string} had presented the equivalent session cookie",
    function* (name: string) {
      const actor = yield* getActor(name);
      const viaBearer = yield* lastObservation();
      const viaCookie = yield* send("/app/who", { cookie: actor.cookie });
      assert.ok(
        sameAnswer(viaBearer, viaCookie),
        "bearer and cookie must yield the same Principal",
      );
      assert.deepEqual(viaCookie.resolvedBy, ["cookie"]);
    },
  );

  Given(
    "a request under {string} carrying no session cookie but a valid bearer token",
    function* (middleware: string) {
      const actor = yield* signIn("bearer-only-user");
      yield* setOutcome("path", pathOf(middleware));
      yield* arrange({ bearer: actor.token });
    },
  );

  When("the request is authenticated", function* () {
    const pending = yield* pendingRequest();
    yield* send(String(yield* getOutcome("path")), pending);
  });

  Then("the cookie handler fails to resolve a session first", function* () {
    const observed = yield* lastObservation();
    const cookieAt = observed.attempts.indexOf("cookie");
    assert.ok(cookieAt >= 0, "the cookie handler must have been attempted");
    assert.ok(
      cookieAt < observed.attempts.indexOf("bearer"),
      `order: ${observed.attempts.join(", ")}`,
    );
    assert.ok(!observed.resolvedBy.includes("cookie"));
  });

  Then("the bearer handler is then tried and resolves the session", function* () {
    const observed = yield* lastObservation();
    assert.equal(observed.status, 200);
    assert.deepEqual(observed.resolvedBy, ["bearer"]);
    assert.equal(observed.principalTag, "User");
  });

  // ---- REQ-EA-189..192: Authentication fails closed, OptionalAuthentication does not ----

  Given(
    "a request under a group carrying {string} with no session cookie and no bearer token",
    function* (middleware: string) {
      yield* setOutcome("path", pathOf(middleware));
    },
  );

  Given(
    "a request under a group carrying {string} presenting an expired session cookie and no bearer token",
    function* (middleware: string) {
      yield* setOutcome("path", pathOf(middleware));
      yield* arrange({ cookie: yield* expiredSessionCookie() });
    },
  );

  Given(
    "a request under a group carrying {string} presenting an expired session cookie",
    function* (middleware: string) {
      yield* setOutcome("path", pathOf(middleware));
      yield* arrange({ cookie: yield* expiredSessionCookie() });
    },
  );

  When("the request is processed", function* () {
    const pending = yield* pendingRequest();
    yield* send(String(yield* getOutcome("path")), pending);
  });

  Then("the request fails with a typed {string} error", function* (tag: string) {
    const observed = yield* lastObservation();
    assert.equal(observed.tag, tag);
  });

  Then("the response is {string}", function* (expected: string) {
    const observed = yield* lastObservation();
    assert.equal(`${observed.status} ${observed.tag}`, expected);
  });

  Then("no handler code for the endpoint runs", function* () {
    const observed = yield* lastObservation();
    assert.equal(observed.handlerRuns, 0);
  });

  Then("both the cookie handler and the bearer handler fail to resolve a session", function* () {
    const observed = yield* lastObservation();
    assert.ok(observed.attempts.includes("cookie") && observed.attempts.includes("bearer"));
    assert.deepEqual(observed.resolvedBy, []);
  });

  Then("the request is not failed", function* () {
    const observed = yield* lastObservation();
    assert.equal(observed.status, 200);
    assert.equal(observed.tag, undefined);
    assert.equal(observed.handlerRuns, 1);
  });

  Then(
    "{string} is provided to the handler as {string}",
    function* (service: string, principal: string) {
      assert.equal(service, "CurrentPrincipal");
      assert.equal(principal, "AnonymousPrincipal");
      const observed = yield* lastObservation();
      assert.equal(observed.principalTag, "Anonymous");
      assert.equal(observed.id, Api.anonymousPrincipal.ref.id);
    },
  );

  // ---- REQ-EA-193: a valid credential under OptionalAuthentication ----

  When(
    "{string} sends a request under a group carrying {string}",
    function* (name: string, middleware: string) {
      const actor = yield* getActor(name);
      const optional = yield* send(pathOf(middleware), { cookie: actor.cookie });
      const required = yield* send("/app/who", { cookie: actor.cookie });
      yield* setOutcome("optional", optional);
      yield* setOutcome("required", required);
    },
  );

  Then(
    "{string} is provided to the handler as {string}'s resolved Principal",
    function* (_service: string, name: string) {
      const actor = yield* getActor(name);
      const optional = yield* getOutcome("optional");
      assert.ok(isObservation(optional));
      assert.equal(optional.status, 200);
      assert.equal(optional.principalTag, "User");
      assert.equal(optional.id, actor.userId);
      assert.equal(optional.sessionId, actor.sessionId);
    },
  );

  Then(
    "the resolution logic used is the same one {string} uses for a present credential",
    function* (_middleware: string) {
      const optional = yield* getOutcome("optional");
      const required = yield* getOutcome("required");
      assert.ok(isObservation(optional) && isObservation(required));
      assert.ok(sameAnswer(optional, required));
      assert.deepEqual(optional.resolvedBy, required.resolvedBy);
    },
  );

  // ---- REQ-EA-194..196: PrincipalResolver ----

  Given("a resolved, live {string} for {string}", function* (_kind: string, name: string) {
    yield* signIn(name);
  });

  When("{string} resolves the session", function* (_service: string) {
    const actor = yield* soleActor();
    yield* setOutcome("principal", yield* resolveSessionPrincipal(actor.token));
  });

  Then("a {string} value is produced for {string}", function* (_kind: string, name: string) {
    const actor = yield* getActor(name);
    const principal = yield* getOutcome("principal");
    assert.ok(Schema.is(Api.Principal)(principal), "must be a member of the Principal union");
    assert.equal(principal._tag, "User");
    assert.equal(principal.ref.id, actor.userId);
  });

  Given("a resolved bearer credential that identifies a service caller", function* () {
    yield* setOutcome("machine", yield* mintMachineCredentials());
  });

  When("{string} resolves the credential", function* (_service: string) {
    const machine = yield* getOutcome("machine");
    assert.ok(isMachineCredentials(machine));
    // The principal-only wrapper `SubjectExtractor` (Path B) shares with the middleware: a
    // service bearer token is claimed by the registered credential resolver, not a session.
    yield* setOutcome(
      "principal",
      yield* resolveCredentialPrincipal(machine.serviceToken, "bearer"),
    );
  });

  Then("a {string} value is produced for that service caller", function* (_kind: string) {
    const machine = yield* getOutcome("machine");
    const principal = yield* getOutcome("principal");
    assert.ok(isMachineCredentials(machine));
    assert.ok(Schema.is(Api.Principal)(principal));
    assert.equal(principal._tag, "Service");
    assert.equal(principal.ref.id, machine.clientId);
  });

  Then("only a {string} is produced", function* (_kind: string) {
    const principal = yield* getOutcome("principal");
    assert.ok(Schema.is(Api.Principal)(principal));
    // A Principal names who is asking and how the session authenticated; it carries no verdict.
    for (const decisionField of ["roles", "permissions", "allowed", "decision", "effect"]) {
      assert.ok(!(decisionField in principal), `a Principal must not carry "${decisionField}"`);
    }
  });

  Then(
    "no authorization decision is made, since that responsibility belongs to qadi's {string} downstream",
    function* (_subjectResolver: string) {
      // The resolver is built from nothing (`PrincipalResolverLive: Layer<PrincipalResolver>`, no
      // requirements) and its whole surface is `resolve` — no authorizer, no qadi service to ask.
      const resolver = yield* Authentication.PrincipalResolver.pipe(
        Effect.provide(Authentication.PrincipalResolverLive),
      );
      assert.deepEqual(Object.keys(resolver), ["resolve"]);
    },
  );

  // ---- REQ-EA-197/198: CurrentPrincipal is an ordinary service ----

  Given(
    "a signed-in user {string} authenticated under a group carrying {string}",
    function* (name: string, middleware: string) {
      const actor = yield* signIn(name);
      yield* setOutcome("path", pathOf(middleware));
      yield* arrange({ cookie: actor.cookie });
    },
  );

  When("{string}'s handler runs and reads {string}", function* (_name: string, service: string) {
    assert.equal(service, "CurrentPrincipal");
    const pending = yield* pendingRequest();
    yield* send(String(yield* getOutcome("path")), pending);
  });

  Then(
    "the handler receives {string}'s Principal via an ordinary service read, with no second mechanism involved",
    function* (name: string) {
      const actor = yield* getActor(name);
      const observed = yield* lastObservation();
      assert.equal(observed.handlerRuns, 1);
      assert.equal(observed.principalTag, "User");
      assert.equal(observed.id, actor.userId);
    },
  );

  Given(
    "a group that carries neither {string} nor {string}",
    function* (first: string, second: string) {
      const carried = middlewaresOf("open");
      assert.ok(
        !carried.includes(first) && !carried.includes(second),
        `carries: ${carried.join()}`,
      );
      // A live session exists, to show that even a valid credential supplies nothing here.
      const actor = yield* signIn("open-group-visitor");
      yield* arrange({ cookie: actor.cookie });
    },
  );

  When("a handler in that group is built", function* () {
    const pending = yield* pendingRequest();
    yield* send("/open/who", pending);
  });

  Then("{string} is not present in that handler's available context", function* (service: string) {
    assert.equal(service, "CurrentPrincipal");
    const observed = yield* lastObservation();
    assert.equal(observed.handlerRuns, 1);
    assert.equal(observed.principalTag, "absent");
    assert.deepEqual(observed.attempts, [], "no authentication middleware ran for this group");
  });

  // ---- REQ-EA-199..201: different groups, different schemes ----

  Given("a group {string} carrying {string}", function* (group: string, middleware: string) {
    assert.ok(middlewaresOf(groupKey(group)).includes(middleware));
    yield* setOutcome("machine", yield* mintMachineCredentials());
  });

  When(
    "a request presents a valid {string} header to the {string} group",
    function* (header: string, group: string) {
      assert.equal(header, Api.API_KEY_HEADER_NAME);
      const machine = yield* getOutcome("machine");
      assert.ok(isMachineCredentials(machine));
      yield* send(pathOf(group), { apiKey: machine.apiKey });
    },
  );

  Then("the request resolves to an {string} carrying the key's scopes", function* (kind: string) {
    assert.equal(kind, "ApiKeyPrincipal");
    const machine = yield* getOutcome("machine");
    assert.ok(isMachineCredentials(machine));
    const observed = yield* lastObservation();
    assert.equal(observed.status, 200);
    assert.equal(observed.principalTag, "ApiKey");
    assert.equal(observed.id, machine.keyId);
    assert.deepEqual(observed.scopes, ["reports:read"]);
    assert.deepEqual(observed.resolvedBy, ["apiKey"]);
  });

  When(
    "a signed-in user {string} requests an endpoint in the {string} group",
    function* (name: string, group: string) {
      const actor = yield* signIn(name);
      yield* send(pathOf(group), { cookie: actor.cookie });
    },
  );

  Then(
    "the request resolves to the ordinary Principal union {string} produces",
    function* (middleware: string) {
      assert.equal(middleware, "Authentication");
      const observed = yield* lastObservation();
      assert.equal(observed.status, 200);
      assert.equal(observed.principalTag, "User");
      assert.deepEqual(observed.resolvedBy, ["cookie"]);
    },
  );

  Given(
    "a composed contract containing group {string} under {string} and group {string} under {string}",
    function* (
      machineGroup: string,
      machineMiddleware: string,
      appGroup: string,
      appMiddleware: string,
    ) {
      assert.ok(middlewaresOf(groupKey(machineGroup)).includes(machineMiddleware));
      assert.ok(middlewaresOf(groupKey(appGroup)).includes(appMiddleware));
      yield* setOutcome("machine", yield* mintMachineCredentials());
      yield* signIn("alice");
    },
  );

  When("each group's requests are authenticated", function* () {
    const machine = yield* getOutcome("machine");
    assert.ok(isMachineCredentials(machine));
    const alice = yield* getActor("alice");
    yield* setOutcome("machineWithKey", yield* send("/machine/who", { apiKey: machine.apiKey }));
    yield* setOutcome("appWithKey", yield* send("/app/who", { apiKey: machine.apiKey }));
    yield* setOutcome("machineWithCookie", yield* send("/machine/who", { cookie: alice.cookie }));
    yield* setOutcome("appWithCookie", yield* send("/app/who", { cookie: alice.cookie }));
  });

  Then(
    "{string}'s scheme selection has no effect on how {string}'s requests are authenticated, and vice versa",
    function* (_machine: string, _app: string) {
      const machineWithKey = yield* getOutcome("machineWithKey");
      const appWithKey = yield* getOutcome("appWithKey");
      const machineWithCookie = yield* getOutcome("machineWithCookie");
      const appWithCookie = yield* getOutcome("appWithCookie");
      assert.ok(
        isObservation(machineWithKey) &&
          isObservation(appWithKey) &&
          isObservation(machineWithCookie) &&
          isObservation(appWithCookie),
      );
      // machine accepts the key; app neither accepts it nor even tries that scheme...
      assert.equal(machineWithKey.principalTag, "ApiKey");
      assert.equal(appWithKey.status, 401);
      assert.ok(!appWithKey.attempts.includes("apiKey"));
      // ...and a session authenticates identically under both, whatever else machine adds.
      assert.equal(machineWithCookie.principalTag, "User");
      assert.ok(sameAnswer(machineWithCookie, appWithCookie));
    },
  );

  // ---- REQ-EA-202/203: the declaration order is the only ordering ----

  Given(
    "the {string} middleware's declared security record {string}",
    (middleware: string, record: string) =>
      Effect.sync(() => {
        assert.equal(middleware, "Authentication");
        // `impersonation` (APS-006) is declared ahead of both; the relative order is the claim.
        const declared = Object.keys(Api.Authentication.security);
        assert.ok(subsequence(declaredKeys(record), declared), `declared: ${declared.join()}`);
      }),
  );

  When("the application is configured in any way other than editing that record", function* () {
    assert.ok(authenticationNeedsOnlySessionsAndResolver);
    const variants: ReadonlyArray<NonNullable<AppOptions["variant"]>> = [
      "default",
      "userFacts",
      "shortIdle",
      "claimingResolver",
    ];
    const orders: Record<string, ReadonlyArray<string>> = {};
    for (const variant of variants) {
      yield* configureApp({ variant });
      const actor = yield* signIn("alice");
      const second = yield* issueSecondSession("alice");
      const observed = yield* send("/app/who", { cookie: actor.cookie, bearer: second.token });
      assert.equal(observed.status, 200);
      orders[variant] = observed.attempts;
      // Both credentials are valid, so which one resolved is which was tried first.
      assert.deepEqual(observed.resolvedBy, ["cookie"], `variant ${variant}`);
    }
    yield* setOutcome("orders", orders);
  });

  Then(
    "no configuration, priority number, or runtime flag changes which scheme is tried first",
    function* () {
      const orders = yield* getOutcome("orders");
      assert.ok(typeof orders === "object" && orders !== null);
      for (const [variant, attempts] of Object.entries(orders)) {
        assert.ok(Array.isArray(attempts));
        assert.ok(!attempts.includes("bearer"), `${variant}: bearer was attempted ahead of cookie`);
        assert.equal(attempts.at(-1), "cookie", `${variant}: ${attempts.join()}`);
      }
    },
  );

  Given(
    "the {string} middleware's security record is redeclared as {string}",
    (middleware: string, record: string) =>
      Effect.sync(() => {
        assert.equal(middleware, "Authentication");
        assert.deepEqual(declaredKeys(record), Object.keys(ReorderedAuthentication.security));
      }),
  );

  When(
    "a request presenting both a valid bearer token and a valid session cookie is authenticated",
    function* () {
      const actor = yield* signIn("alice");
      const second = yield* issueSecondSession("alice");
      yield* setOutcome("cookieSessionId", actor.sessionId);
      yield* setOutcome("bearerSessionId", second.sessionId);
      yield* setOutcome(
        "reordered",
        yield* send("/reordered/who", { cookie: actor.cookie, bearer: second.token }),
      );
      // The same two credentials against the unchanged declaration.
      yield* setOutcome(
        "declared",
        yield* send("/app/who", { cookie: actor.cookie, bearer: second.token }),
      );
    },
  );

  Then("the bearer handler is tried first", function* () {
    const reordered = yield* getOutcome("reordered");
    assert.ok(isObservation(reordered));
    assert.equal(reordered.attempts[0], "bearer");
    assert.deepEqual(reordered.resolvedBy, ["bearer"]);
    assert.equal(reordered.sessionId, yield* getOutcome("bearerSessionId"));
  });

  Then("the try-order changed only because the declaration itself changed", function* () {
    const declared = yield* getOutcome("declared");
    assert.ok(isObservation(declared));
    // Same handlers, same credentials: the original declaration still resolves the cookie's session.
    assert.deepEqual(declared.resolvedBy, ["cookie"]);
    assert.ok(!declared.attempts.includes("bearer"));
    assert.equal(declared.sessionId, yield* getOutcome("cookieSessionId"));
  });
});
