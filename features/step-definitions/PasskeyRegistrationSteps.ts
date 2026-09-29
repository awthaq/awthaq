// P20a follow-up: 05-authentication-methods/17-passkey.feature, BEH-EA-255 (registration needs a
// fresh session), BEH-EA-256 (Conditional Create is its own, config-gated ceremony) and
// BEH-EA-257 (one stable, random WebAuthn user handle per user).
//
// Everything runs through the World's real wire seam (`PasskeyWorld.ts`): the mocked `WebAuthn`
// port decides only what a browser/authenticator would, while the freshness gate, the ceremony
// scopes and the handle are the plugin's own. Freshness is driven on the real clock (the web
// handler always is): a scenario names a sub-second window and lets the session outlive it.
import { defineSteps } from "@effect-cucumber/vitest";
import { Erasure, Sessions, Users } from "@awthaq/core";
import { PasskeyUserHandles } from "@awthaq/passkey";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  buildClientDataJSON,
  configureApp,
  getOutcome,
  inApp,
  ORIGIN,
  request,
  setOutcome,
  signIn,
  storedCredentials,
  verifyRegistrationCalls,
  World,
} from "./PasskeyWorld.ts";
import * as Ref from "effect/Ref";

// ---- the shapes this suite reads off the wire, decoded rather than asserted ----------------------

const CreationOptions = Schema.Struct({
  challenge: Schema.String,
  user: Schema.Struct({ id: Schema.String }),
  authenticatorSelection: Schema.optional(
    Schema.Struct({
      residentKey: Schema.optional(Schema.String),
      userVerification: Schema.optional(Schema.String),
    }),
  ),
});

const ErrorBody = Schema.Struct({
  _tag: Schema.String,
  maxAgeSeconds: Schema.optional(Schema.Number),
});

const AssertionOptions = Schema.Struct({
  ceremonyId: Schema.String,
  options: Schema.Struct({ challenge: Schema.String }),
});

const jsonBody = (response: Response) => Effect.promise(() => response.clone().json());

const decodedBody = <A, I>(schema: Schema.Codec<A, I>, response: Response) =>
  Effect.gen(function* () {
    const decoded = Schema.decodeUnknownOption(schema)(yield* jsonBody(response));
    assert.ok(Option.isSome(decoded), "the answer has the shape this scenario reads");
    return decoded.value;
  });

const sleep = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

// ---- the acting session -------------------------------------------------------------------------

interface Actor {
  readonly email: string;
  readonly cookie: string;
}

const actor = Effect.fn("features.passkeyRegistration.actor")(function* () {
  const found = yield* getOutcome("actor");
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ email: Schema.String, cookie: Schema.String }),
  )(found);
  assert.ok(Option.isSome(decoded), "a user has been set up");
  const value: Actor = decoded.value;
  return value;
});

const windowMillis = Effect.fn("features.passkeyRegistration.windowMillis")(function* () {
  const { appOptions } = yield* World;
  const options = yield* Ref.get(appOptions);
  assert.ok(
    options.reauthMaxAgeMillis !== undefined,
    "the scenario named a reauthentication window",
  );
  return options.reauthMaxAgeMillis;
});

const userIdOf = (email: string) =>
  inApp(
    Effect.gen(function* () {
      const found = yield* (yield* Users.Users).findByEmail(email);
      assert.ok(Option.isSome(found), `${email} exists`);
      return found.value.id;
    }),
  );

const credentialBody = (credentialId: string, challenge: string, ceremony?: "conditional") => ({
  ...(ceremony === undefined ? {} : { ceremony }),
  credential: {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: buildClientDataJSON({ type: "webauthn.create", challenge, origin: ORIGIN }),
      attestationObject: "",
    },
  },
});

const setActor = (email: string, cookie: string) => setOutcome("actor", { email, cookie });

const post = Effect.fn("features.passkeyRegistration.post")(function* (
  path: string,
  body: unknown,
) {
  const { cookie } = yield* actor();
  const response = yield* request("POST", path, { body, headers: { cookie } });
  yield* setOutcome("answer", response);
  return response;
});

const lastAnswer = Effect.fn("features.passkeyRegistration.lastAnswer")(function* () {
  const found = yield* getOutcome("answer");
  assert.ok(found instanceof Response);
  return found;
});

const optionsOf = Effect.fn("features.passkeyRegistration.optionsOf")(function* (path: string) {
  const response = yield* post(path, {});
  assert.equal(response.status, 200);
  return yield* decodedBody(CreationOptions, response);
});

const rememberChallenge = (kind: "ordinary" | "conditional", challenge: string) =>
  setOutcome(`challenge:${kind}`, challenge);

const challengeOf = Effect.fn("features.passkeyRegistration.challengeOf")(function* (
  kind: "ordinary" | "conditional",
) {
  const found = yield* getOutcome(`challenge:${kind}`);
  assert.equal(typeof found, "string");
  return String(found);
});

export const passkeyRegistrationSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- users and windows ------------------------------------------------------------------------

  Given(
    "a deployment with a {int} millisecond passkey reauthentication window",
    function* (millis: number) {
      yield* configureApp({ reauthMaxAgeMillis: millis });
    },
  );

  Given(
    "a user {string} whose session is inside the passkey reauthentication window",
    function* (email: string) {
      yield* setActor(email, yield* signIn(email));
    },
  );

  Given("a user {string} whose session has outlived that window", function* (email: string) {
    yield* setActor(email, yield* signIn(email));
    yield* sleep((yield* windowMillis()) + 150);
  });

  Given("that session has been revoked", function* () {
    const { email, cookie } = yield* actor();
    const token = decodeURIComponent(cookie.replace(/^__Host-session=/, ""));
    yield* inApp(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.verify(Redacted.make(token));
        yield* sessions.revoke(session.id, "signOut");
      }),
    );
    assert.ok(email.length > 0);
  });

  Given("a deployment with Conditional Create switched off", function* () {
    yield* configureApp({ conditionalCreate: false });
  });

  Given("a deployment that requires user verification", function* () {
    yield* configureApp({ authenticatorSelection: { userVerification: "required" } });
  });

  Given("a deployment composed against the real {string} port", function* (port: string) {
    assert.equal(port, "WebAuthn.layerSimpleWebAuthn");
    yield* configureApp({ webAuthnPort: "simplewebauthn" });
  });

  // ---- options and ceremonies ---------------------------------------------------------------------

  When("the session requests registration options", function* () {
    yield* post("/passkey/register/options", {});
  });

  When("the session requests Conditional Create options", function* () {
    yield* post("/passkey/register/options/conditional", {});
  });

  Given("the session obtained registration options while fresh", function* () {
    yield* rememberChallenge("ordinary", (yield* optionsOf("/passkey/register/options")).challenge);
  });

  Given("the session obtained Conditional Create options", function* () {
    yield* rememberChallenge(
      "conditional",
      (yield* optionsOf("/passkey/register/options/conditional")).challenge,
    );
  });

  When(
    "the session has outlived that window and presents the completed registration",
    function* () {
      yield* sleep((yield* windowMillis()) + 150);
      yield* post(
        "/passkey/register/verify",
        credentialBody("cred-late", yield* challengeOf("ordinary")),
      );
    },
  );

  When("the session presents that challenge as an ordinary registration", function* () {
    yield* post(
      "/passkey/register/verify",
      credentialBody("cred-cross-1", yield* challengeOf("conditional")),
    );
  });

  When("the session presents that challenge as a Conditional Create registration", function* () {
    yield* post(
      "/passkey/register/verify",
      credentialBody("cred-cross-2", yield* challengeOf("ordinary"), "conditional"),
    );
  });

  When(
    "the session completes the ordinary registration and then the Conditional Create registration",
    function* () {
      const ordinary = yield* post(
        "/passkey/register/verify",
        credentialBody("cred-ordinary", yield* challengeOf("ordinary")),
      );
      const conditional = yield* post(
        "/passkey/register/verify",
        credentialBody("cred-conditional", yield* challengeOf("conditional"), "conditional"),
      );
      yield* setOutcome("ordinaryStatus", ordinary.status);
      yield* setOutcome("conditionalStatus", conditional.status);
    },
  );

  // ---- BEH-EA-255 / 256 outcomes -----------------------------------------------------------------

  Then("the options are issued", function* () {
    const response = yield* lastAnswer();
    assert.equal(response.status, 200);
    const options = yield* decodedBody(CreationOptions, response);
    assert.ok(options.challenge.length > 0);
  });

  Then(
    "the request fails with {string} naming a window of {int} milliseconds",
    function* (tag: string, millis: number) {
      const response = yield* lastAnswer();
      assert.equal(response.status, 403);
      const body = yield* decodedBody(ErrorBody, response);
      assert.equal(body._tag, tag);
      assert.equal(body.maxAgeSeconds, millis / 1000);
    },
  );

  Then("the request fails with {string}", function* (tag: string) {
    const response = yield* lastAnswer();
    assert.notEqual(response.status, 200);
    assert.equal((yield* decodedBody(ErrorBody, response))._tag, tag);
  });

  Then("no credential is stored for {string}", function* (email: string) {
    assert.deepEqual(yield* storedCredentials(email), []);
  });

  Then("the request is refused as unauthenticated and no options are issued", function* () {
    const response = yield* lastAnswer();
    assert.equal(response.status, 401);
    const body = yield* decodedBody(ErrorBody, response);
    assert.equal(body._tag, "Unauthenticated");
  });

  Then("the options require a resident key and discourage user verification", function* () {
    const options = yield* decodedBody(CreationOptions, yield* lastAnswer());
    assert.equal(options.authenticatorSelection?.residentKey, "required");
    assert.equal(options.authenticatorSelection?.userVerification, "discouraged");
  });

  Then("both registrations succeed and {string} holds two credentials", function* (email: string) {
    assert.equal(yield* getOutcome("ordinaryStatus"), 200);
    assert.equal(yield* getOutcome("conditionalStatus"), 200);
    assert.equal((yield* storedCredentials(email)).length, 2);
  });

  Then(
    "the ordinary registration required user presence and the Conditional Create one did not",
    function* () {
      const calls = yield* verifyRegistrationCalls();
      assert.deepEqual(
        calls.map((call) => call.requireUserPresence),
        [true, false],
      );
    },
  );

  // ---- BEH-EA-257: the user handle ----------------------------------------------------------------

  When("the session requests registration options twice", function* () {
    const first = yield* optionsOf("/passkey/register/options");
    const second = yield* optionsOf("/passkey/register/options");
    yield* setOutcome("handles", [first.user.id, second.user.id]);
  });

  Then("both creation options carry the same {string}", function* (_field: string) {
    const handles = yield* getOutcome("handles");
    assert.ok(Array.isArray(handles) && handles.length === 2);
    assert.equal(handles[0], handles[1]);
  });

  Then(
    "the {string} is 32 random bytes that contain neither the user's id nor the user's address",
    function* (_field: string) {
      const { email } = yield* actor();
      const options = yield* decodedBody(CreationOptions, yield* lastAnswer());
      const decoded = Encoding.decodeBase64Url(options.user.id);
      assert.ok(decoded._tag === "Success", "the handle is base64url");
      assert.equal(decoded.success.length, 32);
      const userId = yield* userIdOf(email);
      assert.ok(!options.user.id.includes(userId));
      assert.ok(!Buffer.from(decoded.success).toString("utf8").includes(email));
      yield* setOutcome("handleA", options.user.id);
    },
  );

  Then(
    "a second user {string} is given a different {string}",
    function* (email: string, _field: string) {
      yield* setActor(email, yield* signIn(email));
      const options = yield* optionsOf("/passkey/register/options");
      assert.notEqual(options.user.id, yield* getOutcome("handleA"));
    },
  );

  const registerTwo = Effect.fn("features.passkeyRegistration.registerTwo")(function* () {
    const handles: Array<string> = [];
    for (const credentialId of ["cred-handle-1", "cred-handle-2"]) {
      const options = yield* optionsOf("/passkey/register/options");
      handles.push(options.user.id);
      const verified = yield* post(
        "/passkey/register/verify",
        credentialBody(credentialId, options.challenge),
      );
      assert.equal(verified.status, 200);
    }
    return handles;
  });

  When("the session registers two credentials", function* () {
    yield* setOutcome("handles", yield* registerTwo());
  });

  Then(
    "both credentials are stored under the {string} the options carried",
    function* (_field: string) {
      const { email } = yield* actor();
      const handles = yield* getOutcome("handles");
      assert.ok(Array.isArray(handles) && handles.length === 2);
      assert.equal(handles[0], handles[1], "one handle for every ceremony");
      const stored = yield* storedCredentials(email);
      assert.equal(stored.length, 2);
      for (const credential of stored) assert.equal(credential.webauthnUserId, handles[0]);
    },
  );

  Given("a user {string} who has registered a credential", function* (email: string) {
    yield* setActor(email, yield* signIn(email));
    const options = yield* optionsOf("/passkey/register/options");
    const verified = yield* post(
      "/passkey/register/verify",
      credentialBody("cred-asserting", options.challenge),
    );
    assert.equal(verified.status, 200);
    yield* setOutcome("handles", [options.user.id]);
  });

  const assertWith = Effect.fn("features.passkeyRegistration.assertWith")(function* (
    userHandle: string,
  ) {
    const { email } = yield* actor();
    const optionsResponse = yield* request("POST", "/passkey/authenticate/options", {
      body: { email },
    });
    const { ceremonyId, options } = yield* decodedBody(AssertionOptions, optionsResponse);
    const response = yield* request("POST", "/passkey/authenticate/verify", {
      body: {
        ceremonyId,
        credential: {
          id: "cred-asserting",
          rawId: "cred-asserting",
          type: "public-key",
          response: {
            clientDataJSON: buildClientDataJSON({
              type: "webauthn.get",
              challenge: options.challenge,
              origin: ORIGIN,
            }),
            authenticatorData: "",
            signature: "",
            userHandle,
          },
        },
      },
    });
    yield* setOutcome("answer", response);
  });

  When(
    "that credential asserts with a {string} that is not the one stored with it",
    function* (_field: string) {
      yield* assertWith("bm90LXRoZS1zdG9yZWQtaGFuZGxl");
    },
  );

  When("that credential asserts with the {string} stored with it", function* (_field: string) {
    const handles = yield* getOutcome("handles");
    assert.ok(Array.isArray(handles) && typeof handles[0] === "string");
    yield* assertWith(handles[0]);
  });

  Then("the assertion fails with {string}", function* (tag: string) {
    const response = yield* lastAnswer();
    assert.notEqual(response.status, 200);
    assert.equal((yield* decodedBody(ErrorBody, response))._tag, tag);
  });

  Then("the assertion succeeds", function* () {
    assert.equal((yield* lastAnswer()).status, 200);
  });

  When("the plugin's erasure contribution runs for that user", function* () {
    const { email } = yield* actor();
    const userId = yield* userIdOf(email);
    const handles = yield* getOutcome("handles");
    assert.ok(Array.isArray(handles) && typeof handles[0] === "string");
    yield* inApp(
      Effect.gen(function* () {
        const registry = yield* Erasure.ErasureRegistry;
        const contributions = yield* registry.contributions;
        const passkey = contributions.find((contribution) => contribution.id === "passkey");
        assert.ok(passkey !== undefined, "the passkey plugin contributes an erasure");
        yield* passkey.erase({ userId, email });
      }),
    );
  });

  Then("no credential remains for {string}", function* (email: string) {
    assert.deepEqual(yield* storedCredentials(email), []);
  });

  Then("the next {string} minted for that user is a different value", function* (_field: string) {
    const { email } = yield* actor();
    const userId = yield* userIdOf(email);
    const before = yield* getOutcome("handles");
    assert.ok(Array.isArray(before));
    const after = yield* inApp(
      Effect.flatMap(PasskeyUserHandles.PasskeyUserHandles, (handles) =>
        handles.getOrCreate(userId),
      ),
    );
    assert.notEqual(after, before[0]);
  });
});
