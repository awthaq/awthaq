// P20a/AH-003 tier 1: 10-csrf.feature over the real `CsrfProtectionLive` — see `CsrfWorld.ts`.
//
// A note on isolation for REQ-EA-204..209: `CsrfProtection` runs three checks that compose (the
// site check, the Origin fallback, the double-submit pair). A scenario about one of them starts
// from a request that would pass the others — a real `__Host-csrf` cookie issued by the server
// and echoed in `x-csrf-token` — so a rejection can only be that check's doing, and a pass shows
// it did not reject.
import { Api } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  ALLOWED_ORIGIN,
  AppApi,
  BillingApi,
  arrange,
  appHandle,
  buildApp,
  getApp,
  getOutcome,
  issueCookie,
  lastObservation,
  pendingRequest,
  send,
  sendTo,
  setApp,
  setOutcome,
  type Observation,
  type World,
} from "./CsrfWorld.ts";
import { csrfIsDischarged, onlyCsrfIsMissing } from "./CsrfClientTypes.ts";

const EVIL_ORIGIN = "https://evil.example.net";

/** `"Sec-Fetch-Site: same-origin"` → `["sec-fetch-site", "same-origin"]`. */
const parseHeader = (text: string): readonly [string, string] => {
  const at = text.indexOf(": ");
  if (at < 0) throw new Error(`not a "Name: value" header: ${text}`);
  return [text.slice(0, at).toLowerCase(), text.slice(at + 2)];
};

const cookieHeaderFor = (token: string) => `${Api.CSRF_COOKIE_NAME}=${token}`;

/** The pair a browser client would send once the server has issued its cookie. */
const validPair = Effect.gen(function* () {
  const token = yield* issueCookie();
  yield* arrange({ header: ["cookie", cookieHeaderFor(token)] });
  yield* arrange({ header: [Api.CSRF_HEADER_NAME, token] });
  yield* setOutcome("cookieToken", token);
  return token;
});

const middlewareKeys = (group: {
  readonly endpoints: Readonly<
    Record<string, { readonly middlewares: ReadonlySet<{ readonly key: string }> }>
  >;
}) =>
  Object.values(group.endpoints).flatMap((endpoint) =>
    [...endpoint.middlewares].map((middleware) => middleware.key),
  );

const isObservation = (value: unknown): value is Observation =>
  typeof value === "object" && value !== null && "originChecks" in value && "hits" in value;

const isRejected = (observed: Observation) =>
  observed.status === 403 && observed.tag === "CsrfRejected" && observed.hits === 0;

export const csrfSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-204..206: Sec-Fetch-Site is the primary signal ----

  Given("an unsafe {string} request carrying {string}", function* (method: string, header: string) {
    yield* arrange({ method });
    yield* validPair;
    yield* arrange({ header: parseHeader(header) });
  });

  When("{string} evaluates the request", function* (middleware: string) {
    assert.equal(middleware, "CsrfProtection");
    yield* send(yield* pendingRequest());
  });

  Then("the request passes the {string} check", function* (check: string) {
    const observed = yield* lastObservation();
    assert.equal(observed.status, 200, `the ${check} check must not reject: ${observed.body}`);
    assert.equal(observed.hits, 1, "the endpoint's handler must have run");
  });

  Then("the request is rejected", function* () {
    const observed = yield* lastObservation();
    assert.ok(
      isRejected(observed),
      `expected a CsrfRejected 403, got ${observed.status} ${observed.body}`,
    );
    const request = yield* pendingRequest();
    // When the request had no site signal to decide on, the rejection is the Origin comparison's:
    // it must actually have looked at the header.
    if (
      request.headers["sec-fetch-site"] === undefined &&
      request.headers["origin"] !== undefined
    ) {
      assert.deepEqual(observed.originChecks, [request.headers["origin"]]);
    }
  });

  Then("the rejection is decided before any other CSRF check runs", function* () {
    // The request was otherwise fully valid: a real cookie/header pair was on it. Only the site
    // signal can have rejected it, and the Origin allow-list was never consulted.
    const observed = yield* lastObservation();
    assert.ok(isRejected(observed));
    assert.deepEqual(observed.originChecks, []);
  });

  Then(
    "neither the {string} comparison nor the double-submit cookie check is evaluated",
    function* (_origin: string) {
      // Observable form: the Origin allow-list is never consulted, and a valid double-submit pair
      // did not rescue the request — the site signal alone decided it.
      const observed = yield* lastObservation();
      const request = yield* pendingRequest();
      assert.equal(request.headers[Api.CSRF_HEADER_NAME], request.headers["cookie"]?.split("=")[1]);
      assert.ok(isRejected(observed));
      assert.deepEqual(observed.originChecks, []);
    },
  );

  // ---- REQ-EA-207..209: Origin is the fallback ----

  Given(
    "an unsafe {string} request with no {string} header and an {string} header matching the application's configured allowed origins",
    function* (method: string, absent: string, header: string) {
      assert.equal(absent, "Sec-Fetch-Site");
      assert.equal(header, "Origin");
      yield* arrange({ method });
      yield* validPair;
      yield* arrange({ header: ["origin", ALLOWED_ORIGIN] });
    },
  );

  Given(
    "an unsafe {string} request with no {string} header and an {string} header that does not match the application's configured allowed origins",
    function* (method: string, absent: string, header: string) {
      assert.equal(absent, "Sec-Fetch-Site");
      assert.equal(header, "Origin");
      yield* arrange({ method });
      yield* validPair;
      yield* arrange({ header: ["origin", EVIL_ORIGIN] });
    },
  );

  Then("the request passes the {string} fallback check", function* (check: string) {
    assert.equal(check, "Origin");
    const observed = yield* lastObservation();
    assert.equal(observed.status, 200);
    assert.equal(observed.hits, 1);
    // ... and it passed *because* the Origin was compared against the allow-list.
    assert.deepEqual(observed.originChecks, [ALLOWED_ORIGIN]);
  });

  Given(
    "an unsafe {string} request carrying {string} and an {string} header that would fail the fallback comparison",
    function* (method: string, siteHeader: string, origin: string) {
      assert.equal(origin, "Origin");
      yield* arrange({ method });
      yield* validPair;
      yield* arrange({ header: parseHeader(siteHeader) });
      yield* arrange({ header: ["origin", EVIL_ORIGIN] });
    },
  );

  Then("the request passes on the {string} signal", function* (signal: string) {
    assert.equal(signal, "Sec-Fetch-Site");
    const observed = yield* lastObservation();
    assert.equal(observed.status, 200);
    assert.equal(observed.hits, 1);
  });

  Then("the {string} header is never compared", function* (header: string) {
    assert.equal(header, "Origin");
    const observed = yield* lastObservation();
    assert.deepEqual(observed.originChecks, []);
  });

  // ---- REQ-EA-210..213: the signed double-submit cookie ----

  Given("a signed {string} cookie was issued to the client", function* (name: string) {
    assert.equal(name, Api.CSRF_COOKIE_NAME);
    const token = yield* issueCookie();
    yield* setOutcome("cookieToken", token);
    yield* arrange({ header: ["cookie", cookieHeaderFor(token)] });
  });

  Given(
    "an unsafe {string} request echoes that cookie's token in the {string} header",
    function* (method: string, header: string) {
      assert.equal(header, Api.CSRF_HEADER_NAME);
      yield* arrange({ method });
      yield* arrange({ header: [Api.CSRF_HEADER_NAME, String(yield* getOutcome("cookieToken"))] });
    },
  );

  Then("the request passes the double-submit check", function* () {
    const observed = yield* lastObservation();
    assert.equal(observed.status, 200);
    assert.equal(observed.hits, 1);
  });

  Given(
    "an unsafe {string} request carries no {string} header",
    function* (method: string, header: string) {
      assert.equal(header, Api.CSRF_HEADER_NAME);
      yield* arrange({ method });
    },
  );

  Given(
    "an unsafe {string} request carries an {string} header that does not match the cookie's token",
    function* (method: string, header: string) {
      assert.equal(header, Api.CSRF_HEADER_NAME);
      yield* arrange({ method });
      // A second, genuinely signed token the server issued: valid on its own, just not this cookie's.
      const other = yield* issueCookie();
      assert.notEqual(other, String(yield* getOutcome("cookieToken")));
      yield* arrange({ header: [Api.CSRF_HEADER_NAME, other] });
    },
  );

  Given("a {string} cookie whose signature does not verify", function* (name: string) {
    assert.equal(name, Api.CSRF_COOKIE_NAME);
    const genuine = yield* issueCookie();
    const last = genuine.at(-1);
    // Flip the final hex digit of the HMAC: same shape, same `iat`, different signature.
    const tampered = `${genuine.slice(0, -1)}${last === "0" ? "1" : "0"}`;
    yield* setOutcome("cookieToken", tampered);
    yield* arrange({ header: ["cookie", cookieHeaderFor(tampered)] });
  });

  Given(
    "an unsafe {string} request echoes that cookie's token value in the {string} header",
    function* (method: string, header: string) {
      assert.equal(header, Api.CSRF_HEADER_NAME);
      yield* arrange({ method });
      yield* arrange({ header: [Api.CSRF_HEADER_NAME, String(yield* getOutcome("cookieToken"))] });
    },
  );

  // ---- REQ-EA-214/215: the client requires the CSRF layer, by type ----

  Given("a contract group carrying {string}", function* (middleware: string) {
    assert.ok(middlewareKeys(AppApi.groups.app).includes(middleware));
    yield* setOutcome("group", "app");
  });

  When(
    "an {string}\\/{string} is built with {string} supplied",
    function* (_client: string, _atom: string, layerClient: string) {
      assert.match(layerClient, /^HttpApiMiddleware\.layerClient\(CsrfProtection/);
      const app = yield* appHandle();
      const token = yield* issueCookie();
      // A browser's jar: the transport carries the cookie the server issued, the client layer
      // echoes it in the header (BEH-EA-170) — the two halves of the double-submit pair.
      const shim: typeof globalThis.fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", cookieHeaderFor(token));
        return app.handler(new Request(input, { ...init, headers }));
      };
      const answer = yield* Effect.gen(function* () {
        const client = yield* AuthClient.make(AppApi, { baseUrl: "http://localhost" });
        return yield* client.app.post();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer,
            Layer.succeed(FetchHttpClient.Fetch, shim),
            AuthClient.csrfClientLayer({
              readCookie: (name) => (name === Api.CSRF_COOKIE_NAME ? token : undefined),
              bootstrapRetry: false,
            }),
          ),
        ),
        Effect.orDie,
      );
      yield* setOutcome("clientAnswer", answer);
    },
  );

  Then("the client build type-checks and produces a usable client", function* () {
    // The type-level half is `csrfIsDischarged` (tsc); the runtime half is a real call through it.
    assert.equal(csrfIsDischarged, true);
    assert.equal(yield* getOutcome("clientAnswer"), "ok");
  });

  When(
    "an {string}\\/{string} is built without {string} supplied",
    function* (_client: string, _atom: string, layerClient: string) {
      assert.match(layerClient, /^HttpApiMiddleware\.layerClient\(CsrfProtection/);
      // Nothing to run: the outcome is a compile-time one, recorded in CsrfClientTypes.ts.
      yield* setOutcome("built", "without");
    },
  );

  Then("the client build fails to type-check", function* () {
    // With a transport supplied, `ForClient<CsrfProtection>` is exactly what is left unsatisfied
    // (`onlyCsrfIsMissing`, checked by `tsc`): the client cannot be run without the layer.
    assert.equal(yield* getOutcome("built"), "without");
    assert.equal(onlyCsrfIsMissing, true);
  });

  Then("the failure names {string} as still required", (marker: string) =>
    Effect.sync(() => {
      // `onlyCsrfIsMissing` is `Effect.Services<client> == ForClient<CsrfProtection>` exactly.
      assert.equal(marker, "ForClient<CsrfProtection>");
      assert.equal(onlyCsrfIsMissing, true);
    }),
  );

  // ---- REQ-EA-216: only unsafe methods ----

  Given(
    "a request using the {string} method with no CSRF header, no double-submit cookie, and no Sec-Fetch-Site header",
    function* (method: string) {
      yield* arrange({ method });
    },
  );

  Then("the request is {string}", function* (outcome: string) {
    const observed = yield* lastObservation();
    if (outcome === "not subject to rejection") {
      assert.equal(observed.status, 200);
      assert.equal(observed.hits, 1);
    } else {
      assert.equal(outcome, "rejected");
      assert.ok(isRejected(observed), `${observed.status} ${observed.body}`);
    }
  });

  // ---- REQ-EA-217/218: one typed error and status ----

  Given(
    "an unsafe {string} request that fails the {string} check",
    function* (method: string, check: string) {
      yield* arrange({ method });
      if (check === "Sec-Fetch-Site") {
        yield* validPair;
        yield* arrange({ header: ["sec-fetch-site", "cross-site"] });
      } else if (check === "Origin fallback") {
        yield* validPair;
        yield* arrange({ header: ["origin", EVIL_ORIGIN] });
      } else {
        assert.equal(check, "double-submit cookie");
        // No site signal at all, and no pair: only the double-submit check can reject.
      }
    },
  );

  Then("the request fails with a typed {string} error", function* (tag: string) {
    const observed = yield* lastObservation();
    assert.equal(observed.tag, tag);
    assert.equal(observed.hits, 0);
  });

  Then("the response is {string}", function* (expected: string) {
    const observed = yield* lastObservation();
    assert.equal(expected, `${observed.status} ${observed.status === 403 ? "Forbidden" : "?"}`);
  });

  Given(
    "two different groups, {string} and {string}, both carrying {string}",
    function* (first: string, second: string, middleware: string) {
      assert.deepEqual([first, second], ["app", "billing"]);
      assert.ok(middlewareKeys(AppApi.groups.app).includes(middleware));
      assert.ok(middlewareKeys(BillingApi.groups.billing).includes(middleware));
      yield* arrange({ method: "POST" });
    },
  );

  When("a request to each group fails a CSRF check", function* () {
    const spec = yield* pendingRequest();
    yield* setOutcome("app", yield* send({ ...spec, group: "app" }));
    yield* setOutcome("billing", yield* send({ ...spec, group: "billing" }));
  });

  Then(
    "both requests fail with the identical {string} error annotated {string}",
    function* (tag: string, status: string) {
      const app = yield* getOutcome("app");
      const billing = yield* getOutcome("billing");
      assert.ok(isObservation(app) && isObservation(billing));
      for (const observed of [app, billing]) {
        assert.equal(observed.tag, tag);
        assert.equal(String(observed.status), status);
      }
      assert.equal(app.body, billing.body, "the two groups must answer with the identical body");
    },
  );

  // ---- REQ-EA-221/222: fixed names ----

  Given(
    "two different applications composed through {string} with different installed plugins",
    function* (compose: string) {
      assert.equal(compose, "Auth.make");
      yield* setApp("appOnly", buildApp("app"));
      yield* setApp("billingOnly", buildApp("billing"));
    },
  );

  When("each application's {string} middleware is inspected", function* (middleware: string) {
    assert.equal(middleware, "CsrfProtection");
    const inspect = Effect.fn("features.csrf.inspect")(function* (
      key: string,
      group: "app" | "billing",
    ) {
      const handle = yield* getApp(key);
      // The cookie name is what the server sets on a safe request...
      const first = yield* sendTo(handle, { method: "GET", group, headers: {} });
      assert.ok(first.issuedToken !== undefined, `${key}: no ${Api.CSRF_COOKIE_NAME} was set`);
      const cookie = cookieHeaderFor(first.issuedToken);
      // ...and the header name is the one an echo must arrive under: the right one passes, another does not.
      const accepted = yield* sendTo(handle, {
        method: "POST",
        group,
        headers: { cookie, [Api.CSRF_HEADER_NAME]: first.issuedToken },
      });
      const renamed = yield* sendTo(handle, {
        method: "POST",
        group,
        headers: { cookie, "x-xsrf-token": first.issuedToken },
      });
      return { accepted: accepted.status, renamed: renamed.status };
    });
    yield* setOutcome("appOnlyResult", yield* inspect("appOnly", "app"));
    yield* setOutcome("billingOnlyResult", yield* inspect("billingOnly", "billing"));
  });

  Then(
    "both use the cookie name {string} and the header name {string}",
    function* (cookieName: string, headerName: string) {
      assert.equal(cookieName, "__Host-csrf");
      assert.equal(headerName, "x-csrf-token");
      for (const key of ["appOnlyResult", "billingOnlyResult"]) {
        const result = yield* getOutcome(key);
        assert.deepEqual(result, { accepted: 200, renamed: 403 }, key);
      }
    },
  );

  Given("an application composed through {string}", (compose: string) =>
    Effect.sync(() => assert.equal(compose, "Auth.make")),
  );

  When(
    "a plugin or application configuration attempts to override the CSRF cookie or header name",
    function* () {
      // The attempt a type-checking author cannot make (see `overrideAttempt` in the World) made
      // anyway through a value the compiler does not inspect: the extra fields ride along in the
      // `CsrfConfig` the middleware is built with.
      const renamed = buildApp("app", { cookieName: "renamed-csrf", headerName: "x-renamed-csrf" });
      const first = yield* sendTo(renamed, { method: "GET", group: "app", headers: {} });
      yield* setOutcome("renamedFirst", first);
    },
  );

  Then(
    "no such override is available, since {string} and {string} are fixed for every application",
    function* (cookieName: string, headerName: string) {
      assert.equal(headerName, Api.CSRF_HEADER_NAME);
      const first = yield* getOutcome("renamedFirst");
      assert.ok(isObservation(first));
      assert.equal(first.issuedToken !== undefined, true);
      assert.match(first.setCookie ?? "", new RegExp(`^${cookieName}=`));
      assert.ok(!(first.setCookie ?? "").includes("renamed-csrf"));
    },
  );

  // ---- new scenario under BEH-EA-079: the bearer exemption that shipped instead of csrf:false ----

  Given("a native client with a bearer token and no cookie jar", function* () {
    yield* arrange({ method: "POST" });
  });

  When(
    "it sends an unsafe {string} request carrying an {string} header and no CSRF header or double-submit cookie",
    function* (method: string, header: string) {
      assert.equal(header, "Authorization");
      yield* arrange({ method });
      yield* arrange({ header: ["authorization", "Bearer opaque-session-token"] });
      yield* send(yield* pendingRequest());
    },
  );

  Then(
    "the request passes without any CSRF check being applied to it, and no {string} cookie is minted for it",
    function* (cookieName: string) {
      const observed = yield* lastObservation();
      assert.equal(observed.status, 200);
      assert.equal(observed.hits, 1);
      assert.ok(!(observed.setCookie ?? "").includes(cookieName));
    },
  );

  Then(
    "an unsafe {string} request with an empty {string} header and no CSRF pair is still rejected",
    function* (method: string, header: string) {
      assert.equal(header, "Authorization");
      const observed = yield* send({
        method,
        group: "app",
        headers: { authorization: "   " },
      });
      assert.ok(isRejected(observed), `${observed.status} ${observed.body}`);
    },
  );
});
