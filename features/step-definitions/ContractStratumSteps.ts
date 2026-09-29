// P20a/AH-003, decision 36 Tier 4: 01-contract-and-persistence/04-contract-stratum.feature
// (BEH-EA-025..032). Principals and errors are real schemas exercised through encode/decode and
// the real HTTP surface; the middleware scenarios run against probe groups behind the shipped
// `Authentication`/`OptionalAuthentication` with traced scheme handlers; the CSRF client rule
// (INV-EA-011) is compile-time and goes through `ContractTypeGates.ts`.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { Api } from "@awthaq/api";
import { Auth, Sessions, Users } from "@awthaq/core";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import {
  actorNamed,
  authProbeApp,
  coreOnlyApp,
  passwordApp,
  ReorderedAuthentication,
  send,
  signInCore,
  signInProbe,
  type World as AppWorld,
} from "./ContractStratumWorld.ts";
import { CsrfGuardedApi } from "./ContractTypeGates.ts";
import {
  assertTypeGate,
  cell,
  isObject,
  put,
  take,
  type World as ScratchWorld,
} from "./FoundationsWorld.ts";
import { LegacyLogin, LoginHost, PasswordFixture, SessionImposter } from "./PluginFixtures.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";

const GATES = "ContractTypeGates.ts";

const principals = cell(
  "principal",
  (value): value is Api.Principal => isObject(value) && "_tag" in value && "ref" in value,
);
const decoded = cell(
  "decoded",
  (value): value is Api.Principal => isObject(value) && "_tag" in value && "ref" in value,
);
const decodeFailed = cell("decodeFailed", (value): value is boolean => typeof value === "boolean");
const payload = cell("payload", (value): value is object => isObject(value));

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;
}
const replies = cell(
  "replies",
  (value): value is ReadonlyArray<Reply> =>
    Array.isArray(value) && value.every((entry) => isObject(entry) && "status" in entry),
);
const tuple = cell("tuple", (value): value is string => typeof value === "string");
const composeOutcome = cell(
  "composeOutcome",
  (
    value,
  ): value is ReadonlyArray<{
    readonly tag: string;
    readonly groupId: string;
    readonly first: string;
    readonly second: string;
    readonly message: string;
  }> => Array.isArray(value),
);
const probeReply = cell(
  "probeReply",
  (
    value,
  ): value is {
    readonly status: number;
    readonly who: { readonly tag: string; readonly id: string } | undefined;
    readonly attempts: ReadonlyArray<string>;
    readonly resolvedBy: ReadonlyArray<string>;
  } => isObject(value) && "attempts" in value,
);
const presented = cell(
  "presented",
  (
    value,
  ): value is {
    readonly path: string;
    readonly cookie?: string;
    readonly bearer?: string;
  } => isObject(value) && "path" in value,
);
const cookieUserId = cell("cookieUserId", (value): value is string => typeof value === "string");
const bearerUserId = cell("bearerUserId", (value): value is string => typeof value === "string");
const strings = cell("strings", (value): value is ReadonlyArray<string> => Array.isArray(value));

const ref = (id: string) => new Api.PrincipalRef({ type: "user", id });

const principalFor = (tag: string): Api.Principal => {
  switch (tag) {
    case "User":
      return new Api.UserPrincipal({ ref: ref("u-1"), sessionId: "s-1" });
    case "ApiKey":
      return new Api.ApiKeyPrincipal({ ref: ref("k-1"), scopes: ["orders:read"] });
    case "Service":
      return new Api.ServicePrincipal({ ref: ref("svc-1"), scopes: ["orders:write"] });
    case "Anonymous":
      return Api.anonymousPrincipal;
    default:
      throw new Error(`"${tag}" is not a declared principal tag`);
  }
};

const encodePrincipal = Schema.encodeSync(Api.Principal);
const decodePrincipal = Schema.decodeUnknownSync(Api.Principal);

const json = (text: string): unknown => JSON.parse(text);

const bodyTag = (text: string): string | undefined => {
  const parsed = json(text);
  return isObject(parsed) && "_tag" in parsed && typeof parsed._tag === "string"
    ? parsed._tag
    : undefined;
};

/** Sign a user up on the password app; returns the address. */
const signUp = (handler: (request: Request) => Promise<Response>, email: string) =>
  send(handler, "POST", "/password/sign-up", { body: { email, password: STRONG_PASSWORD } });

const signInAttempt = (
  handler: (request: Request) => Promise<Response>,
  email: string,
  password: string,
) => send(handler, "POST", "/password/sign-in", { body: { email, password } });

/** The bytes a client would use to tell two replies apart: status, body, and the headers that could carry a hint. */
const fingerprint = (reply: Reply) => ({
  status: reply.status,
  body: reply.body,
  contentType: reply.headers.get("content-type"),
  setCookie: reply.headers.get("set-cookie") !== null,
});

const probeWho = (text: string) => {
  const parsed = json(text);
  if (
    isObject(parsed) &&
    "tag" in parsed &&
    "id" in parsed &&
    typeof parsed.tag === "string" &&
    typeof parsed.id === "string"
  ) {
    return { tag: parsed.tag, id: parsed.id };
  }
  return undefined;
};

export const contractStratumSteps = defineSteps<ScratchWorld | AppWorld>(
  ({ Given, When, Then }) => {
    // ---- BEH-EA-025: the Principal union ----

    Given(
      "a {string} principal value carrying a PrincipalRef with a type and an id",
      function* (tag: string) {
        yield* put(principals, principalFor(tag));
      },
    );

    When("the value is encoded and then decoded against the Principal schema", function* () {
      const original = yield* take(principals);
      yield* put(decoded, decodePrincipal(encodePrincipal(original)));
    });

    Then(
      "the round-trip succeeds and the decoded value's tag is still {string}",
      function* (tag: string) {
        const result = yield* take(decoded);
        assert.equal(result._tag, tag);
        assert.deepEqual(result, yield* take(principals));
      },
    );

    Given(
      "a payload whose {string} is not one of {string}, {string}, {string}, or {string}",
      function* (field: string, ...tags: ReadonlyArray<string>) {
        assert.equal(field, "_tag");
        assert.deepEqual(tags, ["User", "ApiKey", "Service", "Anonymous"]);
        yield* put(payload, { _tag: "Robot", ref: { type: "robot", id: "r-1" } });
      },
    );

    When("the payload is decoded against the Principal schema", function* () {
      const candidate = yield* take(payload);
      const attempt = yield* Effect.exit(Effect.try(() => decodePrincipal(candidate)));
      yield* put(decodeFailed, attempt._tag === "Failure");
    });

    Then("decoding fails", function* () {
      assert.equal(yield* take(decodeFailed), true);
    });

    Then("no principal kind is reachable except through one of the declared tags", function* () {
      yield* Effect.void; // an assertion-only step: nothing to await
      // The union has exactly the four declared members; the undeclared tag above was refused.
      assert.equal(Api.Principal.members.length, 4);
    });

    Given(
      "a UserPrincipal for a signed-in user {string} impersonating another PrincipalRef",
      function* (name: string) {
        assert.equal(name, "alice");
        yield* put(
          principals,
          new Api.UserPrincipal({
            ref: ref("alice"),
            sessionId: "s-alice",
            actingAs: ref("bob"),
          }),
        );
      },
    );

    When("the principal is decoded", function* () {
      yield* put(decoded, decodePrincipal(encodePrincipal(yield* take(principals))));
    });

    Then(
      "{string}'s UserPrincipal carries the impersonated reference in its actingAs field",
      function* (name: string) {
        assert.equal(name, "alice");
        const result = yield* take(decoded);
        assert.ok(result._tag === "User");
        if (result._tag !== "User") return;
        assert.equal(result.ref.id, "alice");
        assert.deepEqual(result.actingAs, ref("bob"));
      },
    );

    Then(
      "the impersonated identity is represented without introducing a new principal tag",
      function* () {
        const result = yield* take(decoded);
        assert.equal(result._tag, "User");
        assert.equal(Api.Principal.members.length, 4);
      },
    );

    // ---- BEH-EA-027: contract errors, enumeration safety ----

    Given("the {string} contract error", function* (name: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(name, "InvalidCredentials");
    });

    When("a handler returns {string} as a failure", function* (_name: string) {
      // The real handler: a wrong password through `POST /password/sign-in`.
      const { handler } = yield* passwordApp;
      const email = "err-status@example.com";
      yield* signUp(handler, email);
      yield* put(replies, [yield* signInAttempt(handler, email, "not the password")]);
    });

    Then(
      "the response status is the error's own declared {string} httpApiStatus",
      function* (status: string) {
        const [reply] = yield* take(replies);
        assert.ok(reply !== undefined);
        assert.equal(reply.status, Number(status));
        assert.equal(bodyTag(reply.body), "InvalidCredentials");
        // ...and the wire body decodes as the contract's own error class.
        Schema.decodeUnknownSync(Api.InvalidCredentials)(json(reply.body));
      },
    );

    Given("a sign-in attempt with an email that does not exist in the system", function* () {
      yield* put(strings, ["nobody@example.com"]);
    });

    Given(
      "a separate sign-in attempt with an email that exists but the wrong password",
      function* () {
        const { handler } = yield* passwordApp;
        yield* signUp(handler, "exists@example.com");
        yield* put(strings, [...(yield* take(strings)), "exists@example.com"]);
      },
    );

    When("both attempts are submitted", function* () {
      const { handler } = yield* passwordApp;
      const [unknown, existing] = yield* take(strings);
      assert.ok(unknown !== undefined && existing !== undefined);
      yield* put(replies, [
        yield* signInAttempt(handler, unknown, "not the password"),
        yield* signInAttempt(handler, existing, "not the password"),
      ]);
    });

    Then(
      "both attempts fail with the identical {string} error and status",
      function* (name: string) {
        const [unknownReply, existingReply] = yield* take(replies);
        assert.ok(unknownReply !== undefined && existingReply !== undefined);
        assert.equal(unknownReply.status, 401);
        assert.equal(bodyTag(unknownReply.body), name);
        assert.deepEqual(fingerprint(unknownReply), fingerprint(existingReply));
      },
    );

    When("the attempt is submitted", function* () {
      const { handler } = yield* passwordApp;
      const [unknown] = yield* take(strings);
      assert.ok(unknown !== undefined);
      yield* put(replies, [yield* signInAttempt(handler, unknown, "not the password")]);
    });

    Then(
      "the response is indistinguishable from a wrong-password response for an existing email",
      function* () {
        const { handler } = yield* passwordApp;
        yield* signUp(handler, "known@example.com");
        const wrongPassword = yield* signInAttempt(
          handler,
          "known@example.com",
          "not the password",
        );
        const [unknownReply] = yield* take(replies);
        assert.ok(unknownReply !== undefined);
        assert.deepEqual(fingerprint(unknownReply), fingerprint(wrongPassword));
      },
    );

    Then("no observable difference discloses account existence", function* () {
      const [unknownReply] = yield* take(replies);
      assert.ok(unknownReply !== undefined);
      // The body carries the tag and nothing else: no field can say "no such user".
      assert.deepEqual(json(unknownReply.body), { _tag: "InvalidCredentials" });
    });

    Given("the {string} and {string} contract errors", function* (first: string, second: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([first, second], ["InvalidCredentials", "Unauthenticated"]);
    });

    When("a handler catches failures by error tag", function* () {
      const failWith = (error: Api.InvalidCredentials | Api.Unauthenticated) =>
        Effect.fail(error).pipe(
          Effect.catchTag("InvalidCredentials", () =>
            Effect.succeed("caught-as-invalid-credentials"),
          ),
          Effect.match({
            onFailure: (rest) => `escaped:${rest._tag}`,
            onSuccess: (value) => value,
          }),
        );
      yield* put(strings, [
        yield* failWith(new Api.InvalidCredentials()),
        yield* failWith(new Api.Unauthenticated()),
      ]);
    });

    Then(
      "catching {string} does not also catch {string}",
      function* (caught: string, other: string) {
        assert.deepEqual([caught, other], ["InvalidCredentials", "Unauthenticated"]);
        assert.deepEqual(yield* take(strings), [
          "caught-as-invalid-credentials",
          "escaped:Unauthenticated",
        ]);
      },
    );

    // ---- BEH-EA-028/029: multi-scheme middleware ----

    const authenticate = Effect.gen(function* () {
      const spec = yield* take(presented);
      const app = yield* authProbeApp;
      // Only what *this* request tries and resolves.
      yield* Ref.set(app.attempts, []);
      yield* Ref.set(app.resolvedBy, []);
      const reply = yield* send(app.handler, "GET", spec.path, {
        ...(spec.cookie === undefined ? {} : { cookie: spec.cookie }),
        ...(spec.bearer === undefined ? {} : { bearer: spec.bearer }),
      });
      yield* put(probeReply, {
        status: reply.status,
        who: reply.status === 200 ? probeWho(reply.body) : undefined,
        attempts: yield* Ref.get(app.attempts),
        resolvedBy: yield* Ref.get(app.resolvedBy),
      });
    });

    Given(
      "the Authentication middleware's security record declares {string} before {string}",
      function* (first: string, second: string) {
        const declared = first === "cookie" ? Api.Authentication : ReorderedAuthentication;
        const order = Object.keys(declared.security).filter((key) => key !== "impersonation");
        assert.deepEqual(order, [first, second]);
        yield* put(presented, {
          path: first === "cookie" ? "/app/who" : "/reordered/who",
        });
      },
    );

    const withCredentials = (cookie: boolean, bearer: boolean) =>
      Effect.gen(function* () {
        const spec = yield* take(presented);
        const alice = yield* signInProbe("cred-alice");
        const bob = yield* signInProbe("cred-bob");
        yield* put(cookieUserId, alice.userId);
        yield* put(bearerUserId, bob.userId);
        yield* put(presented, {
          ...spec,
          ...(cookie ? { cookie: alice.cookie } : {}),
          ...(bearer ? { bearer: bob.token } : {}),
        });
      });

    Given("a request carries both a valid session cookie and a valid bearer token", function* () {
      yield* withCredentials(true, true);
    });

    Given("a request carries no session cookie but a valid bearer token", function* () {
      yield* withCredentials(false, true);
    });

    Given(
      "a request carries neither a valid session cookie nor a valid bearer token",
      function* () {
        yield* withCredentials(false, false);
      },
    );

    When("the request is authenticated", function* () {
      yield* authenticate;
    });

    Then("the cookie scheme resolves the principal", function* () {
      const reply = yield* take(probeReply);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.resolvedBy, ["cookie"]);
      assert.equal(reply.who?.id, yield* take(cookieUserId));
    });

    Then("the bearer scheme is never tried", function* () {
      assert.ok(!(yield* take(probeReply)).attempts.includes("bearer"));
    });

    Then("the bearer scheme resolves the principal", function* () {
      const reply = yield* take(probeReply);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.resolvedBy, ["bearer"]);
      assert.equal(reply.who?.id, yield* take(bearerUserId));
    });

    Then("authentication fails", function* () {
      const reply = yield* take(probeReply);
      assert.equal(reply.status, 401);
      assert.ok(reply.attempts.includes("cookie") && reply.attempts.includes("bearer"));
    });

    Then(
      "no separate ordering configuration overrides the record's declared key order",
      function* () {
        // The same two credentials through the two declarations: the cookie declaration resolves the
        // cookie's user, the bearer-first declaration the bearer's — the record's key order is the
        // only thing that differs (`ReorderedAuthentication` delegates to `Authentication`'s handlers).
        const app = yield* authProbeApp;
        const spec = yield* take(presented);
        const viaCookieFirst = yield* send(app.handler, "GET", "/app/who", {
          ...(spec.cookie === undefined ? {} : { cookie: spec.cookie }),
          ...(spec.bearer === undefined ? {} : { bearer: spec.bearer }),
        });
        const cookieFirstUser = probeWho(viaCookieFirst.body)?.id;
        assert.equal(cookieFirstUser, yield* take(cookieUserId));
        assert.notEqual(cookieFirstUser, (yield* take(probeReply)).who?.id);
      },
    );

    // ---- BEH-EA-029: OptionalAuthentication ----

    Given("a group of endpoints under {string}", function* (middleware: string) {
      assert.equal(middleware, "OptionalAuthentication");
      yield* put(presented, { path: "/optional/who" });
    });

    Given("a request with no session cookie and no bearer token", function* () {
      yield* put(presented, { path: "/optional/who" });
    });

    Given("a signed-in user {string} with a valid session cookie", function* (name: string) {
      const user = yield* signInProbe(name);
      yield* put(cookieUserId, user.userId);
      yield* put(presented, { path: "/optional/who", cookie: user.cookie });
    });

    When("the request reaches the handler", function* () {
      yield* authenticate;
    });

    When("{string}'s request reaches the handler", function* (_name: string) {
      yield* authenticate;
    });

    Then("CurrentPrincipal is provided", function* () {
      const reply = yield* take(probeReply);
      assert.equal(reply.status, 200);
      assert.ok(reply.who !== undefined, "the handler read a CurrentPrincipal");
    });

    Then("CurrentPrincipal resolves to AnonymousPrincipal", function* () {
      assert.equal((yield* take(probeReply)).who?.tag, "Anonymous");
    });

    Then("the request is not failed with {string}", function* (tag: string) {
      const reply = yield* take(probeReply);
      assert.equal(reply.status, 200);
      assert.notEqual(tag, undefined);
    });

    Then("CurrentPrincipal resolves to {string}'s UserPrincipal", function* (_name: string) {
      const reply = yield* take(probeReply);
      assert.equal(reply.who?.tag, "User");
      assert.equal(reply.who?.id, yield* take(cookieUserId));
    });

    When("the handler reads CurrentPrincipal and branches on its tag", function* () {
      const app = yield* authProbeApp;
      const user = yield* signInProbe("branching");
      const anonymous = yield* send(app.handler, "GET", "/optional/who");
      const signedIn = yield* send(app.handler, "GET", "/optional/who", { cookie: user.cookie });
      yield* put(strings, [
        `${anonymous.status}:${probeWho(anonymous.body)?.tag}`,
        `${signedIn.status}:${probeWho(signedIn.body)?.tag}`,
      ]);
    });

    Then(
      "both the signed-in branch and the AnonymousPrincipal branch are expressed as success outcomes",
      function* () {
        assert.deepEqual(yield* take(strings), ["200:Anonymous", "200:User"]);
      },
    );

    Then("no parallel catchTag\\({string}\\) path is needed", function* (tag: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(tag, "Unauthenticated");
      // The declaration itself: `OptionalAuthentication` cannot fail with `Unauthenticated`.
      assert.ok(!Api.OptionalAuthentication.error.has(Api.Unauthenticated));
    });

    // ---- BEH-EA-030: CsrfProtection gates client generation ----

    Given("an HttpApi group carrying {string}", function* (middleware: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(middleware, "CsrfProtection");
      assert.equal(Api.CsrfProtection.requiredForClient, true);
    });

    Given(
      "a client build that supplies HttpApiMiddleware.layerClient\\(CsrfProtection, ...\\)",
      function* () {
        yield* put(tuple, "supplied");
      },
    );

    Given("a client build that omits the CsrfProtection client layer", function* () {
      yield* put(tuple, "omitted");
    });

    When("the client is composed", function* () {
      if ((yield* take(tuple)) !== "supplied") return;
      // A real client over a stub transport, with the CSRF client layer supplied: it is usable.
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
        ),
      );
      const status = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(CsrfGuardedApi, { baseUrl: "http://localhost" });
        yield* client.g.x();
        return "usable";
      }).pipe(Effect.provide(Layer.merge(AuthClient.CsrfClientLive, transport)));
      yield* put(strings, [status]);
    });

    Then(
      "the composition succeeds and produces a usable HttpApiClient \\/ AtomHttpApi.Service",
      function* () {
        assert.deepEqual(yield* take(strings), ["usable"]);
        assertTypeGate("csrf-client-layer-discharges", GATES, ["AuthClient.CsrfClientLive"]);
      },
    );

    Then("the rejection names {string} as still required", function* (marker: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(marker, "ForClient<CsrfProtection>");
      assertTypeGate("csrf-client-omitted-fails", GATES, ["ForClient<CsrfProtection>"]);
      assertTypeGate("csrf-client-required", GATES, ["CsrfMarker", "= true"]);
    });

    // ---- BEH-EA-031: the core session group ----

    Given("an HttpApi composed from core alone, with no plugin installed", function* () {
      // `Auth.make` needs at least one plugin; `PasswordFixture` contributes an unrelated group, so
      // everything under "session" is core's own.
      yield* put(tuple, "core-only");
    });

    When("the composed HttpApi is inspected", function* () {
      const built = Auth.make([PasswordFixture]);
      assert.ok(
        built.api.groups["session"] !== undefined,
        "core's session group is in the composed api",
      );
      yield* put(strings, [built.api.identifier]);
    });

    Then(
      "the {string} group is mounted at the root of {string}",
      function* (group: string, root: string) {
        yield* Effect.void; // an assertion-only step: nothing to await
        assert.equal(group, "session");
        const built = Auth.make([PasswordFixture]);
        assert.equal(`/${built.api.identifier}`, root);
        const paths = Object.values(built.api.groups["session"]?.endpoints ?? {}).map((endpoint) =>
          hasPath(endpoint) ? endpoint.path : "",
        );
        assert.ok(paths.length > 0);
        for (const path of paths) assert.match(path, /^\/session(\/|$)/, path);
      },
    );

    Then("it is not nested under any plugin's namespace prefix", function* () {
      yield* Effect.void; // an assertion-only step: nothing to await
      const built = Auth.make([PasswordFixture]);
      for (const endpoint of Object.values(built.api.groups["session"]?.endpoints ?? {})) {
        if (hasPath(endpoint)) assert.ok(!endpoint.path.startsWith("/password"), endpoint.path);
      }
    });

    Given("the composed HttpApi's {string} group", function* (group: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(group, "session");
    });

    When("the group's endpoints are inspected", function* () {
      const built = Auth.make([PasswordFixture]);
      const listed = Object.entries(built.api.groups["session"]?.endpoints ?? {}).map(
        ([name, endpoint]) =>
          hasRoute(endpoint)
            ? `${name}|${endpoint.method}|/${built.api.identifier}${endpoint.path}`
            : name,
      );
      yield* put(strings, listed);
    });

    Then("it exposes {string} at {string}", function* (endpoint: string, route: string) {
      const [method, path] = route.split(" ");
      assert.ok(
        (yield* take(strings)).includes(`${endpoint}|${method}|${path}`),
        `the session group exposes ${endpoint} at ${route}`,
      );
    });

    Given("an application composed from core alone, with no plugin installed", function* () {
      yield* put(tuple, "core-only");
    });

    Given("a signed-in user {string}", function* (name: string) {
      yield* signInCore(name);
    });

    When(
      "{string} calls the {string}, {string}, {string}, and {string} endpoints through the generated client",
      function* (name: string, ...endpoints: ReadonlyArray<string>) {
        assert.deepEqual(endpoints, ["list", "revoke", "revokeOthers", "signOut"]);
        const app = yield* coreOnlyApp;
        const alice = yield* actorNamed(name);
        // A second live session to revoke, so `revoke` has a real target that is not the caller's own.
        const other = yield* app.withServices(
          Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const issued = yield* sessions.issue({ userId: Users.UserId(alice.userId) });
            return issued.session.id;
          }),
        );
        const calls = [
          yield* send(app.handler, "GET", "/session/list", { cookie: alice.cookie }),
          yield* send(app.handler, "POST", "/session/revoke", {
            cookie: alice.cookie,
            body: { id: other },
          }),
          yield* send(app.handler, "POST", "/session/revoke-others", { cookie: alice.cookie }),
          yield* send(app.handler, "POST", "/session/sign-out", { cookie: alice.cookie }),
        ];
        yield* put(
          strings,
          calls.map((call) => String(call.status)),
        );
      },
    );

    Then("every call succeeds without any plugin being present", function* () {
      for (const status of yield* take(strings)) {
        assert.ok(Number(status) >= 200 && Number(status) < 300, `status ${status}`);
      }
    });

    // ---- BEH-EA-032: duplicate group ids ----

    const compose = (order: "forward" | "reverse") =>
      Effect.sync(() => {
        try {
          if (order === "forward") Auth.make([LoginHost, LegacyLogin]);
          else Auth.make([LegacyLogin, LoginHost]);
        } catch (error) {
          if (error instanceof Auth.GroupIdConflict) {
            return {
              tag: error._tag,
              groupId: error.groupId,
              first: error.firstPluginId,
              second: error.secondPluginId,
              message: error.message,
            };
          }
          throw error;
        }
        return { tag: "none", groupId: "", first: "", second: "", message: "" };
      });

    Given(
      "a plugin tuple containing {string} and a third-party {string}, both contributing an HttpApiGroup id {string}",
      function* (host: string, legacy: string, group: string) {
        assert.deepEqual([host, legacy, group], ["login", "login.legacy", "login.legacy"]);
        yield* put(tuple, "conflict");
      },
    );

    When("{string} composes the tuple", function* (make: string) {
      assert.equal(make, "Auth.make");
      const kind = yield* take(tuple);
      if (kind === "conflict") {
        yield* put(composeOutcome, [yield* compose("forward")]);
      } else {
        assert.equal(kind, "password");
      }
    });

    Then("composition is rejected", function* () {
      if ((yield* take(tuple)) === "omitted") {
        // INV-EA-011: a client left without the CSRF client layer does not compile.
        assertTypeGate("csrf-client-omitted-fails", GATES, [
          "@ts-expect-error",
          "Effect.Effect<unknown, unknown, never> = clientEffect",
        ]);
        return;
      }
      const [outcome] = yield* take(composeOutcome);
      assert.ok(outcome !== undefined);
      assert.equal(outcome.tag, "GroupIdConflict");
      assert.match(outcome.message, /E_GROUP_CONFLICT/);
    });

    Then(
      "the rejection names both {string} and {string} as the contributing plugins",
      function* (first: string, second: string) {
        const [outcome] = yield* take(composeOutcome);
        assert.ok(outcome !== undefined);
        assert.deepEqual([outcome.first, outcome.second], [first, second]);
        assert.equal(outcome.groupId, "login.legacy");
      },
    );

    Given(
      "a plugin tuple containing {string} and {string} that both contribute the group id {string}",
      function* (host: string, legacy: string, group: string) {
        assert.deepEqual([host, legacy, group], ["login", "login.legacy", "login.legacy"]);
        yield* put(tuple, "conflict");
      },
    );

    When(
      "{string} composes the tuple regardless of which plugin appears later in the array",
      function* (make: string) {
        assert.equal(make, "Auth.make");
        yield* put(composeOutcome, [yield* compose("forward"), yield* compose("reverse")]);
      },
    );

    Then("the outcome does not depend on which plugin was added to the array last", function* () {
      const [forward, reverse] = yield* take(composeOutcome);
      assert.ok(forward !== undefined && reverse !== undefined);
      assert.equal(forward.tag, "GroupIdConflict");
      assert.equal(reverse.tag, "GroupIdConflict");
      assert.equal(forward.groupId, reverse.groupId);
      // Both plugins are named either way; only which one is reported first follows the tuple.
      assert.deepEqual(
        [forward.first, forward.second].sort(),
        [reverse.first, reverse.second].sort(),
      );
    });

    Given("a plugin tuple containing {string}", function* (plugin: string) {
      assert.equal(plugin, "password");
      yield* put(tuple, "password");
    });

    Then(
      "the composed api's groups are {string}, {string} and {string}",
      function* (...groups: ReadonlyArray<string>) {
        yield* Effect.void; // an assertion-only step: nothing to await
        assert.deepEqual(groups, ["session", "account", "password"]);
        const built = Auth.make([PasswordFixture]);
        assert.deepEqual(Object.keys(built.api.groups).sort(), [...groups].sort());
      },
    );

    Then(
      "a plugin contributing a group id {string} is rejected as {string} naming {string}",
      function* (group: string, code: string, owner: string) {
        yield* Effect.void; // an assertion-only step: nothing to await
        assert.equal(group, "session");
        try {
          Auth.make([SessionImposter]);
        } catch (error) {
          assert.ok(error instanceof Auth.GroupIdConflict);
          assert.match(error.message, new RegExp(code));
          assert.equal(error.firstPluginId, owner);
          return;
        }
        throw new Error("a plugin contributing core's group id was accepted");
      },
    );
  },
);

/** An endpoint value that carries its route (`HttpApiGroup.Constraint` widens past it). */
const hasPath = (endpoint: object): endpoint is { readonly path: string } =>
  "path" in endpoint && typeof endpoint.path === "string";

const hasRoute = (
  endpoint: object,
): endpoint is { readonly method: string; readonly path: string } =>
  "method" in endpoint && typeof endpoint.method === "string" && hasPath(endpoint);
