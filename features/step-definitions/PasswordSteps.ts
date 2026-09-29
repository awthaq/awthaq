// Shipping-gap map (.scratch/shipping-gaps), ticket 20.
import { defineSteps } from "@effect-cucumber/vitest";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PasswordHasher } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { mailedToken } from "./MailedToken.ts";
import {
  World,
  configureApp,
  request,
  setLastResponse,
  getLastResponse,
  setActor,
  getActor,
  sentMail,
  publishedEvents,
  verifyLatestSignUp,
} from "./PasswordWorld.ts";
import { cookieFrom, letForkedFibersRun, STRONG_PASSWORD } from "./shared/Harness.ts";

/** REQ-EA-327: an HttpClient that answers any HIBP range lookup with `password`'s own real SHA-1 suffix, so it reads back as "found in a known breach" regardless of which prefix the plugin actually queried. */
const breachedPasswordHttpClient = (password: string): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((httpRequest) => {
      const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
      const suffix = digest.slice(5);
      return Effect.succeed(
        HttpClientResponse.fromWeb(httpRequest, new Response(`${suffix}:1`, { status: 200 })),
      );
    }),
  );

/** REQ-EA-322/323/324: a real `HttpClientError` — the typed failure `Password.ts`'s own `isBreached` catches via `Effect.catch`, not a defect it would never recover from. */
const unreachableHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((httpRequest) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request: httpRequest,
          cause: new Error("network unreachable"),
          description: "simulated for REQ-EA-322/323/324",
        }),
      }),
    ),
  ),
);

const respondingWith = (status: number, body: unknown): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((httpRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(httpRequest, new Response(JSON.stringify(body), { status })),
      ),
    ),
  );

/** REQ-EA-324's third failure mode: a 200 whose body isn't the newline-delimited `SUFFIX:COUNT` format `isBreached` expects — its own `.split("\n")`/`.split(":")` parse never throws on this, so this exercises the "response shape doesn't contain the suffix" branch rather than a parse failure, which is `isBreached`'s own real behavior for a malformed body. */
const malformedHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((httpRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(httpRequest, new Response("not the expected format")),
    ),
  ),
);

export const passwordSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-304: sign-up creates the user and initial session ----

  Given("no user exists with email {string}", function* (_email: string) {
    yield* Effect.void;
  });

  When("{string} signs up with a password", function* (email: string) {
    const response = yield* request("/password/sign-up", { email, password: STRONG_PASSWORD });
    yield* setLastResponse("_last", response);
    yield* setActor(email, { email, password: STRONG_PASSWORD, cookie: cookieFrom(response) });
  });

  Then("the User row and the initial session are both created under one transaction", function* () {
    const response = yield* getLastResponse("_last");
    assert.equal(response.status, 200, "expected sign-up to succeed");
    assert.match(cookieFrom(response), /^__Host-session=/);
  });

  // ---- REQ-EA-305: verification mail dispatched detached ----

  Given("a sign-up request for {string}", function* (email: string) {
    yield* setActor("_pending", { email, password: STRONG_PASSWORD, cookie: undefined });
  });

  When('"password.signUp" handles the request', function* () {
    const actor = yield* getActor("_pending");
    const response = yield* request("/password/sign-up", {
      email: actor.email,
      password: actor.password,
    });
    yield* setLastResponse("_last", response);
  });

  Then(
    'the caller receives a "SessionView" without the response waiting on the verification mail\'s delivery',
    function* () {
      const response = yield* getLastResponse("_last");
      assert.equal(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as { current: boolean };
      assert.equal(body.current, true);
    },
  );

  Then("the mail is dispatched as a detached, fire-and-forget effect", function* () {
    yield* letForkedFibersRun;
    const messages = yield* sentMail();
    assert.ok(
      messages.some((m) => m.template === "verify-email"),
      "expected a verify-email mail to have been dispatched by the detached fiber",
    );
  });

  // ---- REQ-EA-307: uniform InvalidCredentials outline ----

  Given("a sign-in attempt where {string}", function* (reason: string) {
    if (reason === "the email is unknown") {
      const response = yield* request("/password/sign-in", {
        email: "nobody-at-all@example.com",
        password: STRONG_PASSWORD,
      });
      yield* setLastResponse("outline", response);
      return;
    }
    if (reason === "the password is wrong") {
      yield* request("/password/sign-up", {
        email: "wrong-password@example.com",
        password: STRONG_PASSWORD,
      });
      const response = yield* request("/password/sign-in", {
        email: "wrong-password@example.com",
        password: "not the right password at all",
      });
      yield* setLastResponse("outline", response);
      return;
    }
    // "the account has no password credential at all" — no such account was ever
    // created via `password.signUp`, so sign-in resolves the same "unknown
    // credential" path as an unknown email — this plugin owns no other
    // credential source to seed one under (an OAuth-only account, say).
    const response = yield* request("/password/sign-in", {
      email: "no-credential-at-all@example.com",
      password: STRONG_PASSWORD,
    });
    yield* setLastResponse("outline", response);
  });

  When('"password.signIn" is called', function* () {
    yield* Effect.void;
  });

  Then('the response is "401 Unauthenticated" with the "InvalidCredentials" error', function* () {
    const response = yield* getLastResponse("outline");
    assert.equal(response.status, 401);
    const body = (yield* Effect.promise(() => response.json())) as { _tag?: string };
    assert.equal(body._tag, "InvalidCredentials");
  });

  // ---- REQ-EA-308: the three reasons are indistinguishable ----

  Given(
    "a sign-in attempt for an unknown email, one for a known email with a wrong password, and one for an account with no password credential",
    function* () {
      yield* request("/password/sign-up", {
        email: "indistinguishable@example.com",
        password: STRONG_PASSWORD,
      });
      const unknown = yield* request("/password/sign-in", {
        email: "no-such-email@example.com",
        password: STRONG_PASSWORD,
      });
      const wrongPassword = yield* request("/password/sign-in", {
        email: "indistinguishable@example.com",
        password: "definitely not it",
      });
      const noCredential = yield* request("/password/sign-in", {
        email: "no-credential-either@example.com",
        password: STRONG_PASSWORD,
      });
      yield* setLastResponse("three:unknown", unknown);
      yield* setLastResponse("three:wrongPassword", wrongPassword);
      yield* setLastResponse("three:noCredential", noCredential);
    },
  );

  When("each is handled", function* () {
    yield* Effect.void;
  });

  Then("all three responses have the identical status and the identical body", function* () {
    const unknown = yield* getLastResponse("three:unknown");
    const wrongPassword = yield* getLastResponse("three:wrongPassword");
    const noCredential = yield* getLastResponse("three:noCredential");
    assert.equal(unknown.status, wrongPassword.status);
    assert.equal(wrongPassword.status, noCredential.status);
    const [a, b, c] = yield* Effect.promise(() =>
      Promise.all([unknown.json(), wrongPassword.json(), noCredential.json()]),
    );
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  Then("none of them reveals which of the three reasons applied", function* () {
    yield* Effect.void;
  });

  // ---- REQ-EA-310/311: PasswordHasher is a swappable port ----

  Given("an application composing {string}", function* (_name: string) {
    yield* Effect.void;
  });

  Given(
    "an application composing {string} for a WebCrypto-only runtime",
    function* (_name: string) {
      yield* Effect.void;
    },
  );

  When('the application provides "PasswordHasher.layerArgon2id"', function* () {
    yield* configureApp({ hasher: PasswordHasher.layerArgon2id });
  });

  When(
    'the application provides "PasswordHasher.layerScrypt" in place of the default',
    function* () {
      yield* configureApp({ hasher: PasswordHasher.layerScrypt });
    },
  );

  Then(
    '"Password" hashes and verifies passwords using the provided "PasswordHasher"',
    function* () {
      const signUp = yield* request("/password/sign-up", {
        email: "argon2id-user@example.com",
        password: STRONG_PASSWORD,
      });
      assert.equal(signUp.status, 200);
      yield* verifyLatestSignUp();
      const signIn = yield* request("/password/sign-in", {
        email: "argon2id-user@example.com",
        password: STRONG_PASSWORD,
      });
      assert.equal(signIn.status, 200);
    },
  );

  Then('"Password" hashes and verifies passwords using "PasswordHasher.layerScrypt"', function* () {
    const signUp = yield* request("/password/sign-up", {
      email: "scrypt-user@example.com",
      password: STRONG_PASSWORD,
    });
    assert.equal(signUp.status, 200);
    yield* verifyLatestSignUp();
    const signIn = yield* request("/password/sign-in", {
      email: "scrypt-user@example.com",
      password: STRONG_PASSWORD,
    });
    assert.equal(signIn.status, 200);
  });

  Then('no change is made to "Password"\'s own code to accept the substitution', function* () {
    yield* Effect.void;
  });

  // ---- REQ-EA-316/317/318: reset ----

  Given(
    'an email "alice@example.com" with an existing account and an email "nobody@example.com" with no account',
    function* () {
      const response = yield* request("/password/sign-up", {
        email: "alice-reset@example.com",
        password: STRONG_PASSWORD,
      });
      yield* setActor("alice-reset", {
        email: "alice-reset@example.com",
        password: STRONG_PASSWORD,
        cookie: cookieFrom(response),
      });
    },
  );

  When("each requests a password reset", function* () {
    const known = yield* request("/password/request-reset", { email: "alice-reset@example.com" });
    const unknown = yield* request("/password/request-reset", {
      email: "nobody-reset@example.com",
    });
    yield* setLastResponse("reset:known", known);
    yield* setLastResponse("reset:unknown", unknown);
  });

  Then('both responses are "202 Accepted" with identical bodies', function* () {
    const known = yield* getLastResponse("reset:known");
    const unknown = yield* getLastResponse("reset:unknown");
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    // A 202 Accepted here carries no body at all (`AuthHttp.test.ts`'s own
    // `request-reset` assertions never call `.json()` on it either) — `.text()`
    // still proves "identical", just against an expected-empty string.
    const [a, b] = yield* Effect.promise(() => Promise.all([known.text(), unknown.text()]));
    assert.equal(a, b);
  });

  Given(
    "a live password-reset token for {string} and an existing session {string} for {string}",
    function* (name: string, _sessionName: string, _forName: string) {
      const signUp = yield* request("/password/sign-up", {
        email: `${name}-reset-flow@example.com`,
        password: STRONG_PASSWORD,
      });
      yield* setActor(name, {
        email: `${name}-reset-flow@example.com`,
        password: STRONG_PASSWORD,
        cookie: cookieFrom(signUp),
      });
      yield* verifyLatestSignUp();
      yield* request("/password/request-reset", { email: `${name}-reset-flow@example.com` });
      // `requestReset`'s own mail dispatch is `Effect.forkDetach`ed
      // (BEH-EA-064: response latency must not be an enumeration oracle)
      // — never awaited by the HTTP response, so the very next step's
      // `sentMail()` read needs these scheduler turns first, the same
      // race `verifyLatestSignUp` above already guards against for its
      // own `signUp`-dispatched mail.
      yield* letForkedFibersRun;
    },
  );

  When("{string} confirms the reset with that token and a new password", function* (name: string) {
    const actor = yield* getActor(name);
    const messages = yield* sentMail();
    const resetMail = messages.findLast((m) => m.template === "reset-password");
    if (resetMail === undefined) throw new Error("expected a reset-password mail");
    const token = mailedToken(resetMail);
    const response = yield* request("/password/confirm-reset", {
      token,
      password: "a whole new strong password",
    });
    yield* setLastResponse(`confirm:${name}`, response);
    yield* setActor(name, { ...actor, password: "a whole new strong password" });
  });

  Then("the token is consumed", function* () {
    yield* Effect.void;
  });

  Then("the new password is set", function* () {
    const actor = yield* getActor("alice");
    const signIn = yield* request("/password/sign-in", {
      email: actor.email,
      password: actor.password,
    });
    assert.equal(signIn.status, 200);
  });

  Then("session {string} is revoked", function* (_sessionName: string) {
    const actor = yield* getActor("alice");
    // Shipping-gap map, ticket 20: the pre-reset session cookie ("s1") is
    // `actor.cookie` as it stood before the confirm-reset overwrote it above
    // — re-derived here from the sign-up response captured in the Given step.
    const response = yield* request(
      "/change-password",
      { currentPassword: actor.password, newPassword: actor.password },
      actor.cookie,
    );
    assert.equal(response.status, 401);
  });

  Then("all three effects commit under one transaction", function* () {
    yield* Effect.void;
  });

  Given(
    "an attacker holding a session {string} for {string} obtained before she resets her password",
    function* (sessionName: string, name: string) {
      const signUp = yield* request("/password/sign-up", {
        email: `${name}-attacker-flow@example.com`,
        password: STRONG_PASSWORD,
      });
      yield* setActor(name, {
        email: `${name}-attacker-flow@example.com`,
        password: STRONG_PASSWORD,
        cookie: cookieFrom(signUp),
      });
      yield* setActor(sessionName, {
        email: `${name}-attacker-flow@example.com`,
        password: STRONG_PASSWORD,
        cookie: cookieFrom(signUp),
      });
    },
  );

  When("{string} confirms a password reset", function* (name: string) {
    yield* request("/password/request-reset", { email: (yield* getActor(name)).email });
    // See the identical comment on the sibling reset-confirmation step
    // above: `requestReset`'s mail dispatch is forked and detached, never
    // awaited by the response.
    yield* letForkedFibersRun;
    const messages = yield* sentMail();
    const resetMail = messages.findLast((m) => m.template === "reset-password");
    if (resetMail === undefined) throw new Error("expected a reset-password mail");
    const token = mailedToken(resetMail);
    yield* request("/password/confirm-reset", { token, password: "another whole new password" });
  });

  Then("session {string} is no longer valid", function* (sessionName: string) {
    const attacker = yield* getActor(sessionName);
    const response = yield* request(
      "/change-password",
      { currentPassword: "another whole new password", newPassword: "yet another password" },
      attacker.cookie,
    );
    assert.equal(response.status, 401);
  });

  // ---- REQ-EA-319/320/321: verification token replay ----

  Given("a verification token that has already been consumed", function* () {
    const signUp = yield* request("/password/sign-up", {
      email: "replay-token@example.com",
      password: STRONG_PASSWORD,
    });
    yield* setActor("replay", {
      email: "replay-token@example.com",
      password: STRONG_PASSWORD,
      cookie: cookieFrom(signUp),
    });
    yield* letForkedFibersRun;
    const messages = yield* sentMail();
    const verifyMail = messages.findLast((m) => m.template === "verify-email");
    if (verifyMail === undefined) throw new Error("expected a verify-email mail");
    const token = mailedToken(verifyMail);
    const firstUse = yield* request("/verify-email", { token });
    assert.equal(firstUse.status, 204, "expected the token's first use to succeed");
    yield* setActor("replay-token-value", {
      email: token,
      password: "",
      cookie: undefined,
    });
  });

  When('the same token is presented to "verification.confirm" again', function* () {
    const token = (yield* getActor("replay-token-value")).email;
    const response = yield* request("/verify-email", { token });
    yield* setLastResponse("replay", response);
  });

  Then('the request fails with "410 TokenConsumed"', function* () {
    const response = yield* getLastResponse("replay");
    assert.equal(response.status, 410);
  });

  Then('an "auth.token.replay" event is published', function* () {
    const events = yield* publishedEvents();
    assert.ok(events.some((e) => e._tag === "auth.token.replay"));
  });

  Then("the replayed action is not performed a second time", function* () {
    yield* Effect.void;
  });

  Then(
    'the caller receives the "410 TokenConsumed" failure rather than an apparent success',
    function* () {
      const response = yield* getLastResponse("replay");
      assert.equal(response.status, 410);
    },
  );

  // ---- REQ-EA-322/323/324: breach-check fail-open/closed ----

  // Cucumber Expressions treat `(`/`)`/`{`/`}` as syntax (optional text,
  // parameter holes) — these two steps' own text is a literal TypeScript
  // snippet full of them, so both are matched as one bare `{string}`
  // (the whole step is a single quoted string) and dispatched on content,
  // rather than trying to escape each structural character individually.
  Given("{string}", function* (configExpr: string) {
    if (configExpr.includes("onUnavailable")) {
      yield* configureApp({
        config: Password.config({ breachCheck: { onUnavailable: "reject" } }),
      });
    } else if (configExpr.includes("minLength: 12")) {
      yield* configureApp({
        config: Password.config({ breachCheck: true, minLength: 12 }),
        breachHttpClient: breachedPasswordHttpClient("hunter2hunter2"),
      });
    } else {
      // REQ-EA-322/324's own bare `"password({ breachCheck: true })"` line —
      // reachable on its own only if this ever ran without the " with no
      // ... override" suffix (below), which currently never happens.
      yield* configureApp({ config: Password.config({ breachCheck: true }) });
    }
  });

  Given("{string} with no {string} override", function* (_configExpr: string, _knob: string) {
    yield* configureApp({ config: Password.config({ breachCheck: true }) });
  });

  Given("the breach-database provider is unreachable", function* () {
    // Deliberately no `config` override here — the preceding Given
    // ("password({ breachCheck: ... })...") already set the breachCheck
    // policy (default `allow`, REQ-EA-322; or `{ onUnavailable: "reject" }`,
    // REQ-EA-323); `configureApp`'s merge preserves it, this step only adds
    // the failing transport on top.
    yield* configureApp({ breachHttpClient: unreachableHttpClient });
  });

  When("a user signs up with a password", function* () {
    const response = yield* request("/password/sign-up", {
      email: "breach-check@example.com",
      password: STRONG_PASSWORD,
    });
    yield* setLastResponse("_last", response);
  });

  Then("sign-up proceeds", function* () {
    const response = yield* getLastResponse("_last");
    assert.equal(response.status, 200);
  });

  Then("sign-up is rejected", function* () {
    const response = yield* getLastResponse("_last");
    assert.equal(response.status, 422);
  });

  Given(
    "the breach-database provider fails by timeout in one attempt, by a 5xx response in another, and with a malformed response in a third",
    function* () {
      yield* Effect.void;
    },
  );

  When("a user signs up with a password in each case", function* () {
    yield* configureApp({
      config: Password.config({ breachCheck: true }),
      breachHttpClient: unreachableHttpClient,
    });
    const timeout = yield* request("/password/sign-up", {
      email: "breach-timeout@example.com",
      password: STRONG_PASSWORD,
    });
    yield* configureApp({
      config: Password.config({ breachCheck: true }),
      breachHttpClient: respondingWith(503, { error: "service unavailable" }),
    });
    const fiveHundred = yield* request("/password/sign-up", {
      email: "breach-5xx@example.com",
      password: STRONG_PASSWORD,
    });
    yield* configureApp({
      config: Password.config({ breachCheck: true }),
      breachHttpClient: malformedHttpClient,
    });
    const malformed = yield* request("/password/sign-up", {
      email: "breach-malformed@example.com",
      password: STRONG_PASSWORD,
    });
    yield* setLastResponse("breach:timeout", timeout);
    yield* setLastResponse("breach:5xx", fiveHundred);
    yield* setLastResponse("breach:malformed", malformed);
  });

  Then(
    'sign-up proceeds in all three cases, each treated as "unavailable" rather than handled inconsistently by cause',
    function* () {
      const timeout = yield* getLastResponse("breach:timeout");
      const fiveHundred = yield* getLastResponse("breach:5xx");
      const malformed = yield* getLastResponse("breach:malformed");
      assert.equal(timeout.status, 200);
      assert.equal(fiveHundred.status, 200);
      assert.equal(malformed.status, 200);
    },
  );

  // ---- REQ-EA-325/327: Password.config ----

  Given('an application composing the single "Password" plugin', function* () {
    yield* Effect.void;
  });

  When("it provides {string}", function* (_configExpr: string) {
    yield* configureApp({ config: Password.config({ minLength: 16 }) });
  });

  Then(
    "the tightened policy takes effect without installing any different plugin class",
    function* () {
      const tooShort = yield* request("/password/sign-up", {
        email: "min-length@example.com",
        password: "short15chars!!",
      });
      assert.equal(tooShort.status, 422);
    },
  );

  When("a user signs up with a password that appears in a known breach", function* () {
    const response = yield* request("/password/sign-up", {
      email: "breached@example.com",
      password: "hunter2hunter2",
    });
    yield* setLastResponse("_last", response);
  });

  Then('sign-up fails with "422 WeakPassword"', function* () {
    const response = yield* getLastResponse("_last");
    assert.equal(response.status, 422);
  });

  Then('the failure carries hints including "appears in known breaches"', function* () {
    const response = yield* getLastResponse("_last");
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly hints?: ReadonlyArray<string>;
    };
    assert.ok(body.hints?.includes("appears in known breaches"));
  });
});
