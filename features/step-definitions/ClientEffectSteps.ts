// BEH-EA-169..176 (22-client-effect.feature). See ClientEffectWorld.ts / ClientEffectTypes.ts.
//
// Several steps below only surface a compile-time witness (ClientEffectTypes.ts) or assert a
// synchronous fact, so their generator bodies never yield.
/* oxlint-disable eslint/require-yield */
import { Api, SessionContract } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import { ReactClient } from "@awthaq/react";
import { defineSteps } from "@effect-cucumber/vitest";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import assert from "node:assert/strict";
import {
  BASE_URL,
  declaredEndpoints,
  exposedMethods,
  makeStubHttp,
  mergedApi,
  World,
} from "./ClientEffectWorld.ts";
import * as Witnesses from "./ClientEffectTypes.ts";
import { isBoolean, isNumber, isString, isStringArray } from "./shared/Outcomes.ts";

/** The reactive binding over the same merged contract (BEH-EA-169's `AtomHttpApi.Service` form). */
class ReactiveProbe extends ReactClient.makeReactClient<ReactiveProbe>()("features/ReactiveProbe", {
  api: mergedApi,
  baseUrl: BASE_URL,
}) {}

/** A thrown value kept as a typed failure, so a step can inspect what a synchronous builder threw. */
class Thrown extends Data.TaggedError("Thrown")<{ readonly error: unknown }> {}

const label = (entry: { readonly group: string; readonly endpoint: string }) =>
  `${entry.group}.${entry.endpoint}`;

/** Builds the plain, non-reactive client over `api` with a recording transport and the cookie-mode CSRF layer. */
const buildClient = (options?: Parameters<typeof AuthClient.make>[1]) => {
  const stub = makeStubHttp();
  return {
    stub,
    client: AuthClient.make(mergedApi, { baseUrl: BASE_URL, ...options }).pipe(
      Effect.provide(Layer.mergeAll(stub.layer, AuthClient.CsrfClientLive)),
    ),
  };
};

const session = (id: string) =>
  new SessionContract.SessionDto({
    id,
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    lastActiveAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    expiresAt: DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
    userAgent: null,
    current: true,
  });

const signInPayload = { email: "alice@example.com", password: Redacted.make("correct horse battery staple") };

/** A tiny contract whose endpoint set can grow — "a plugin adds a new endpoint" (REQ-EA-478). */
const widgetsBefore = HttpApi.make("auth").add(
  HttpApiGroup.make("widgets").add(HttpApiEndpoint.get("list", "/widgets", { success: Schema.Void })),
);
const widgetsAfter = HttpApi.make("auth").add(
  HttpApiGroup.make("widgets")
    .add(HttpApiEndpoint.get("list", "/widgets", { success: Schema.Void }))
    .add(HttpApiEndpoint.post("create", "/widgets", { success: Schema.Void })),
);

const buildWidgets = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
) => {
  const stub = makeStubHttp();
  return AuthClient.make(api, { baseUrl: BASE_URL }).pipe(Effect.provide(stub.layer));
};

export const clientEffectSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-169: the client derives from the merged contract -----------------------------

  Given(
    "a merged {string} contract containing groups from {string} and {string}",
    function* (_name: string, plugin: string, core: string) {
      const groups = Object.keys(mergedApi.groups);
      // `Sessions` is core's own reserved `session` group (MW-002), folded into every composition.
      assert.ok(groups.includes(plugin.toLowerCase()), `no "${plugin}" group in ${groups.join(",")}`);
      assert.ok(groups.includes(core.toLowerCase().replace(/s$/, "")), `no core session group`);
    },
  );

  When("{string} builds a client against {string}", function* (_make: string, _api: string) {
    const { outcomes } = yield* World;
    const { client } = buildClient();
    const exposed = exposedMethods(yield* client, declaredEndpoints(mergedApi)).map(label);
    yield* outcomes.set("plainMethods", exposed);
  });

  Then("the client exposes a method for every endpoint declared in {string}", function* (_api: string) {
    const { outcomes } = yield* World;
    const exposed = new Set(yield* outcomes.getAs("plainMethods", isStringArray));
    const missing = declaredEndpoints(mergedApi).map(label).filter((entry) => !exposed.has(entry));
    assert.deepEqual(missing, []);
  });

  Then("no method is defined outside what {string} declares", function* (_api: string) {
    const { outcomes } = yield* World;
    const declared = new Set(declaredEndpoints(mergedApi).map(label));
    const extra = (yield* outcomes.getAs("plainMethods", isStringArray)).filter((entry) => !declared.has(entry));
    assert.deepEqual(extra, []);
  });

  When("{string} builds the reactive client against {string}", function* (_make: string, _api: string) {
    const { outcomes } = yield* World;
    const registry = AtomRegistry.make();
    // The runtime's layer is the same `HttpApiClient.make(api)` the plain client uses, behind the atom runtime.
    const layer = registry.get(ReactiveProbe.runtime.layer);
    const reactive = yield* Effect.gen(function* () {
      return yield* ReactiveProbe;
    }).pipe(Effect.provide(layer));
    yield* outcomes.set(
      "reactiveMethods",
      exposedMethods(reactive, declaredEndpoints(mergedApi)).map(label),
    );
    const { client } = buildClient();
    yield* outcomes.set(
      "plainMethods",
      exposedMethods(yield* client, declaredEndpoints(mergedApi)).map(label),
    );
  });

  Then(
    "the reactive client exposes the same set of endpoint methods that {string} produces for {string}",
    function* (_make: string, _api: string) {
      const { outcomes } = yield* World;
      const reactive = [...(yield* outcomes.getAs("reactiveMethods", isStringArray))].sort();
      const plain = [...(yield* outcomes.getAs("plainMethods", isStringArray))].sort();
      assert.ok(plain.length > 0);
      assert.deepEqual(reactive, plain);
    },
  );

  Given("a plugin adds a new endpoint to its {string} in {string}", function* (_group: string, _api: string) {
    const { outcomes } = yield* World;
    const before = declaredEndpoints(widgetsBefore).map(label);
    const after = declaredEndpoints(widgetsAfter).map(label);
    assert.deepEqual(after.filter((entry) => !before.includes(entry)), ["widgets.create"]);
    yield* outcomes.set("declaredNew", "widgets.create");
  });

  When("{string} rebuilds the client against the updated {string}", function* (_make: string, _api: string) {
    const { outcomes } = yield* World;
    const beforeClient = yield* buildWidgets(widgetsBefore);
    const afterClient = yield* buildWidgets(widgetsAfter);
    const beforeMethods = exposedMethods(beforeClient, declaredEndpoints(widgetsBefore)).map(label);
    const afterMethods = exposedMethods(afterClient, declaredEndpoints(widgetsAfter)).map(label);
    yield* outcomes.set(
      "newMethods",
      afterMethods.filter((entry) => !beforeMethods.includes(entry)),
    );
  });

  Then("the client exposes a method for the new endpoint", function* () {
    const { outcomes } = yield* World;
    assert.deepEqual(yield* outcomes.getAs("newMethods", isStringArray), [
      yield* outcomes.getAs("declaredNew", isString),
    ]);
  });

  Then(
    "no hand-written method was added to produce it, so the contract and the client cannot drift apart",
    function* () {
      // `make` *is* HttpApiClient.make (not a wrapper re-declaring it), and the hand-written module
      // knows nothing named after the new endpoint.
      assert.equal(AuthClient.make, HttpApiClient.make);
      assert.ok(!Object.keys(AuthClient).includes("create"));
    },
  );

  // ---- BEH-EA-170: CsrfProtection is required by the client type (compile-time) -------------

  Given(
    "a cookie-mode client program that provides {string} as its {string} client middleware Layer",
    function* (_layer: string, _middleware: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("program", "with-csrf");
    },
  );

  Given(
    "a cookie-mode client program with the {string} layer removed from its provided Layers",
    function* (_layer: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("program", "without-csrf");
    },
  );

  When("the program is type-checked", function* () {
    // The type-check is `tsc` compiling ClientEffectTypes.ts (part of `pnpm run typecheck`): each
    // witness is only inhabited while its property holds. The runtime half proves the composed
    // program really builds — and that discovering the gap needed no request at all.
    const { outcomes, stub } = yield* World;
    const built = yield* Effect.exit(
      AuthClient.make(mergedApi, { baseUrl: BASE_URL }).pipe(
        Effect.provide(Layer.mergeAll(stub.layer, AuthClient.CsrfClientLive)),
      ),
    );
    yield* outcomes.set("composed", built._tag === "Success");
    yield* outcomes.set("requestsIssued", (yield* stub.requests).length);
  });

  Then("composition succeeds", function* () {
    const { outcomes } = yield* World;
    assert.equal(Witnesses.csrfIsRequired, true);
    assert.equal(Witnesses.csrfIsDischarged, true);
    assert.equal(yield* outcomes.getAs("composed", isBoolean), true);
  });

  // Shared by REQ-EA-480 (a missing CsrfClient layer) and REQ-EA-487 (an untranslated error tag):
  // both are compile-time witnesses, so `tsc` is what fails if either ever compiles.
  Then("it fails to type-check", function* () {
    const { outcomes } = yield* World;
    const program = yield* outcomes.getAs("program", isString);
    if (program === "without-csrf") {
      assert.equal(Witnesses.omissionLeavesARequirement, true);
      assert.equal(Witnesses.onlyCsrfIsMissing, true);
    } else {
      assert.equal(typeof Witnesses.catalogAfterMissingATag, "function");
      assert.equal(Witnesses.catalogAfter.Forbidden, "Forbidden");
    }
  });

  Then(
    "the diagnostic names {string} as the unsatisfied requirement",
    function* (requirement: string) {
      assert.equal(requirement, "ForClient<CsrfProtection>");
      // With everything else provided, the requirement left over is exactly `ForClient<CsrfProtection>`.
      assert.equal(Witnesses.onlyCsrfIsMissing, true);
    },
  );

  Then("the gap is reported as a compile-time failure", function* () {
    assert.equal(Witnesses.omissionLeavesARequirement, true);
    assert.equal(Witnesses.csrfIsRequired, true);
  });

  Then(
    "no runtime request against a live server is needed to discover it as a 403 in production",
    function* () {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("requestsIssued", isNumber), 0);
    },
  );

  // ---- BEH-EA-172: error codes are derived from the contract (compile-time) ----------------

  Given(
    "a compiled {string} whose plugins declare typed errors {string} and {string}",
    function* (_api: string, first: string, second: string) {
      assert.equal(new Api.InvalidCredentials()._tag, first);
      assert.equal(new Api.RateLimited({ retryAfterMillis: 1 })._tag, second);
    },
  );

  When("the type {string} is computed", function* (_type: string) {
    assert.equal(Witnesses.twoErrorCodesAreExact, true);
  });

  Then("it is the union {string} | {string}", function* (_first: string, _second: string) {
    assert.equal(Witnesses.twoErrorCodesAreExact, true);
    assert.equal(Witnesses.mergedHasInvalidCredentials, true);
  });

  Given("a plugin adds a new {string} to its contract", function* (_class: string) {
    assert.equal(Witnesses.beforeIsExact, true);
  });

  When("{string} is recomputed", function* (_type: string) {
    assert.equal(Witnesses.afterIsExtended, true);
  });

  Then("the new error tag is included in the type automatically", function* () {
    assert.equal(Witnesses.afterIsExtended, true);
    assert.equal(Witnesses.afterAgainIsExtended, true);
  });

  Then(
    "no separate hand-maintained list of error codes was updated to include it",
    function* () {
      // No runtime list of codes exists in the client module to update: every export is a function,
      // a class, a layer or a service — never an array of tags.
      const lists = Object.entries(AuthClient).filter(([, value]) => Array.isArray(value));
      assert.deepEqual(lists, []);
    },
  );

  Given(
    "an i18n {string} catalog declared as {string}",
    function* (_catalog: string, _satisfies: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("program", "catalog");
      assert.equal(Witnesses.catalogBefore.NotFound, "Not found");
    },
  );

  Given("a contract change adds a new error tag the catalog has not yet translated", function* () {
    assert.equal(Witnesses.afterIsExtended, true);
  });

  When("the catalog is type-checked against the updated {string}", function* (_type: string) {
    // `catalogAfterMissingATag` carries a `@ts-expect-error` for the missing "Forbidden" key.
    assert.equal(typeof Witnesses.catalogAfterMissingATag, "function");
  });

  // ---- BEH-EA-173: urlBuilder --------------------------------------------------------------

  Given("the merged {string} contract declares an {string} endpoint", function* (_api: string, endpoint: string) {
    const declared = declaredEndpoints(mergedApi).map(label);
    assert.ok(declared.includes(endpoint), `${endpoint} is not declared: ${declared.join(",")}`);
  });

  When(
    "{string} is called with params {string} and query {string}",
    function* (_call: string, params: string, query: string) {
      const { outcomes } = yield* World;
      assert.match(params, /google/);
      assert.match(query, /\/dashboard/);
      const build = HttpApiClient.urlBuilder(mergedApi, { baseUrl: BASE_URL });
      yield* outcomes.set(
        "url",
        build.oauth.authorize({ params: { provider: "google" }, query: { callbackURL: "/dashboard" } }),
      );
    },
  );

  Then(
    "the returned URL correctly encodes the {string} path parameter and the {string} query parameter",
    function* (_param: string, _query: string) {
      const { outcomes } = yield* World;
      const url = new URL(yield* outcomes.getAs("url", isString));
      assert.equal(url.origin, BASE_URL);
      assert.equal(url.pathname, "/oauth/google/authorize");
      assert.equal(url.searchParams.get("callbackURL"), "/dashboard");
    },
  );

  Given(
    "a parameter value that does not satisfy the {string} endpoint's declared {string}",
    function* (_endpoint: string, _schema: string) {
      const { outcomes } = yield* World;
      // `provider` is declared `Schema.String`; a number cannot encode.
      yield* outcomes.set("badProvider", 42);
    },
  );

  When(
    "the same value is passed to a real request call and separately to {string} for {string}",
    function* (_builder: string, _endpoint: string) {
      const { outcomes } = yield* World;
      const bad = { params: { provider: 42 }, query: {} };
      const builder = HttpApiClient.urlBuilder(mergedApi, { baseUrl: BASE_URL });
      const viaBuilder = yield* Effect.try({
        try: () => Reflect.apply(builder.oauth.authorize, undefined, [bad]),
        catch: (error) => new Thrown({ error }),
      }).pipe(Effect.flip);
      const { client } = buildClient();
      const built = yield* client;
      const viaRequest = yield* Effect.suspend(
        (): Effect.Effect<unknown, unknown> => Reflect.apply(built.oauth.authorize, undefined, [bad]),
      ).pipe(Effect.sandbox, Effect.flip);
      yield* outcomes.set("builderSchemaError", Schema.isSchemaError(viaBuilder.error));
      yield* outcomes.set("requestSchemaError", String(viaRequest).includes("SchemaError"));
    },
  );

  Then("both fail encoding in the same way", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("builderSchemaError", isBoolean), true);
    assert.equal(yield* outcomes.getAs("requestSchemaError", isBoolean), true);
  });

  Given(
    "a {string} query value containing characters that would corrupt a hand-concatenated URL, such as {string} and {string}",
    function* (_param: string, first: string, second: string) {
      const { outcomes } = yield* World;
      const value = `/dashboard?tab=1${first}mode=2`;
      assert.ok(value.includes(first) && value.includes(second));
      yield* outcomes.set("redirect", value);
    },
  );

  When("the {string} link is built with {string} against the contract", function* (_link: string, _builder: string) {
    const { outcomes } = yield* World;
    const redirect = yield* outcomes.getAs("redirect", isString);
    const build = HttpApiClient.urlBuilder(mergedApi, { baseUrl: BASE_URL });
    yield* outcomes.set(
      "url",
      build.oauth.authorize({ params: { provider: "google" }, query: { callbackURL: redirect } }),
    );
  });

  Then("the returned URL correctly percent-encodes those characters", function* () {
    const { outcomes } = yield* World;
    const url = yield* outcomes.getAs("url", isString);
    const redirect = yield* outcomes.getAs("redirect", isString);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("callbackURL"), redirect);
    assert.equal([...parsed.searchParams.keys()].length, 1);
    assert.match(url, /%26/);
    assert.match(url, /%3F/);
  });

  Then(
    "the link is not assembled by string-concatenating a path and query parameters by hand",
    function* () {
      const { outcomes } = yield* World;
      const url = yield* outcomes.getAs("url", isString);
      const redirect = yield* outcomes.getAs("redirect", isString);
      const byHand = `${BASE_URL}/oauth/google/authorize?callbackURL=${redirect}`;
      // What hand concatenation produces would smuggle a second query parameter in.
      assert.notEqual(url, byHand);
      assert.equal(new URL(byHand).searchParams.get("mode"), "2");
      assert.equal(new URL(url).searchParams.get("mode"), null);
    },
  );

  // ---- BEH-EA-174: session helpers ---------------------------------------------------------

  Given("a client session store holding {string}", function* (_shape: string) {
    const { sessionStore } = yield* World;
    yield* sessionStore.set(session("s-current"));
  });

  When("application code calls {string}", function* (_call: string) {
    const { outcomes, sessionStore } = yield* World;
    const current = yield* sessionStore.get;
    yield* outcomes.set("readId", Option.isSome(current) ? current.value.id : "none");
  });

  Then(
    "it returns the store's current value without issuing an additional network request",
    function* () {
      const { outcomes, stub } = yield* World;
      assert.equal(yield* outcomes.getAs("readId", isString), "s-current");
      assert.equal((yield* stub.requests).length, 0);
    },
  );

  Given("a client session store with no value yet set", function* () {
    const { sessionStore } = yield* World;
    assert.ok(Option.isNone(yield* sessionStore.get));
  });

  When(
    "{string} is called with a non-null {string}",
    function* (_call: string, _arg: string) {
      const { sessionStore } = yield* World;
      yield* sessionStore.hydrate(session("ssr-seeded"));
    },
  );

  Then("the store's current value becomes {string}", function* (_arg: string) {
    const { sessionStore } = yield* World;
    const current = yield* sessionStore.get;
    assert.ok(Option.isSome(current));
    assert.equal(current.value.id, "ssr-seeded");
  });

  Given(
    "a client session store already seeded with a non-null session via {string}",
    function* (_call: string) {
      const { sessionStore } = yield* World;
      yield* sessionStore.hydrate(session("first-non-null"));
    },
  );

  When("{string} is called afterward", function* (_call: string) {
    const { sessionStore } = yield* World;
    // `hydrate(null)` at the type level is `set(null)`-shaped for a store, but hydrate only seeds:
    // the later, different value is what must not win.
    yield* sessionStore.hydrate(session("later-value"));
  });

  Then(
    "the store's current value remains the original non-null session, because the first non-null value wins",
    function* () {
      const { sessionStore } = yield* World;
      const current = yield* sessionStore.get;
      assert.ok(Option.isSome(current));
      assert.equal(current.value.id, "first-non-null");
    },
  );

  Given(
    "the hand-written portion of {string} — the session store, CSRF header injection, and the credentials\\/bearer policy",
    function* (_pkg: string) {
      const handWritten = ["SessionStore", "SessionStoreLive", "csrfClientLayer", "CsrfClientLive", "BearerTokenStore"];
      for (const name of handWritten) assert.ok(name in AuthClient, `${name} is not exported`);
    },
  );

  When(
    "that hand-written surface is compared against the endpoints {string} derives from {string}",
    function* (_client: string, _api: string) {
      const { outcomes } = yield* World;
      const endpointIds = new Set(declaredEndpoints(mergedApi).map((entry) => entry.endpoint));
      yield* outcomes.set(
        "duplicates",
        Object.keys(AuthClient).filter((name) => endpointIds.has(name)),
      );
    },
  );

  Then(
    "no hand-written method duplicates an endpoint method the generated client already provides",
    function* () {
      const { outcomes } = yield* World;
      assert.deepEqual(yield* outcomes.getAs("duplicates", isStringArray), []);
      // and the generated entry points are the real ones, not re-declared wrappers
      assert.equal(AuthClient.urlBuilder, HttpApiClient.urlBuilder);
      assert.equal(AuthClient.group, HttpApiClient.group);
    },
  );

  // ---- BEH-EA-175: transformClient is the one seam ----------------------------------------

  Given("a native client configured with {string}", function* (config: string) {
    const { outcomes } = yield* World;
    assert.match(config, /bearerToken/);
    yield* outcomes.set("token", "keychain-token-1");
  });

  When("any generated endpoint method issues a request", function* () {
    const { outcomes } = yield* World;
    const token = yield* outcomes.getAs("token", isString);
    const { client, stub } = buildClient({
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    });
    const built = yield* client;
    yield* built.session.current().pipe(Effect.ignore);
    yield* built.password.signIn({ payload: signInPayload }).pipe(Effect.ignore);
    yield* outcomes.set(
      "authorization",
      (yield* stub.requests).map((request) => request.headers["authorization"] ?? ""),
    );
  });

  Then("the request carries the bearer token attached by {string}", function* (_seam: string) {
    const { outcomes } = yield* World;
    const seen = yield* outcomes.getAs("authorization", isStringArray);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen, ["Bearer keychain-token-1", "Bearer keychain-token-1"]);
  });

  Given(
    "a cookie-mode client providing both {string} and an application-supplied {string}",
    function* (_csrf: string, _transform: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("csrfToken", "csrf-token-abc");
    },
  );

  When("a request is issued", function* () {
    const { outcomes } = yield* World;
    const stub = makeStubHttp();
    const token = yield* outcomes.getAs("csrfToken", isString);
    const built = yield* AuthClient.make(mergedApi, {
      baseUrl: BASE_URL,
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("x-app-policy", "on")),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          stub.layer,
          AuthClient.csrfClientLayer({ readCookie: () => token, bootstrapRetry: false }),
        ),
      ),
    );
    yield* built.password.signIn({ payload: signInPayload }).pipe(Effect.ignore);
    const [request] = yield* stub.requests;
    yield* outcomes.set("csrfHeader", request?.headers[Api.CSRF_HEADER_NAME] ?? "");
    yield* outcomes.set("policyHeader", request?.headers["x-app-policy"] ?? "");
  });

  Then(
    "the request carries both the CSRF header from {string} and the modification from the application's {string}",
    function* (_csrf: string, _transform: string) {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("csrfHeader", isString), "csrf-token-abc");
      assert.equal(yield* outcomes.getAs("policyHeader", isString), "on");
    },
  );

  Given("an application needs to attach a tenant header to every outgoing request", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("tenant", "acme");
  });

  When("that policy is implemented", function* () {
    const { outcomes } = yield* World;
    const tenant = yield* outcomes.getAs("tenant", isString);
    const { client, stub } = buildClient({
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("x-tenant", tenant)),
    });
    const built = yield* client;
    yield* built.session.current().pipe(Effect.ignore);
    yield* built.session.signOut().pipe(Effect.ignore);
    yield* outcomes.set(
      "tenantHeaders",
      (yield* stub.requests).map((request) => request.headers["x-tenant"] ?? ""),
    );
    yield* outcomes.set(
      "clientMethods",
      exposedMethods(built, declaredEndpoints(mergedApi)).map(label),
    );
  });

  Then("it is expressed through {string}\\/{string}", function* (_transformClient: string, _transformResponse: string) {
    const { outcomes } = yield* World;
    assert.deepEqual(yield* outcomes.getAs("tenantHeaders", isStringArray), ["acme", "acme"]);
  });

  Then(
    "no generated per-endpoint method is wrapped, shadowed, or re-exported to implement it",
    function* () {
      const { outcomes } = yield* World;
      const declared = declaredEndpoints(mergedApi).map(label).sort();
      // The client still exposes exactly the contract's methods: none added, none replaced.
      assert.deepEqual([...(yield* outcomes.getAs("clientMethods", isStringArray))].sort(), declared);
      assert.ok(!Object.keys(AuthClient).some((name) => /tenant/i.test(name)));
    },
  );

  // ---- BEH-EA-176: a Promise facade is opt-in, never a second client ------------------------

  Given(
    "a Promise-returning wrapper {string} built for non-Effect callers",
    function* (wrapper: string) {
      assert.match(wrapper, /toPromiseFacade/);
    },
  );

  When("{string} is called through the wrapper", function* (call: string) {
    const { outcomes } = yield* World;
    assert.match(call, /signOut/);
    const stub = makeStubHttp();
    const built = yield* AuthClient.make(mergedApi, { baseUrl: BASE_URL }).pipe(
      Effect.provide(Layer.mergeAll(stub.layer, AuthClient.CsrfClientLive)),
    );
    yield* Effect.promise(() => AuthClient.toPromiseFacade(built).session.signOut());
    const requests = yield* stub.requests;
    yield* outcomes.set(
      "facadeRequests",
      requests.map((request) => `${request.method} ${request.url}`),
    );
  });

  Then(
    "the call is dispatched through the same underlying client and the same generated method the Effect-native client uses",
    function* () {
      const { outcomes } = yield* World;
      // One request, from the generated `session.signOut` — the facade has no transport of its own.
      assert.deepEqual(yield* outcomes.getAs("facadeRequests", isStringArray), [
        `POST ${BASE_URL}/session/sign-out`,
      ]);
    },
  );

  Given(
    "the same operation evaluated once via the Effect-native client and once via the Promise facade",
    function* () {
      const { outcomes } = yield* World;
      yield* outcomes.set("operation", "session.current");
    },
  );

  When("both calls complete", function* () {
    const { outcomes } = yield* World;
    const unauthenticated = () =>
      new Response(JSON.stringify({ _tag: "Unauthenticated" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const stub = makeStubHttp(unauthenticated);
    const built = yield* AuthClient.make(mergedApi, { baseUrl: BASE_URL }).pipe(
      Effect.provide(Layer.mergeAll(stub.layer, AuthClient.CsrfClientLive)),
    );
    const viaEffect = yield* built.session.current().pipe(Effect.flip);
    const viaPromise = yield* Effect.tryPromise({
      try: () => AuthClient.toPromiseFacade(built).session.current(),
      catch: (error) => new Thrown({ error }),
    }).pipe(Effect.flip);
    yield* outcomes.set("effectTag", Reflect.get(viaEffect, "_tag"));
    yield* outcomes.set("promiseTag", Reflect.get(Object(viaPromise.error), "_tag"));
  });

  Then("both report the same decision, because neither is a separately implemented evaluation path", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("effectTag", isString), "Unauthenticated");
    assert.equal(yield* outcomes.getAs("promiseTag", isString), "Unauthenticated");
  });

  Given("the Promise facade offered for non-Effect code", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("facade", "toPromiseFacade");
  });

  When("its implementation is inspected", function* () {
    const { outcomes } = yield* World;
    // A fake client of plain Effects and no transport anywhere: whatever the facade does, it can
    // only do by calling the method it was given.
    const calls: Array<string> = [];
    const fake = {
      widgets: {
        list: (input: string) => Effect.sync(() => (calls.push(input), `listed:${input}`)),
      },
    };
    const result = yield* Effect.promise(() => AuthClient.toPromiseFacade(fake).widgets.list("x"));
    yield* outcomes.set("shimResult", result);
    yield* outcomes.set("shimCalls", calls);
  });

  Then("it is a thin {string} shim over the one generated client", function* (_runPromise: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("shimResult", isString), "listed:x");
  });

  Then("it defines no independent request construction or decision logic", function* () {
    const { outcomes } = yield* World;
    // Exactly one call, with exactly the caller's argument, and no HttpClient anywhere in reach.
    assert.deepEqual(yield* outcomes.getAs("shimCalls", isStringArray), ["x"]);
  });
});
