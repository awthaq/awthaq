// Shipping-gap map (.scratch/shipping-gaps), ticket 20.
//
// P20a: Givens arrange (or assert) state and Whens perform the request the scenario's When names
// (AH-004); every entity a step names is looked up by that exact name (AH-008/BDD-008); no step
// claims an outcome it does not observe (TIR-005/AH-009).
import { defineSteps } from "@effect-cucumber/vitest";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { mailedToken } from "./MailedToken.ts";
import {
  World,
  configureApp,
  createUserWithoutCredential,
  currentActor,
  currentHasherNeedsRehash,
  currentHasherVerifies,
  currentOptions,
  emailIsVerified,
  getActor,
  getLastResponse,
  getNote,
  getSessionCookie,
  hashUnderArgon2Params,
  plantCredentialHash,
  publishedEvents,
  request,
  sentMail,
  sessionIsLive,
  setActor,
  setFault,
  setLastResponse,
  setNote,
  setSession,
  settle,
  storedCredentialHash,
  userExists,
  verifyLatestSignUp,
} from "./PasswordWorld.ts";
import type { BreachFailure } from "./PasswordWorld.ts";
import type { PasswordConfigOptions } from "./PasswordParameterTypes.ts";
import {
  cheapArgon2id,
  cheapScrypt,
  cookieFrom,
  letForkedFibersRun,
  STRONG_PASSWORD,
} from "./shared/Harness.ts";

const NEW_PASSWORD = "a whole new strong password";
const WRONG_PASSWORD = "not the right password at all";

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

/** REQ-EA-322/323: a real `HttpClientError` — the typed failure `Password.ts`'s own `isBreached` catches via `Effect.catch`, not a defect it would never recover from. */
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

/**
 * CSD-009: a 5xx whose body is a perfectly well-formed range listing that does not contain the
 * password — so only the status check (`filterStatusOk`) can tell it from a real "not breached"
 * answer; a malformed body would be caught by the shape check regardless.
 */
const serverErrorWithValidBodyHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((httpRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(httpRequest, new Response(`${"0".repeat(35)}:1`, { status: 503 })),
    ),
  ),
);

/** A 200 whose body isn't the newline-delimited `SUFFIX:COUNT` range listing `isBreached` expects — PHS-004: that counts as "unavailable", not as "not breached". */
const malformedHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((httpRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(httpRequest, new Response("not the expected format")),
    ),
  ),
);

/** A provider that never answers: only `breachCheckTimeout` ends the lookup (kept short by `arrangeBreachFailure`). */
const neverRespondingHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
);

/** CSD-009: arranges the named provider failure on top of whatever `Password.config` is already in force. */
const arrangeBreachFailure = (failure: BreachFailure) => {
  switch (failure) {
    case "timeout":
      return configureApp({
        breachHttpClient: neverRespondingHttpClient,
        passwordConfig: { breachCheckTimeout: Duration.millis(50) },
      });
    case "5xx":
      return configureApp({ breachHttpClient: serverErrorWithValidBodyHttpClient });
    case "malformed":
      return configureApp({ breachHttpClient: malformedHttpClient });
  }
};

/** Signs `email` up through the wire, registering the actor and, when a session was issued, its cookie. */
export const signUpActor = Effect.fn("features.password.signUpActor")(function* (
  name: string,
  email: string,
  password: string,
) {
  const response = yield* request("/password/sign-up", { email, password });
  yield* setLastResponse("_last", response);
  const cookie = response.status === 200 ? cookieFrom(response) : undefined;
  yield* setActor(name, { email, password, cookie });
  return { response, cookie };
});

export const signInAs = Effect.fn("features.password.signInAs")(function* (
  email: string,
  password: string,
) {
  return yield* request("/password/sign-in", { email, password });
});

/** The reset token mailed to `email`, read from the captured mail. */
export const latestResetToken = Effect.fn("features.password.latestResetToken")(function* (
  email: string,
) {
  yield* letForkedFibersRun;
  const mail = (yield* sentMail()).findLast(
    (message) => message.template === "reset-password" && message.to === email,
  );
  assert.ok(mail !== undefined, `expected a reset-password mail for ${email}`);
  return mailedToken(mail);
});

const responseBodyText = (response: Response) => Effect.promise(() => response.clone().text());

export const passwordSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-304: sign-up creates the user and initial session ----

  Given("no user exists with email {string}", function* (email: string) {
    // AH-004: asserted against the store, not assumed.
    assert.equal(yield* userExists(email), false, `expected no user for ${email}`);
  });

  Given("the initial session cannot be issued", function* () {
    // TIR-005: the atomicity claim is only observable over a real transaction.
    yield* configureApp({ storage: "sqlite" });
    yield* setFault("sessionIssue");
  });

  When("{string} signs up with a password", function* (email: string) {
    yield* signUpActor(email, email, STRONG_PASSWORD);
  });

  Then("the User row and the initial session are both created under one transaction", function* () {
    const response = yield* getLastResponse("_last");
    assert.equal(response.status, 200, "expected sign-up to succeed");
    const actor = yield* currentActor();
    assert.match(actor.cookie ?? "", /^__Host-session=/);
    // Both halves of the unit are observed: the row, and a live session issued for it.
    assert.equal(yield* userExists(actor.email), true, "the User row must exist");
    assert.equal(
      yield* sessionIsLive(actor.cookie ?? ""),
      true,
      "the initial session must be live",
    );
  });

  Then("the sign-up fails with a server error", function* () {
    const response = yield* getLastResponse("_last");
    assert.equal(response.status, 500);
  });

  Then("no User row exists for {string}", function* (email: string) {
    assert.equal(
      yield* userExists(email),
      false,
      `the failed sign-up left a User row for ${email}`,
    );
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
      const body = yield* Effect.promise(() => response.json());
      assert.ok(typeof body === "object" && body !== null && "current" in body);
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

  // AH-004: the Given only arranges — it stores the attempt (and creates whatever account the
  // reason needs); the request is the When's.
  Given("a sign-in attempt where {string}", function* (reason: string) {
    if (reason === "the email is unknown") {
      const email = "nobody-at-all@example.com";
      assert.equal(yield* userExists(email), false);
      yield* setActor("outline", { email, password: STRONG_PASSWORD, cookie: undefined });
      return;
    }
    if (reason === "the password is wrong") {
      const email = "alice@example.com";
      yield* signUpActor("_setup", email, STRONG_PASSWORD);
      yield* setActor("outline", { email, password: WRONG_PASSWORD, cookie: undefined });
      return;
    }
    if (reason === "the account has no password credential at all") {
      // A real user with no password account (e.g. an account created some other way).
      const email = "no-credential@example.com";
      yield* createUserWithoutCredential(email);
      yield* setActor("outline", { email, password: STRONG_PASSWORD, cookie: undefined });
      return;
    }
    throw new Error(`unrecognised sign-in failure reason "${reason}"`);
  });

  When('"password.signIn" is called', function* () {
    const attempt = yield* getActor("outline");
    yield* setLastResponse("outline", yield* signInAs(attempt.email, attempt.password));
  });

  Then('the response is "401 Unauthenticated" with the "InvalidCredentials" error', function* () {
    const response = yield* getLastResponse("outline");
    assert.equal(response.status, 401);
    const body = yield* Effect.promise(() => response.json());
    assert.ok(typeof body === "object" && body !== null && "_tag" in body);
    assert.equal(body._tag, "InvalidCredentials");
  });

  // ---- REQ-EA-308: the three reasons are indistinguishable ----

  Given(
    "a sign-in attempt for an unknown email, one for a known email with a wrong password, and one for an account with no password credential",
    function* () {
      assert.equal(yield* userExists("no-such-email@example.com"), false);
      yield* setActor("three:unknown", {
        email: "no-such-email@example.com",
        password: STRONG_PASSWORD,
        cookie: undefined,
      });
      yield* signUpActor("_setup", "indistinguishable@example.com", STRONG_PASSWORD);
      yield* setActor("three:wrongPassword", {
        email: "indistinguishable@example.com",
        password: "definitely not it",
        cookie: undefined,
      });
      yield* createUserWithoutCredential("no-credential-either@example.com");
      yield* setActor("three:noCredential", {
        email: "no-credential-either@example.com",
        password: STRONG_PASSWORD,
        cookie: undefined,
      });
    },
  );

  When("each is handled", function* () {
    for (const key of ["unknown", "wrongPassword", "noCredential"]) {
      const attempt = yield* getActor(`three:${key}`);
      yield* setLastResponse(`three:${key}`, yield* signInAs(attempt.email, attempt.password));
    }
  });

  Then("all three responses have the identical status and the identical body", function* () {
    const unknown = yield* getLastResponse("three:unknown");
    const wrongPassword = yield* getLastResponse("three:wrongPassword");
    const noCredential = yield* getLastResponse("three:noCredential");
    assert.equal(unknown.status, wrongPassword.status);
    assert.equal(wrongPassword.status, noCredential.status);
    const [a, b, c] = yield* Effect.promise(() =>
      Promise.all([
        unknown.clone().json(),
        wrongPassword.clone().json(),
        noCredential.clone().json(),
      ]),
    );
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  Then("none of them reveals which of the three reasons applied", function* () {
    // Beyond an identical status/body: no response header differs across the three (bar the
    // per-response `date`), and none echoes the address it was asked about.
    const keys = ["unknown", "wrongPassword", "noCredential"];
    const headerViews: Array<string> = [];
    for (const key of keys) {
      const response = yield* getLastResponse(`three:${key}`);
      const attempt = yield* getActor(`three:${key}`);
      const text = yield* responseBodyText(response);
      assert.ok(!text.includes(attempt.email), `the ${key} response echoes the address`);
      headerViews.push(
        JSON.stringify([...response.headers.entries()].filter(([name]) => name !== "date").sort()),
      );
    }
    assert.equal(new Set(headerViews).size, 1, "response headers differ across the three reasons");
  });

  // ---- REQ-EA-310/311: PasswordHasher is a swappable port ----

  // The composition is the World's own; naming it here composes it explicitly.
  Given("an application composing {string}", function* (_name: string) {
    yield* configureApp({});
  });

  Given(
    "an application composing {string} for a WebCrypto-only runtime",
    function* (_name: string) {
      yield* configureApp({});
    },
  );

  // P20a: the KDF layers run at the smallest legal cost (`shared/Harness.ts`); the algorithm, salt
  // and PHC format are the real ones, which is what the Thens check.
  When('the application provides "PasswordHasher.layerArgon2id"', function* () {
    yield* configureApp({ hasher: cheapArgon2id });
  });

  When(
    'the application provides "PasswordHasher.layerScrypt" in place of the default',
    function* () {
      yield* configureApp({ hasher: cheapScrypt });
    },
  );

  const signUpVerifySignIn = Effect.fn("features.password.signUpVerifySignIn")(function* (
    email: string,
  ) {
    const signUp = yield* request("/password/sign-up", { email, password: STRONG_PASSWORD });
    assert.equal(signUp.status, 200);
    yield* verifyLatestSignUp(email);
    const signIn = yield* signInAs(email, STRONG_PASSWORD);
    assert.equal(signIn.status, 200);
    return yield* storedCredentialHash(email);
  });

  Then(
    '"Password" hashes and verifies passwords using the provided "PasswordHasher"',
    function* () {
      const stored = yield* signUpVerifySignIn("argon2id-user@example.com");
      assert.match(stored, /^\$argon2id\$/);
    },
  );

  Then('"Password" hashes and verifies passwords using "PasswordHasher.layerScrypt"', function* () {
    const stored = yield* signUpVerifySignIn("scrypt-user@example.com");
    assert.match(stored, /^\$scrypt\$/);
  });

  Then('no change is made to "Password"\'s own code to accept the substitution', function* () {
    // The harness-level observation of "no change to Password": swapping the hasher touched
    // nothing but the hasher — no plugin option, config override or storage choice moved.
    const options = yield* currentOptions();
    const changed = Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .filter(
        ([key, value]) => !(key === "passwordConfig" && Object.keys(value ?? {}).length === 0),
      )
      .map(([key]) => key);
    assert.deepEqual(changed, ["hasher"]);
  });

  // ---- REQ-EA-313/314/315: rehash on login (PHS-005) ----

  // Weaker than the World's configured argon2id cost (m=1024, t=1), so the planted hash is
  // "computed under previously configured parameters".
  const PREVIOUS_PARAMS = { AUTH_ARGON2_MEMORY_KIB: "512", AUTH_ARGON2_ITERATIONS: "1" };

  const arrangeVerifiedUser = Effect.fn("features.password.arrangeVerifiedUser")(function* (
    name: string,
  ) {
    const email = `${name}@example.com`;
    yield* signUpActor(name, email, STRONG_PASSWORD);
    yield* verifyLatestSignUp(email);
    return email;
  });

  Given(
    "a user {string} whose stored password hash was computed under previously configured {string} parameters",
    function* (name: string, _port: string) {
      const email = yield* arrangeVerifiedUser(name);
      const outdated = yield* hashUnderArgon2Params(PREVIOUS_PARAMS, STRONG_PASSWORD);
      yield* plantCredentialHash(email, outdated);
      yield* setNote(`hashBefore:${name}`, outdated);
    },
  );

  Given(
    "{string}'s currently configured parameters are stronger than those under which the hash was stored",
    function* (_port: string) {
      const actor = yield* currentActor();
      const outdated = yield* getNote(`hashBefore:${actor.email.split("@")[0]}`);
      assert.equal(
        yield* currentHasherNeedsRehash(outdated),
        true,
        "the configured hasher must consider the planted hash outdated",
      );
    },
  );

  Given(
    "a user {string} whose stored password hash already matches {string}'s currently configured parameters",
    function* (name: string, _port: string) {
      const email = yield* arrangeVerifiedUser(name);
      const stored = yield* storedCredentialHash(email);
      assert.equal(yield* currentHasherNeedsRehash(stored), false);
      yield* setNote(`hashBefore:${name}`, stored);
    },
  );

  Given(
    "a user {string} whose stored hash's parameters differ from the currently configured parameters",
    function* (name: string) {
      const email = yield* arrangeVerifiedUser(name);
      const outdated = yield* hashUnderArgon2Params(PREVIOUS_PARAMS, STRONG_PASSWORD);
      yield* plantCredentialHash(email, outdated);
      assert.equal(yield* currentHasherNeedsRehash(outdated), true);
      yield* setNote(`hashBefore:${name}`, outdated);
    },
  );

  When("{string} signs in successfully with {word} password", function* (name: string) {
    const actor = yield* getActor(name);
    const response = yield* signInAs(actor.email, actor.password);
    assert.equal(response.status, 200, "expected a successful sign-in");
    yield* setLastResponse(`signIn:${name}`, response);
    // Read straight away: no scheduler turn is granted before the hash is inspected.
    yield* setNote(`hashAfter:${name}`, yield* storedCredentialHash(actor.email));
  });

  When("{string} signs in successfully", function* (name: string) {
    const actor = yield* getActor(name);
    const response = yield* signInAs(actor.email, actor.password);
    assert.equal(response.status, 200, "expected a successful sign-in");
    yield* setLastResponse(`signIn:${name}`, response);
    yield* setNote(`hashAfter:${name}`, yield* storedCredentialHash(actor.email));
  });

  Then(
    "the password is rehashed with the current parameters within the same request",
    function* () {
      const actor = yield* currentActor();
      const name = actor.email.split("@")[0] ?? actor.email;
      const after = yield* getNote(`hashAfter:${name}`);
      assert.equal(
        yield* currentHasherNeedsRehash(after),
        false,
        "the new hash is at current cost",
      );
      assert.match(after, /^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
      assert.equal(yield* currentHasherVerifies(STRONG_PASSWORD, after), true);
    },
  );

  Then("the stored hash is replaced with the new one", function* () {
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    assert.notEqual(yield* getNote(`hashAfter:${name}`), yield* getNote(`hashBefore:${name}`));
  });

  Then("the stored hash is not replaced", function* () {
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    assert.equal(yield* getNote(`hashAfter:${name}`), yield* getNote(`hashBefore:${name}`));
  });

  Then(
    "the rehash completes within the same request that serves the sign-in response",
    function* () {
      const actor = yield* currentActor();
      const name = actor.email.split("@")[0] ?? actor.email;
      // `hashAfter` was read before any scheduler turn followed the response.
      assert.notEqual(yield* getNote(`hashAfter:${name}`), yield* getNote(`hashBefore:${name}`));
    },
  );

  Then(
    "no separate background migration job is relied upon to update the stored hash",
    function* () {
      const actor = yield* currentActor();
      const name = actor.email.split("@")[0] ?? actor.email;
      // Once every detached fiber and timer has had its turn nothing changes the hash again:
      // the value the request left behind is the final one.
      yield* settle;
      assert.equal(yield* storedCredentialHash(actor.email), yield* getNote(`hashAfter:${name}`));
    },
  );

  // ---- REQ-EA-316/317/318: reset ----

  Given(
    "an email {string} with an existing account and an email {string} with no account",
    function* (known: string, unknown: string) {
      yield* signUpActor("known", known, STRONG_PASSWORD);
      assert.equal(yield* userExists(unknown), false, `expected no account for ${unknown}`);
      yield* setActor("unknown", { email: unknown, password: STRONG_PASSWORD, cookie: undefined });
    },
  );

  When("each requests a password reset", function* () {
    const known = yield* getActor("known");
    const unknown = yield* getActor("unknown");
    yield* setLastResponse(
      "reset:known",
      yield* request("/password/request-reset", { email: known.email }),
    );
    yield* setLastResponse(
      "reset:unknown",
      yield* request("/password/request-reset", { email: unknown.email }),
    );
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
    function* (name: string, sessionName: string, forName: string) {
      assert.equal(name, forName, "this step wires one user: the token's owner holds the session");
      // TIR-005: the reset unit is only atomic over a real transaction.
      yield* configureApp({ storage: "sqlite" });
      const email = `${name}@example.com`;
      const { cookie } = yield* signUpActor(name, email, STRONG_PASSWORD);
      assert.ok(cookie !== undefined, "sign-up must have issued the session");
      yield* setSession(sessionName, cookie);
      yield* setNote(`resetSession:${name}`, sessionName);
      assert.equal(yield* sessionIsLive(cookie), true, `session ${sessionName} must be live`);
      yield* verifyLatestSignUp(email);
      yield* request("/password/request-reset", { email });
      // `requestReset`'s own mail dispatch is `Effect.forkDetach`ed
      // (BEH-EA-064: response latency must not be an enumeration oracle)
      // — never awaited by the HTTP response, so the mail read needs these
      // scheduler turns first.
      yield* setNote(`resetToken:${name}`, yield* latestResetToken(email));
    },
  );

  When("{string} confirms the reset with that token and a new password", function* (name: string) {
    const actor = yield* getActor(name);
    const token = yield* getNote(`resetToken:${name}`);
    const response = yield* request("/password/confirm-reset", { token, password: NEW_PASSWORD });
    yield* setLastResponse(`confirm:${name}`, response);
    yield* setNote(`previousPassword:${name}`, actor.password);
    yield* setActor(name, { ...actor, password: NEW_PASSWORD });
  });

  Then("the token is consumed", function* () {
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    const confirm = yield* getLastResponse(`confirm:${name}`);
    assert.equal(confirm.status, 204, "the reset itself must have succeeded");
    // TIR-005: consumption is observed by replaying the token, not assumed.
    const replay = yield* request("/password/confirm-reset", {
      token: yield* getNote(`resetToken:${name}`),
      password: "yet another strong password",
    });
    assert.equal(replay.status, 410);
    const body = yield* Effect.promise(() => replay.json());
    assert.ok(typeof body === "object" && body !== null && "_tag" in body);
    assert.equal(body._tag, "TokenConsumed");
  });

  Then("the new password is set", function* () {
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    assert.equal((yield* signInAs(actor.email, actor.password)).status, 200);
    const previous = yield* getNote(`previousPassword:${name}`);
    assert.equal(
      (yield* signInAs(actor.email, previous)).status,
      401,
      "the old password must be dead",
    );
  });

  Then("session {string} is revoked", function* (sessionName: string) {
    assert.equal(yield* sessionIsLive(yield* getSessionCookie(sessionName)), false);
  });

  Then("all three effects commit under one transaction", function* () {
    // The three effects are observed together, over the real transaction the Given arranged;
    // that they can only ever appear together is the rollback scenario's claim (an injected
    // fault after the hash update leaves none of them applied).
    assert.equal((yield* currentOptions()).storage, "sqlite");
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    const replay = yield* request("/password/confirm-reset", {
      token: yield* getNote(`resetToken:${name}`),
      password: "yet another strong password",
    });
    assert.equal(replay.status, 410, "the token stays consumed");
    assert.equal((yield* signInAs(actor.email, actor.password)).status, 200, "new password live");
    const resetSession = yield* getNote(`resetSession:${name}`);
    assert.equal(
      yield* sessionIsLive(yield* getSessionCookie(resetSession)),
      false,
      `${resetSession} stays revoked`,
    );
  });

  Given("the reset fails after the credential hash update", function* () {
    yield* setFault("revokeAll");
  });

  Then("the request fails with a server error", function* () {
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    assert.equal((yield* getLastResponse(`confirm:${name}`)).status, 500);
  });

  Then("the old password still signs in", function* () {
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    const previous = yield* getNote(`previousPassword:${name}`);
    assert.equal((yield* signInAs(actor.email, previous)).status, 200);
    assert.equal(
      (yield* signInAs(actor.email, actor.password)).status,
      401,
      "the new password must not have been applied",
    );
  });

  Then("session {string} is still valid", function* (sessionName: string) {
    assert.equal(yield* sessionIsLive(yield* getSessionCookie(sessionName)), true);
  });

  Then("the reset token is still redeemable", function* () {
    const actor = yield* currentActor();
    const name = actor.email.split("@")[0] ?? actor.email;
    yield* setFault("none");
    const retry = yield* request("/password/confirm-reset", {
      token: yield* getNote(`resetToken:${name}`),
      password: NEW_PASSWORD,
    });
    assert.equal(retry.status, 204, "the token was burned by the rolled-back attempt");
  });

  // REQ-EA-318
  Given(
    "an attacker holding a session {string} for {string} obtained before she resets her password",
    function* (sessionName: string, name: string) {
      const email = `${name}@example.com`;
      const { cookie } = yield* signUpActor(name, email, STRONG_PASSWORD);
      assert.ok(cookie !== undefined, "sign-up must have issued the session");
      yield* setSession(sessionName, cookie);
      assert.equal(yield* sessionIsLive(cookie), true, "the attacker's session starts out live");
    },
  );

  When("{string} confirms a password reset", function* (name: string) {
    const actor = yield* getActor(name);
    yield* request("/password/request-reset", { email: actor.email });
    const token = yield* latestResetToken(actor.email);
    const response = yield* request("/password/confirm-reset", { token, password: NEW_PASSWORD });
    assert.equal(response.status, 204, "the reset itself must have succeeded");
    yield* setActor(name, { ...actor, password: NEW_PASSWORD });
  });

  Then("session {string} is no longer valid", function* (sessionName: string) {
    assert.equal(yield* sessionIsLive(yield* getSessionCookie(sessionName)), false);
  });

  // ---- REQ-EA-319/320/321: verification token replay ----

  Given("a verification token that has already been consumed", function* () {
    const email = "replay-token@example.com";
    yield* signUpActor("replay", email, STRONG_PASSWORD);
    yield* letForkedFibersRun;
    const verifyMail = (yield* sentMail()).findLast(
      (m) => m.template === "verify-email" && m.to === email,
    );
    assert.ok(verifyMail !== undefined, "expected a verify-email mail");
    const token = mailedToken(verifyMail);
    const firstUse = yield* request("/verify-email", { token });
    assert.equal(firstUse.status, 204, "expected the token's first use to succeed");
    yield* setNote("verificationToken", token);
  });

  When('the same token is presented to "verification.confirm" again', function* () {
    const token = yield* getNote("verificationToken");
    // AH-009: what the replay must NOT change is captured first.
    yield* settle;
    const { eventTags } = yield* World;
    yield* Ref.set(
      eventTags,
      (yield* publishedEvents()).map((event) => event._tag),
    );
    yield* setNote("verifiedBefore", String(yield* emailIsVerified("replay-token@example.com")));
    const response = yield* request("/verify-email", { token });
    yield* setLastResponse("replay", response);
    yield* settle;
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
    const { eventTags } = yield* World;
    const before = yield* Ref.get(eventTags);
    const added = (yield* publishedEvents()).slice(before.length).map((event) => event._tag);
    // The replay is observable as exactly one replay signal — no second verification, no other
    // side effect event — and the user's verified state is what it was.
    assert.deepEqual(added, ["auth.token.replay"]);
    assert.equal(
      String(yield* emailIsVerified("replay-token@example.com")),
      yield* getNote("verifiedBefore"),
    );
  });

  Then(
    'the caller receives the "410 TokenConsumed" failure rather than an apparent success',
    function* () {
      const response = yield* getLastResponse("replay");
      assert.equal(response.status, 410);
    },
  );

  // ---- REQ-EA-322/323/324 and the CSD-009 outline: breach-check fail-open/closed ----

  // AH-007: a named parameter type resolves each config literal exactly; an unknown literal fails
  // the step instead of configuring a default.
  Given(
    "{passwordConfig} with no {string} override",
    function* (options: PasswordConfigOptions, knob: string) {
      // The literal really does leave the knob unset (`breachCheck: true`, no `onUnavailable`).
      assert.equal(knob, "onUnavailable", `no other override is named by this feature ("${knob}")`);
      assert.equal(typeof options.breachCheck, "boolean", "the config must not set onUnavailable");
      yield* configureApp({ passwordConfig: options });
    },
  );

  Given("{passwordConfig}", function* (options: PasswordConfigOptions) {
    yield* configureApp({ passwordConfig: options });
  });

  Given("the breach-database provider is unreachable", function* () {
    // Deliberately no config override here — the preceding Given already set the breachCheck
    // policy (default `allow`, REQ-EA-322; or `{ onUnavailable: "reject" }`, REQ-EA-323);
    // `configureApp`'s merge preserves it, this step only adds the failing transport on top.
    yield* configureApp({ breachHttpClient: unreachableHttpClient });
  });

  Given(
    "the breach-database provider fails by {breachFailure}",
    function* (failure: BreachFailure) {
      yield* arrangeBreachFailure(failure);
    },
  );

  When("a user signs up with a password", function* () {
    yield* signUpActor("breach", "breach-check@example.com", STRONG_PASSWORD);
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
      const { breachFailures } = yield* World;
      yield* Ref.set(breachFailures, ["timeout", "5xx", "malformed"]);
    },
  );

  When("a user signs up with a password in each case", function* () {
    const { breachFailures } = yield* World;
    for (const failure of yield* Ref.get(breachFailures)) {
      yield* arrangeBreachFailure(failure);
      yield* setLastResponse(
        `breach:${failure}`,
        (yield* signUpActor(failure, `breach-${failure}@example.com`, STRONG_PASSWORD)).response,
      );
    }
  });

  Then(
    'sign-up proceeds in all three cases, each treated as "unavailable" rather than handled inconsistently by cause',
    function* () {
      const { breachFailures } = yield* World;
      const failures = yield* Ref.get(breachFailures);
      assert.equal(failures.length, 3);
      for (const failure of failures) {
        assert.equal((yield* getLastResponse(`breach:${failure}`)).status, 200, failure);
      }
    },
  );

  // ---- REQ-EA-325/327: Password.config ----

  Given('an application composing the single "Password" plugin', function* () {
    yield* configureApp({});
  });

  When("it provides {passwordConfig}", function* (options: PasswordConfigOptions) {
    yield* configureApp({ passwordConfig: options });
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
    // The breached-corpus transport is part of *this* step's arrangement, layered over the
    // config the Given set (AH-007: no config Given picks an HTTP client any more).
    yield* configureApp({ breachHttpClient: breachedPasswordHttpClient("hunter2hunter2") });
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
    const body = yield* Effect.promise(() => response.json());
    assert.ok(typeof body === "object" && body !== null && "hints" in body);
    assert.ok(Array.isArray(body.hints) && body.hints.includes("appears in known breaches"));
  });
});
