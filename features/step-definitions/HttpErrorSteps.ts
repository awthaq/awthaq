// P20a/AH-003 tier 1: 11-http-error-mapping.feature — see `HttpErrorWorld.ts` for the compositions
// (every one built through `Auth.make` + `TestAuth.layer`).
import { Api } from "@awthaq/api";
import { Auth } from "@awthaq/core";
import { OAuth } from "@awthaq/oauth";
import { PasswordApi, Password } from "@awthaq/password";
import { TwoFactor } from "@awthaq/two-factor";
import { TestAuth } from "@awthaq/test";
import { defineSteps } from "@effect-cucumber/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as NetAddress from "effect/unstable/net/NetAddress";
import { CSRF_TEST_COOKIE_VALUE, withCsrfCookie } from "./CsrfTestSupport.ts";
import {
  DOCS_PATH,
  InvitePlugin,
  OPENAPI_PATH,
  Teapot,
  answerOf,
  apiKeyApp,
  builtInvite,
  builtPassword,
  builtPasswordInvite,
  builtPasswordWithApp,
  errorsApp,
  get,
  getOutcome,
  groupsOf,
  handlerOf,
  inviteApp,
  imperativeMe,
  passwordApp,
  passwordInviteApp,
  passwordRoutes,
  passwordWithAppApp,
  postJson,
  register,
  setOutcome,
  signUpVerified,
  usePasswordApp,
  useRuntimeApp,
  type Answer,
  type World,
} from "./HttpErrorWorld.ts";
import { routesNeedOnlyWhatAuthLayerProvides } from "./HttpErrorTypes.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";

const isAnswer = (value: unknown): value is Answer =>
  typeof value === "object" && value !== null && "status" in value && "body" in value;

/** `effect/httpapi/HttpApiGroup/<id>` — the key a group's service lives under, derived from the id alone (BEH-EA-082). */
const keyOf = (groupId: string) => `effect/httpapi/HttpApiGroup/${groupId}`;

const contractGroupIds = (api: { readonly groups: Readonly<Record<string, unknown>> }) =>
  Object.keys(api.groups);

/** The status the generated OpenAPI document declares for an error — read from its own `httpApiStatus` annotation. */
const declaredStatus = (error: ErrorClass) => {
  const probe = HttpApi.make("auth").add(
    HttpApiGroup.make("probe").add(HttpApiEndpoint.get("probe", "/probe", { error: [error] })),
  );
  const codes = Object.keys(OpenApi.fromApi(probe).paths["/probe"]?.get?.responses ?? {});
  // 204 is the empty success and 400 the payload-decoding failure every endpoint carries: what is
  // left is the error's own status.
  const [code] = codes.filter((candidate) => !["200", "204", "400"].includes(candidate));
  return Number(code);
};

const passwordPaths = (spec: ReturnType<typeof OpenApi.fromApi>) => Object.keys(spec.paths).sort();

const ErrorEndpoints: Readonly<Record<string, string>> = {
  Unauthenticated: "/errors/unauthenticated",
  InvalidCredentials: "/errors/invalid-credentials",
  CsrfRejected: "/errors/csrf-rejected",
  Teapot: "/errors/teapot",
  RateLimited: "/errors/rate-limited",
  StoreUnavailable: "/errors/store-unavailable",
};

type ErrorClass =
  | typeof Api.Unauthenticated
  | typeof Api.InvalidCredentials
  | typeof Api.CsrfRejected
  | typeof Api.StoreUnavailable
  | typeof Teapot;

const errorClass = (tag: string): ErrorClass => {
  switch (tag) {
    case "Unauthenticated":
      return Api.Unauthenticated;
    case "InvalidCredentials":
      return Api.InvalidCredentials;
    case "CsrfRejected":
      return Api.CsrfRejected;
    case "StoreUnavailable":
      return Api.StoreUnavailable;
    case "Teapot":
      return Teapot;
    default:
      throw new Error(`no error class for "${tag}"`);
  }
};

/** Every request path that carries the same answer whichever way the app is served (REQ-EA-234). */
const PROBES: ReadonlyArray<{
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly csrf: boolean;
  /** A `Cookie` header with no CSRF token: without any cookie a sign-in is exempt from the pair (BEH-EA-077). */
  readonly staleCookie?: boolean;
  readonly body?: unknown;
}> = [
  { name: "no session", method: "GET", path: "/session", csrf: false },
  { name: "unknown route", method: "GET", path: "/no-such-route", csrf: false },
  {
    name: "sign-in without a CSRF pair",
    method: "POST",
    path: "/password/sign-in",
    csrf: false,
    staleCookie: true,
    body: { email: "nobody@example.com", password: STRONG_PASSWORD },
  },
  {
    name: "sign-in, unknown email",
    method: "POST",
    path: "/password/sign-in",
    csrf: true,
    body: { email: "nobody@example.com", password: STRONG_PASSWORD },
  },
];

const requestFor = (baseUrl: string, probe: (typeof PROBES)[number]) =>
  new Request(`${baseUrl}${probe.path}`, {
    method: probe.method,
    headers: {
      ...(probe.body === undefined ? {} : { "content-type": "application/json" }),
      ...(probe.csrf ? { cookie: withCsrfCookie(), "x-csrf-token": CSRF_TEST_COOKIE_VALUE } : {}),
      ...(probe.staleCookie === true ? { cookie: "__Host-session=stale.secret" } : {}),
    },
    ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
  });

/**
 * Runs `use` against the password composition served by `HttpRouter.serve` on a real Node socket.
 * In a runtime of its own: the scenario's fiber carries the harness's `TestClock`, and a server
 * that thought it was 1970 would find every CSRF token issued in the future.
 */
const overNodeServer = <X>(use: (baseUrl: string) => Effect.Effect<X>) =>
  Effect.promise(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* HttpRouter.serve(passwordRoutes).pipe(Layer.build);
        const server = yield* HttpServer.HttpServer;
        if (!NetAddress.isInetAddress(server.address)) {
          return yield* Effect.die("the test server did not bind a TCP port");
        }
        return yield* use(`http://127.0.0.1:${server.address.port}`);
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
    ),
  );

/**
 * One request over a real TCP socket. `node:http` rather than `fetch`: fetch (undici) silently
 * drops a `cookie` request header, and the double-submit pair rides in one.
 */
const socketAnswer = (baseUrl: string, probe: (typeof PROBES)[number]) =>
  Effect.promise(
    () =>
      new Promise<Answer>((resolve, reject) => {
        const request = requestFor(baseUrl, probe);
        const outgoing = httpRequest(
          request.url,
          { method: request.method, headers: Object.fromEntries(request.headers) },
          (incoming) => {
            const chunks: Array<Buffer> = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8");
              const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(TagOnly))(body);
              resolve({
                status: incoming.statusCode ?? 0,
                body,
                tag: parsed._tag === "Some" ? parsed.value._tag : undefined,
              });
            });
          },
        );
        outgoing.on("error", reject);
        if (probe.body !== undefined) outgoing.write(JSON.stringify(probe.body));
        outgoing.end();
      }),
  );

const TagOnly = Schema.Struct({ _tag: Schema.optional(Schema.String) });

const answersOver = (baseUrl: string) =>
  Effect.forEach(PROBES, (probe) =>
    socketAnswer(baseUrl, probe).pipe(Effect.map((answer) => [probe.name, answer] as const)),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

/** REQ-EA-241: `.ts` files of the HTTP stratum that could hold a tag-to-status table. */
const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });

export const httpErrorSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-223/224: a plugin's handlers are built against its own contract ----

  Given(
    "a plugin {string} declaring its own contract {string} and group id {string}",
    (plugin: string, _contract: string, groupId: string) =>
      Effect.sync(() => {
        assert.equal(plugin, "Password");
        const declared = contractGroupIds(PasswordApi.PasswordApi);
        assert.ok(declared.includes(groupId), `Password declares: ${declared.join()}`);
        // Its groups all live under its own id (BEH-EA-004): the id or a dotted sub-id of it.
        assert.ok(declared.every((id) => id === groupId || id.startsWith(`${groupId}.`)));
      }),
  );

  When(
    "{string}'s handler Layer is built with {string}",
    function* (_plugin: string, _builder: string) {
      yield* register("password", passwordApp());
    },
  );

  Then(
    "the handler Layer satisfies exactly the group {string} that {string} itself declared",
    function* (groupId: string, _plugin: string) {
      const provided = yield* groupsOf("password");
      // Exactly the groups the plugin's own contract declares — `password` and its dotted
      // `password.account` sibling — and none of core's `session`/`account`.
      const expected = contractGroupIds(PasswordApi.PasswordApi).map(keyOf).sort();
      assert.ok(provided.has(keyOf(groupId)));
      assert.deepEqual([...provided.keys()].sort(), expected);
    },
  );

  Given(
    "a plugin {string} whose own namespace \\(per BEH-EA-004\\) entitles it only to group ids it declares itself",
    (plugin: string) =>
      Effect.sync(() => {
        assert.equal(plugin, "Invite");
        const declared = contractGroupIds(InvitePlugin.contract);
        assert.ok(declared.every((id) => id === "invite" || id.startsWith("invite.")));
      }),
  );

  When("{string}'s handler Layer is built", function* (_plugin: string) {
    yield* register("invite", inviteApp());
  });

  Then(
    "it is built only against a contract and group id {string} itself owns",
    function* (_plugin: string) {
      const provided = yield* groupsOf("invite");
      assert.deepEqual([...provided.keys()], [keyOf("invite")]);
    },
  );

  Then("never against {string}'s or core's contract or group id", function* (_plugin: string) {
    const provided = yield* groupsOf("invite");
    const foreign = [
      ...contractGroupIds(PasswordApi.PasswordApi),
      ...contractGroupIds(builtInvite.api).filter((id) => id === "session" || id === "account"),
    ];
    assert.ok(foreign.length >= 3, "the foreign set must include password's and core's groups");
    for (const id of foreign) assert.ok(!provided.has(keyOf(id)), `${id} must not be provided`);
  });

  // ---- REQ-EA-225/226: a group's service key derives from its id alone ----

  Given(
    "a plugin {string} whose handler Layer was built solely against its own contract",
    function* (_plugin: string) {
      yield* register("isolated", passwordApp());
    },
  );

  Given(
    "a plugin {string} whose handlers were authored before any other plugin was chosen",
    function* (_plugin: string) {
      yield* register("isolated", passwordApp());
    },
  );

  When(
    "{string}'s handler Layer is folded into the merged {string} produced by {string}",
    function* (_plugin: string, _api: string, _make: string) {
      yield* register("merged", passwordInviteApp());
    },
  );

  When(
    "{string} is composed alongside a newly-added plugin {string}",
    function* (_plugin: string, addition: string) {
      assert.equal(addition, "Invite");
      yield* register("merged", passwordInviteApp());
    },
  );

  // REQ-EA-226: the same claim for a composition with two other, newly-added plugins. Static: what
  // decides whether the handler Layer built before them still serves is the group's service key,
  // which derives from the group id alone (BEH-EA-082) and so cannot depend on who else is installed.
  When(
    "{string} is composed alongside newly-added plugins {string} and {string}",
    function* (_plugin: string, first: string, second: string) {
      assert.deepEqual([first, second], ["TwoFactor", "OAuth"]);
      const built = Auth.make([Password.Password, TwoFactor.TwoFactor, OAuth.OAuth]);
      const password = Object.values(built.api.groups).find(
        (group) => group.identifier === "password",
      );
      yield* setOutcome("mergedPasswordKey", password?.key);
      yield* setOutcome("mergedGroupIds", Object.keys(built.api.groups));
    },
  );

  Then(
    "the merged {string} still declares the {string} group under the service key {string}'s own handler Layer provides",
    function* (_api: string, groupId: string, _plugin: string) {
      const isolated = yield* groupsOf("isolated");
      assert.ok(isolated.has(keyOf(groupId)), "the isolated handler Layer provides the group");
      assert.equal(yield* getOutcome("mergedPasswordKey"), keyOf(groupId));
    },
  );

  Then("the newly-added plugins' groups sit beside it without displacing it", function* () {
    const ids = yield* getOutcome("mergedGroupIds");
    assert.ok(Array.isArray(ids));
    assert.ok(ids.includes("password"));
    assert.ok(
      ids.some((id) => String(id).startsWith("two")),
      String(ids),
    );
    assert.ok(
      ids.some((id) => String(id).startsWith("oauth")),
      String(ids),
    );
  });

  Then(
    "it already satisfies the service {string} requires for the {string} group",
    function* (_builder: string, groupId: string) {
      const isolated = yield* groupsOf("isolated");
      const merged = yield* groupsOf("merged");
      // The key `HttpApiBuilder.layer(auth.api)` looks up is the one the isolated layer provided.
      const declared = Object.values(builtPasswordInvite.api.groups).find(
        (group) => group.identifier === groupId,
      );
      assert.equal(declared?.key, keyOf(groupId));
      assert.ok(isolated.has(keyOf(groupId)) && merged.has(keyOf(groupId)));
      // ...and serving through the merged api reaches this plugin's handlers.
      const handler = yield* handlerOf("merged");
      const answer = yield* postJson(handler, "/password/sign-in", {
        email: "nobody@example.com",
        password: STRONG_PASSWORD,
      }).pipe(Effect.flatMap(answerOf));
      assert.equal(answer.status, 401);
      assert.equal(answer.tag, "InvalidCredentials");
    },
  );

  Then(
    "no additional adaptation of {string}'s handler Layer is needed",
    function* (_plugin: string) {
      const isolated = yield* groupsOf("isolated");
      const merged = yield* groupsOf("merged");
      // Same endpoints implemented, under the same keys, before and after composition: only the
      // host's own middleware/platform layers were supplied to get there.
      for (const id of contractGroupIds(PasswordApi.PasswordApi)) {
        assert.deepEqual(merged.get(keyOf(id)), isolated.get(keyOf(id)), id);
      }
    },
  );

  Then(
    "{string}'s handler Layer continues to satisfy its own group's requirement unchanged",
    function* (_plugin: string) {
      const isolated = yield* groupsOf("isolated");
      const merged = yield* groupsOf("merged");
      for (const id of contractGroupIds(PasswordApi.PasswordApi)) {
        assert.ok(merged.has(keyOf(id)));
        assert.deepEqual(merged.get(keyOf(id)), isolated.get(keyOf(id)), id);
      }
      assert.ok(merged.has(keyOf("invite")), "the new plugin's group is there too");
    },
  );

  // ---- REQ-EA-227..229: AuthHttp.routes ----

  Given("an {string} value produced by {string}", function* (value: string, make: string) {
    assert.equal(value, "auth.api");
    assert.equal(make, "Auth.make");
    const groups = contractGroupIds(builtPassword.api);
    assert.ok(groups.includes("password") && groups.includes("session"));
    yield* setOutcome("composition", "password");
  });

  When("{string} is called", function* (call: string) {
    assert.equal(call, "AuthHttp.routes(auth.api)");
    // The composition the Given chose, served through the very call under test.
    const composition = yield* getOutcome("composition");
    yield* register("routes", composition === "app" ? passwordWithAppApp() : passwordApp());
  });

  Then("the composed API's routes are registered with the router", function* () {
    const handler = yield* handlerOf("routes");
    // Core's group and the plugin's group are both there — a missing route would be a 404.
    const session = yield* get(handler, "/session").pipe(Effect.flatMap(answerOf));
    assert.equal(session.status, 401);
    assert.equal(session.tag, "Unauthenticated");
    const signIn = yield* postJson(handler, "/password/sign-in", {
      email: "nobody@example.com",
      password: STRONG_PASSWORD,
    }).pipe(Effect.flatMap(answerOf));
    assert.equal(signIn.tag, "InvalidCredentials");
    const missing = yield* get(handler, "/no-such-route").pipe(Effect.flatMap(answerOf));
    assert.equal(missing.status, 404);
  });

  Given(
    "an {string} value produced by {string} merging awthaq's plugin groups with an application's own groups",
    function* (value: string, make: string) {
      assert.equal(value, "auth.api");
      // `Auth.make(plugins, { extraGroups })`: the host's own groups ride in the same api.
      assert.equal(make, "Auth.api");
      const groups = contractGroupIds(builtPasswordWithApp.api);
      for (const id of ["session", "account", "password", "widgets"]) {
        assert.ok(groups.includes(id), `missing ${id}: ${groups.join()}`);
      }
      yield* setOutcome("composition", "app");
    },
  );

  Then(
    "both the awthaq groups and the application's own groups are registered with the router",
    function* () {
      const handler = yield* handlerOf("routes");
      const widgets = yield* get(handler, "/widgets").pipe(Effect.flatMap(answerOf));
      assert.equal(widgets.status, 200);
      const session = yield* get(handler, "/session").pipe(Effect.flatMap(answerOf));
      assert.equal(session.status, 401);
      const signIn = yield* postJson(handler, "/password/sign-in", {
        email: "nobody@example.com",
        password: STRONG_PASSWORD,
      }).pipe(Effect.flatMap(answerOf));
      assert.equal(signIn.tag, "InvalidCredentials");
    },
  );

  Given("the {string} Layer produced by {string}", function* (layer: string, call: string) {
    assert.equal(layer, "Routes");
    assert.equal(call, "AuthHttp.routes(auth.api)");
    yield* register("routes", passwordApp());
  });

  When(
    "the services the {string} Layer requires \\({string}\\) are inspected",
    function* (_layer: string, _rin: string) {
      // The inspection is a type (`HttpErrorTypes.ts`); its result is read by the Then.
      yield* setOutcome("inspected", true);
    },
  );

  Then(
    "they are exactly the services {string} provides, with no additional wiring step",
    function* (_authLayer: string) {
      assert.equal(yield* getOutcome("inspected"), true);
      // Group services from `auth.layer` and `AuthHttp.coreHandlers`, plus the host's platform
      // services — `Exclude`d down to nothing else, checked by `tsc`.
      assert.equal(routesNeedOnlyWhatAuthLayerProvides, true);
      // ...and the composition really builds and serves with nothing beyond the host's own layers.
      const handler = yield* handlerOf("routes");
      assert.equal((yield* get(handler, "/session")).status, 401);
    },
  );

  // ---- REQ-EA-230/231: AuthHttp.docs ----

  Given(
    "an {string} value provided to both {string} and {string}",
    function* (value: string, routes: string, docs: string) {
      assert.equal(value, "auth.api");
      assert.equal(routes, "AuthHttp.routes");
      assert.equal(docs, "AuthHttp.docs");
      yield* register("docs", passwordApp());
    },
  );

  When("a client requests {string} and {string}", function* (openapi: string, docs: string) {
    assert.equal(openapi, `GET ${OPENAPI_PATH}`);
    assert.equal(docs, `GET ${DOCS_PATH}`);
    const handler = yield* handlerOf("docs");
    const spec = yield* get(handler, OPENAPI_PATH);
    const page = yield* get(handler, DOCS_PATH);
    yield* setOutcome("specStatus", spec.status);
    yield* setOutcome("spec", yield* Effect.promise(() => spec.json()));
    yield* setOutcome("pageStatus", page.status);
    yield* setOutcome("page", yield* Effect.promise(() => page.text()));
  });

  Then("both are derived entirely from that same {string} value", function* (_value: string) {
    assert.equal(yield* getOutcome("specStatus"), 200);
    assert.equal(yield* getOutcome("pageStatus"), 200);
    const served = yield* getOutcome("spec");
    // The document the router serves is the projection of the very api both were given...
    assert.deepEqual(served, JSON.parse(JSON.stringify(OpenApi.fromApi(builtPassword.api))));
    // ...and the documentation page describes the same routes, not a separate description.
    const page = String(yield* getOutcome("page"));
    for (const path of ["/password/sign-in", "/session"]) assert.ok(page.includes(path), path);
  });

  Given("a plugin group is added to {string}", function* (_value: string) {
    yield* register("before", passwordApp());
    yield* register("after", passwordInviteApp());
  });

  When(
    "the router and the documentation are both regenerated from the updated {string}",
    function* (_value: string) {
      for (const name of ["before", "after"]) {
        const handler = yield* handlerOf(name);
        const route = yield* get(handler, "/invite/ping");
        const spec = yield* get(handler, OPENAPI_PATH);
        const page = yield* get(handler, DOCS_PATH);
        yield* setOutcome(`${name}Route`, route.status);
        yield* setOutcome(`${name}Spec`, yield* Effect.promise(() => spec.json()));
        yield* setOutcome(`${name}Page`, yield* Effect.promise(() => page.text()));
      }
    },
  );

  Then(
    "the newly added group appears identically in the registered routes and in the served documentation",
    function* () {
      // Added: served as a route, present in the OpenAPI document, present in the docs page.
      assert.equal(yield* getOutcome("afterRoute"), 200);
      assert.deepEqual(
        yield* getOutcome("afterSpec"),
        JSON.parse(JSON.stringify(OpenApi.fromApi(builtPasswordInvite.api))),
      );
      assert.ok(String(yield* getOutcome("afterPage")).includes("/invite/ping"));
      // Not added: none of the three knows the route.
      assert.equal(yield* getOutcome("beforeRoute"), 404);
      const before = yield* getOutcome("beforeSpec");
      assert.ok(typeof before === "object" && before !== null && "paths" in before);
      assert.ok(!Object.keys(Object(before.paths)).includes("/invite/ping"));
      assert.ok(!String(yield* getOutcome("beforePage")).includes("/invite/ping"));
      assert.notDeepEqual(
        passwordPaths(OpenApi.fromApi(builtPassword.api)),
        passwordPaths(OpenApi.fromApi(builtPasswordInvite.api)),
      );
    },
  );

  // ---- REQ-EA-232..234: the two serving paths ----

  Given("a composed {string} Layer", (layer: string) =>
    Effect.sync(() => assert.equal(layer, "Routes")),
  );

  Given("the same composed {string} Layer used with {string}", (layer: string, serve: string) =>
    Effect.sync(() => {
      assert.equal(layer, "Routes");
      assert.equal(serve, "HttpRouter.serve");
    }),
  );

  Given("one composed {string} Layer built from one plugin composition", (layer: string) =>
    Effect.sync(() => assert.equal(layer, "Routes")),
  );

  When("it is served with {string} provided {string}", function* (_serve: string, server: string) {
    assert.equal(server, "NodeHttpServer.layer");
    const answers = yield* overNodeServer(answersOver);
    yield* setOutcome("served", answers);
  });

  Then("the application is served as a standalone Node server", function* () {
    const answers = yield* getOutcome("served");
    assert.ok(typeof answers === "object" && answers !== null);
    // Real HTTP over a real socket: the typed error and its status arrive intact.
    const session = Reflect.get(answers, "no session");
    assert.ok(isAnswer(session));
    assert.equal(session.status, 401);
    assert.equal(session.tag, "Unauthenticated");
  });

  When("it is served with {string} for a Next.js or Hono host", function* (_serve: string) {
    // The very layer value `HttpRouter.serve` was given, unmodified.
    const { handler } = HttpRouter.toWebHandler(passwordRoutes);
    yield* setOutcome("webHandler", handler);
    const answers = Object.fromEntries(
      yield* Effect.forEach(PROBES, (probe) =>
        Effect.promise(() => handler(requestFor("http://localhost", probe))).pipe(
          Effect.flatMap(answerOf),
          Effect.map((answer) => [probe.name, answer] as const),
        ),
      ),
    );
    yield* setOutcome("webAnswers", answers);
  });

  Then(
    "the host receives a {string} to {string} handler with no modification to {string} itself",
    function* (_request: string, _response: string, _routes: string) {
      const handler = yield* getOutcome("webHandler");
      assert.equal(typeof handler, "function");
      const answers = yield* getOutcome("webAnswers");
      assert.ok(typeof answers === "object" && answers !== null);
      assert.equal(Reflect.get(answers, "no session")?.status, 401);
    },
  );

  When(
    "it is served once via {string} and once via {string}",
    function* (_serve: string, _web: string) {
      yield* setOutcome("nodeAnswers", yield* overNodeServer(answersOver));
      const web = passwordApp().handler;
      yield* setOutcome(
        "webAnswers",
        Object.fromEntries(
          yield* Effect.forEach(PROBES, (probe) =>
            Effect.promise(() => web(requestFor("http://localhost", probe))).pipe(
              Effect.flatMap(answerOf),
              Effect.map((answer) => [probe.name, answer] as const),
            ),
          ),
        ),
      );
    },
  );

  Then(
    "the plugin composition, the contract, and the handlers behave identically in both cases",
    function* () {
      const node = yield* getOutcome("nodeAnswers");
      const web = yield* getOutcome("webAnswers");
      assert.ok(
        typeof node === "object" && node !== null && typeof web === "object" && web !== null,
      );
      for (const probe of PROBES) {
        const viaNode: unknown = Reflect.get(node, probe.name);
        const viaWeb: unknown = Reflect.get(web, probe.name);
        assert.ok(isAnswer(viaNode) && isAnswer(viaWeb));
        assert.deepEqual(viaNode, viaWeb, probe.name);
      }
      // The comparison is not vacuous: the four probes reach four distinct behaviors.
      const outcomes = new Set(
        PROBES.map((probe) => {
          const answer: unknown = Reflect.get(web, probe.name);
          return isAnswer(answer) ? `${answer.status}:${answer.tag}` : "";
        }),
      );
      assert.equal(outcomes.size, 4);
    },
  );

  // ---- REQ-EA-235..237: enumeration-safe errors ----

  Given(
    "an unknown email address {string} and a known user {string} with a known-wrong password",
    function* (unknown: string, known: string) {
      const app = yield* usePasswordApp();
      yield* signUpVerified(app, `${known}@example.com`, STRONG_PASSWORD);
      yield* setOutcome("emails", { unknown, known: `${known}@example.com` });
    },
  );

  When("each submits a sign-in request", function* () {
    const app = yield* usePasswordApp();
    const emails = yield* getOutcome("emails");
    assert.ok(typeof emails === "object" && emails !== null);
    const unknown = String(Reflect.get(emails, "unknown"));
    const known = String(Reflect.get(emails, "known"));
    const wrong = "definitely not the password";
    yield* setOutcome(
      "unknownAnswer",
      yield* postJson(app.handler, "/password/sign-in", { email: unknown, password: wrong }).pipe(
        Effect.flatMap(answerOf),
      ),
    );
    yield* setOutcome(
      "wrongAnswer",
      yield* postJson(app.handler, "/password/sign-in", { email: known, password: wrong }).pipe(
        Effect.flatMap(answerOf),
      ),
    );
  });

  Then(
    "both responses have the identical status and body, disclosing neither which case occurred",
    function* () {
      const unknown = yield* getOutcome("unknownAnswer");
      const wrong = yield* getOutcome("wrongAnswer");
      assert.ok(isAnswer(unknown) && isAnswer(wrong));
      assert.equal(unknown.status, 401);
      assert.equal(unknown.tag, "InvalidCredentials");
      assert.deepEqual(unknown, wrong);
    },
  );

  Given(
    "an email {string} that has no account and an email {string} that does",
    function* (nobody: string, alice: string) {
      const app = yield* usePasswordApp();
      yield* signUpVerified(app, alice, STRONG_PASSWORD);
      yield* setOutcome("emails", { unknown: nobody, known: alice });
    },
  );

  When("each requests a password reset", function* () {
    const app = yield* usePasswordApp();
    const emails = yield* getOutcome("emails");
    assert.ok(typeof emails === "object" && emails !== null);
    for (const [key, email] of [
      ["unknownAnswer", String(Reflect.get(emails, "unknown"))],
      ["wrongAnswer", String(Reflect.get(emails, "known"))],
    ] as const) {
      yield* setOutcome(
        key,
        yield* postJson(app.handler, "/password/request-reset", { email }).pipe(
          Effect.flatMap(answerOf),
        ),
      );
    }
  });

  Then("both responses are {string} with identical bodies", function* (expected: string) {
    const unknown = yield* getOutcome("unknownAnswer");
    const known = yield* getOutcome("wrongAnswer");
    assert.ok(isAnswer(unknown) && isAnswer(known));
    assert.equal(`${unknown.status} ${unknown.status === 202 ? "Accepted" : "?"}`, expected);
    assert.deepEqual(unknown, known);
  });

  Given(
    "a third-party plugin exposing an endpoint sensitive to whether an account or token exists",
    function* () {
      // `@awthaq/api-key`, a plugin from its own package: `DELETE /api-key/:id` is answered
      // for keys that exist and keys that do not — exactly the probe an enumerator would use.
      const app = apiKeyApp();
      const owner = yield* app.withContext(TestAuth.signInAs({ email: "owner@example.com" }));
      const other = yield* app.withContext(TestAuth.signInAs({ email: "other@example.com" }));
      const foreignKey = yield* app.withContext(
        Effect.gen(function* () {
          const { ApiKey } = yield* Effect.promise(() => import("@awthaq/api-key"));
          const keys = yield* ApiKey.ApiKey;
          return yield* keys.create(other.userId, { name: "theirs", scopes: ["reports:read"] });
        }).pipe(Effect.orDie),
      );
      yield* register("apikey", app);
      yield* setOutcome("ownerCookie", owner.cookieHeader);
      yield* setOutcome("foreignKeyId", foreignKey.view.id);
    },
  );

  When(
    "the endpoint is requested once for a target that does not exist and once for a target that exists but is otherwise invalid",
    function* () {
      const handler = yield* handlerOf("apikey");
      const cookie = String(yield* getOutcome("ownerCookie"));
      const revoke = (id: string) =>
        Effect.promise(() =>
          handler(
            new Request(`http://localhost/api-key/${id}`, {
              method: "DELETE",
              headers: { cookie: withCsrfCookie(cookie), "x-csrf-token": CSRF_TEST_COOKIE_VALUE },
            }),
          ),
        ).pipe(Effect.flatMap(answerOf));
      yield* setOutcome("missing", yield* revoke("ak_does-not-exist"));
      yield* setOutcome("foreign", yield* revoke(String(yield* getOutcome("foreignKeyId"))));
    },
  );

  Then("both responses have the identical status and body", function* () {
    const missing = yield* getOutcome("missing");
    const foreign = yield* getOutcome("foreign");
    assert.ok(isAnswer(missing) && isAnswer(foreign));
    assert.equal(missing.status, 404);
    assert.deepEqual(missing, foreign);
  });

  // ---- REQ-EA-238/239: ManagedRuntime for imperative hosts ----

  Given("a {string} built with {string}", function* (runtime: string, make: string) {
    assert.equal(runtime, "ManagedRuntime");
    assert.equal(make, "ManagedRuntime.make(AuthLive)");
    yield* useRuntimeApp();
  });

  Given("a Hono route handler not built on {string}", (router: string) =>
    Effect.sync(() => assert.equal(router, "HttpRouter")),
  );

  When(
    "the handler calls {string} on a program built against {string}'s services",
    (call: string, _live: string) => Effect.sync(() => assert.equal(call, "runtime.runPromise")),
  );

  When("a valid session resolves a view", function* () {
    const { runtime, routed } = yield* useRuntimeApp();
    const signedIn = yield* Effect.promise(() =>
      runtime.runPromise(TestAuth.signInAs({ email: "imperative@example.com" })),
    );
    yield* setOutcome(
      "view",
      yield* Effect.promise(() => imperativeMe(runtime, signedIn.cookieHeader)),
    );
    yield* setOutcome(
      "routedView",
      yield* Effect.promise(() =>
        routed(
          new Request("http://localhost/session", { headers: { cookie: signedIn.cookieHeader } }),
        ),
      ),
    );
    yield* setOutcome("userId", signedIn.userId);
  });

  When("no valid session resolves a view", function* () {
    const { runtime, routed } = yield* useRuntimeApp();
    const forged = `${Api.SESSION_COOKIE_NAME}=not-a-real-session.token`;
    yield* setOutcome("view", yield* Effect.promise(() => imperativeMe(runtime, forged)));
    yield* setOutcome(
      "routedView",
      yield* Effect.promise(() =>
        routed(new Request("http://localhost/session", { headers: { cookie: forged } })),
      ),
    );
  });

  Then("the handler returns that view as JSON", function* () {
    const response = yield* getOutcome("view");
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = yield* Effect.promise(() => response.json());
    assert.deepEqual(body, { userId: yield* getOutcome("userId") });
  });

  Then("the handler returns its own {string} response", function* (status: string) {
    const response = yield* getOutcome("view");
    assert.ok(response instanceof Response);
    assert.equal(response.status, Number(status));
  });

  Then(
    "no domain logic is duplicated between this path and the HttpRouter-based serving paths",
    function* () {
      // Same store, same answer: the routed path rejects exactly what the imperative one did, and
      // the imperative program is `Authentication.resolvePrincipal` — the middleware's own function.
      const routed = yield* getOutcome("routedView");
      assert.ok(routed instanceof Response);
      assert.equal(routed.status, 401);
    },
  );

  // ---- REQ-EA-240/241: statuses come from the error's own annotation ----

  Given("a handler fails with the {string} tagged error", function* (tag: string) {
    const app = errorsApp();
    yield* register("errors", app);
    yield* setOutcome("errorTag", tag);
    assert.ok(tag in ErrorEndpoints);
  });

  When("the response is served", function* () {
    const handler = yield* handlerOf("errors");
    const tag = String(yield* getOutcome("errorTag"));
    const path = ErrorEndpoints[tag];
    assert.ok(path !== undefined);
    yield* setOutcome("served", yield* get(handler, path).pipe(Effect.flatMap(answerOf)));
  });

  Then("the client observes {string}", function* (expected: string) {
    const served = yield* getOutcome("served");
    assert.ok(isAnswer(served));
    const tag = String(yield* getOutcome("errorTag"));
    assert.equal(served.tag, tag);
    assert.equal(
      `${served.status} ${{ 401: "Unauthorized", 403: "Forbidden", 503: "Service Unavailable" }[served.status] ?? "?"}`,
      expected,
    );
    // The status is the one the error's own `httpApiStatus` annotation declares.
    assert.equal(served.status, declaredStatus(errorClass(tag)));
  });

  Given(
    "two different contract errors declared with two different httpApiStatus annotations",
    function* () {
      yield* register("errors", errorsApp());
    },
  );

  When("the HTTP stratum serves responses for both", function* () {
    const handler = yield* handlerOf("errors");
    yield* setOutcome(
      "unauthenticated",
      yield* get(handler, ErrorEndpoints["Unauthenticated"] ?? "").pipe(Effect.flatMap(answerOf)),
    );
    // A status only its own annotation knows about: no table anywhere could list 418.
    yield* setOutcome(
      "teapot",
      yield* get(handler, ErrorEndpoints["Teapot"] ?? "").pipe(Effect.flatMap(answerOf)),
    );
  });

  Then("each response's status is read solely from that error's own annotation", function* () {
    const unauthenticated = yield* getOutcome("unauthenticated");
    const teapot = yield* getOutcome("teapot");
    assert.ok(isAnswer(unauthenticated) && isAnswer(teapot));
    assert.equal(unauthenticated.status, declaredStatus(Api.Unauthenticated));
    assert.equal(teapot.status, 418);
    assert.equal(teapot.status, declaredStatus(Teapot));
  });

  Then(
    "no switch statement or lookup table mapping error tags to statuses exists anywhere in the HTTP-serving code",
    () =>
      Effect.sync(() => {
        // The HTTP-serving code is `packages/server/src`: scan it for a tag-to-status mapping.
        const root = fileURLToPath(new URL("../../packages/server/src", import.meta.url));
        const files = sourceFiles(root);
        const offenders = files.flatMap((file) =>
          readFileSync(file, "utf8")
            .split("\n")
            .flatMap((line, index) => {
              const code = line.replace(/\/\/.*$/, "");
              // `"SomeTag": 4xx`, `case "SomeTag": ... 4xx`, or assigning a literal error status.
              const tagToStatus =
                /["'][A-Z][A-Za-z]+["']\s*:\s*[45]\d\d\b/.test(code) ||
                /\bcase\s+["'][A-Z][A-Za-z]+["']\s*:.*[45]\d\d\b/.test(code) ||
                /\.status\s*=\s*[45]\d\d\b/.test(code);
              return tagToStatus ? [`${file}:${index + 1}: ${line.trim()}`] : [];
            }),
        );
        assert.deepEqual(offenders, []);
        // Sanity: the scan looked at real files.
        assert.ok(files.length >= 8);
      }),
  );
});
