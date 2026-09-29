import { defineSteps, ParameterTypeStore } from "@effect-cucumber/vitest";
import { ChallengeStore, PasskeyApi } from "@awthaq/passkey";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  buildClientDataJSON,
  configureApp,
  extractChallenge,
  getLastResponse,
  getOutcome,
  inspectSession,
  linkOtherAccount,
  ORIGIN,
  overrideWebAuthnBehavior,
  request,
  RP_ID,
  setOutcome,
  signIn,
  storedCredentials,
  World,
} from "./PasskeyWorld.ts";
import { cookieFrom } from "./shared/Harness.ts";

const registerCredential = Effect.fn("features.passkey.registerCredential")(function* (
  cookie: string,
  credentialId = "cred-mock-1",
) {
  const optionsResponse = yield* request("POST", "/passkey/register/options", {
    body: {},
    headers: { cookie },
  });
  const challenge = extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
  return yield* request("POST", "/passkey/register/verify", {
    body: {
      credential: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: buildClientDataJSON({
            type: "webauthn.create",
            challenge,
            origin: ORIGIN,
          }),
          attestationObject: "",
        },
      },
    },
    headers: { cookie },
  });
});

/** Asks `register/options` for a fresh ceremony, returning its challenge. */
const issueChallenge = Effect.fn("features.passkey.issueChallenge")(function* (cookie: string) {
  const optionsResponse = yield* request("POST", "/passkey/register/options", {
    body: {},
    headers: { cookie },
  });
  return extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
});

/** Presents a registration credential for exactly `challenge` — the same wire call `registerCredential` makes, for a challenge the caller chose. */
const verifyChallenge = Effect.fn("features.passkey.verifyChallenge")(function* (
  cookie: string,
  challenge: string,
  credentialId = "cred-mock-1",
) {
  return yield* request("POST", "/passkey/register/verify", {
    body: {
      credential: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: buildClientDataJSON({
            type: "webauthn.create",
            challenge,
            origin: ORIGIN,
          }),
          attestationObject: "",
        },
      },
    },
    headers: { cookie },
  });
});

const bodyTag = Effect.fn("features.passkey.bodyTag")(function* (response: Response) {
  const body = (yield* Effect.promise(() => response.clone().json())) as { readonly _tag?: string };
  return body._tag;
});

/** A rejected ceremony: not a 200, and precisely this typed error. */
const assertRejectedWith = Effect.fn("features.passkey.assertRejectedWith")(function* (
  response: Response,
  tag: string,
) {
  assert.notStrictEqual(response.status, 200);
  assert.strictEqual(yield* bodyTag(response), tag);
});

const authenticate = Effect.fn("features.passkey.authenticate")(function* (
  credentialId = "cred-mock-1",
) {
  const optionsResponse = yield* request("POST", "/passkey/authenticate/options", { body: {} });
  const { ceremonyId, options } = (yield* Effect.promise(() => optionsResponse.json())) as {
    ceremonyId: string;
    options: unknown;
  };
  const challenge = extractChallenge(options);
  return yield* request("POST", "/passkey/authenticate/verify", {
    body: {
      ceremonyId,
      credential: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: buildClientDataJSON({ type: "webauthn.get", challenge, origin: ORIGIN }),
          authenticatorData: "",
          signature: "",
        },
      },
    },
  });
});

/** What a `passkeyConfig` literal in the feature text stands for. */
export interface PasskeyConfigChoice {
  readonly rpId: string;
  readonly origins: ReadonlyArray<string>;
}

// The literal as it reads in 17-passkey.feature: `"passkey({ rpId: \"example.com\", origins: [\"https://example.com\", ...] })"`.
const PASSKEY_CONFIG =
  /^"passkey\(\{ rpId: \\"([^"\\]+)\\", origins: \[((?:\\"[^"\\]+\\"(?:, )?)+)\] \}\)"$/;

export const passkeyParameterTypes = ParameterTypeStore.layer([
  {
    name: "passkeyConfig",
    regexp: /"passkey\(\{ rpId: \\"[^"\\]+\\", origins: \[(?:\\"[^"\\]+\\"(?:, )?)+\] \}\)"/,
    transform: (literal: string): PasskeyConfigChoice => {
      const match = PASSKEY_CONFIG.exec(literal);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new Error(`unrecognised passkey config literal: ${literal}`);
      }
      return {
        rpId: match[1],
        origins: [...match[2].matchAll(/\\"([^"\\]+)\\"/g)].map((origin) => origin[1] ?? ""),
      };
    },
    definedAt: Option.some("PasskeySteps.ts"),
    useForSnippets: Option.none(),
    preferForRegexpMatch: Option.none(),
  },
]).pipe(Layer.orDie);

export const passkeySteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-129: WebAuthn is a port (355-357) ----
  //
  // The whole suite runs Passkey against a mocked `WebAuthn` port; these scenarios swap that one
  // layer — the real `WebAuthn.layerSimpleWebAuthn` and the mock — under an otherwise identical
  // composition, and observe what Passkey itself does and does not do.

  interface PortOptions {
    readonly cookie: string;
    readonly status: number;
    readonly options: {
      readonly challenge: string;
      readonly rp: { readonly id: string };
      readonly pubKeyCredParams: ReadonlyArray<unknown>;
    };
  }

  const registrationOptionsUnder = Effect.fn(function* (port: "mock" | "simplewebauthn") {
    yield* configureApp({ webAuthnPort: port });
    const cookie = yield* signIn(`port-${port}-${Date.now()}@example.com`);
    const response = yield* request("POST", "/passkey/register/options", {
      body: {},
      headers: { cookie },
    });
    const options = (yield* Effect.promise(() => response.json())) as PortOptions["options"];
    return { cookie, status: response.status, options };
  });

  Given(
    "an application composing {string}",
    Effect.fn(function* (_plugin: string) {
      yield* configureApp({});
    }),
  );

  When(
    'the application provides "WebAuthn.layerSimpleWebAuthn"',
    Effect.fn(function* () {
      yield* setOutcome("realPortOptions", yield* registrationOptionsUnder("simplewebauthn"));
    }),
  );

  Then(
    "{string} performs its ceremonies using the provided {string} port",
    Effect.fn(function* (_plugin: string, _port: string) {
      const { status, options } = (yield* getOutcome("realPortOptions")) as PortOptions;
      assert.strictEqual(status, 200);
      // Options only the real SimpleWebAuthn implementation produces (the mock returns an empty
      // `pubKeyCredParams`): the port behind the ceremony is the one the application provided.
      assert.ok(options.pubKeyCredParams.length > 0);
      assert.strictEqual(options.rp.id, RP_ID);
    }),
  );

  Given(
    "a registration or authentication ceremony being verified",
    Effect.fn(function* () {
      // A credential whose attestation object is not even CBOR, and an assertion with an empty
      // signature: input any parser or signature check would refuse.
      yield* setOutcome("ceremonyInput", { attestationObject: "", signature: "" });
    }),
  );

  When(
    '"Passkey" processes the ceremony',
    Effect.fn(function* () {
      // Under the real port: the malformed attestation is refused.
      const real = yield* registrationOptionsUnder("simplewebauthn");
      const refused = yield* verifyChallenge(real.cookie, real.options.challenge);
      yield* setOutcome("realPortRegistration", refused);
      // Under the mock port (whose verification always succeeds): the very same inputs go through,
      // for registration and for authentication alike.
      const mocked = yield* registrationOptionsUnder("mock");
      yield* setOutcome(
        "mockPortRegistration",
        yield* verifyChallenge(mocked.cookie, mocked.options.challenge),
      );
      yield* setOutcome("mockPortAuthentication", yield* authenticate());
    }),
  );

  Then(
    "the CBOR\\/COSE parsing, attestation verification, and signature checking are all performed by the {string} port",
    Effect.fn(function* (_port: string) {
      // The real port is what rejected the malformed attestation, surfaced as its typed failure.
      yield* assertRejectedWith(
        (yield* getOutcome("realPortRegistration")) as Response,
        "PasskeyVerificationFailed",
      );
    }),
  );

  Then(
    "{string}'s own code performs none of that parsing or verification itself",
    Effect.fn(function* (_plugin: string) {
      // With the port's verdict swapped, the same malformed attestation and the same empty
      // signature are accepted: nothing in Passkey itself looked at them.
      assert.strictEqual(((yield* getOutcome("mockPortRegistration")) as Response).status, 200);
      assert.strictEqual(((yield* getOutcome("mockPortAuthentication")) as Response).status, 200);
    }),
  );

  Given(
    "an application composing {string} against {string}",
    Effect.fn(function* (_plugin: string, _port: string) {
      const real = yield* registrationOptionsUnder("simplewebauthn");
      assert.strictEqual(real.status, 200);
      yield* setOutcome("realPortStatus", real.status);
    }),
  );

  When(
    'the application instead provides a different "WebAuthn" port implementation',
    Effect.fn(function* () {
      // Only the layer changes: `configureApp` rebuilds the same composition with `mockWebAuthn`.
      const swapped = yield* registrationOptionsUnder("mock");
      yield* setOutcome("swappedOptions", swapped);
      yield* setOutcome(
        "swappedRegistration",
        yield* verifyChallenge(swapped.cookie, swapped.options.challenge),
      );
      yield* setOutcome("swappedAuthentication", yield* authenticate());
    }),
  );

  Then(
    '"Passkey" continues to function unchanged, calling only the "WebAuthn" port\'s interface',
    Effect.fn(function* () {
      // The mock implements exactly the port's interface (`Layer.mock` dies on anything else), and
      // the full register-then-authenticate flow still works over it.
      assert.strictEqual(((yield* getOutcome("swappedOptions")) as { status: number }).status, 200);
      assert.strictEqual(((yield* getOutcome("swappedRegistration")) as Response).status, 200);
      assert.strictEqual(((yield* getOutcome("swappedAuthentication")) as Response).status, 200);
    }),
  );

  // ---- BEH-EA-130: Registration ceremony (358-360) ----

  Given(
    "a registration ceremony's challenge issued by {string}",
    Effect.fn(function* (_endpoint: string) {
      yield* configureApp({});
      const cookie = yield* signIn("register-358@example.com");
      yield* setOutcome("cookie", cookie);
      yield* setOutcome("email", "register-358@example.com");
    }),
  );

  When(
    "the browser's credential is submitted to {string} and {string} succeeds against that same challenge",
    Effect.fn(function* (_endpoint: string, _port: string) {
      const cookie = (yield* getOutcome("cookie")) as string;
      yield* registerCredential(cookie);
    }),
  );

  Then(
    "the credential's public key, counter, device type, backup-state flag, transports, and AAGUID are all persisted",
    Effect.fn(function* () {
      const response = yield* getLastResponse();
      const body = (yield* Effect.promise(() => response.json())) as { id: string };
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.id, "cred-mock-1");
      // Every field below is what the (mocked) port verified and returned — read from the store.
      const [stored, ...rest] = yield* storedCredentials((yield* getOutcome("email")) as string);
      assert.strictEqual(rest.length, 0);
      assert.ok(stored !== undefined);
      assert.strictEqual(stored.id, "cred-mock-1");
      assert.deepStrictEqual([...stored.publicKey], [1, 2, 3]);
      assert.strictEqual(stored.counter, 0);
      assert.strictEqual(stored.deviceType, "singleDevice");
      assert.strictEqual(stored.backedUp, false);
      assert.deepStrictEqual(stored.transports, []);
      assert.strictEqual(stored.aaguid, "00000000-0000-0000-0000-000000000000");
    }),
  );

  Given(
    "a registration ceremony in which the client's own request claims a successful attestation",
    Effect.fn(function* () {
      yield* configureApp({ webAuthn: { failVerifyRegistration: true } });
      const cookie = yield* signIn("claims-success@example.com");
      yield* setOutcome("cookie", cookie);
      yield* setOutcome("email", "claims-success@example.com");
    }),
  );

  When(
    '"registerVerify" is called and "WebAuthn.verifyRegistration" itself does not succeed against the ceremony\'s challenge',
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      yield* registerCredential(cookie);
    }),
  );

  Then(
    "persistence does not occur, regardless of what the client's request claims",
    Effect.fn(function* () {
      const response = yield* getLastResponse();
      yield* assertRejectedWith(response, "PasskeyVerificationFailed");
      assert.deepStrictEqual(yield* storedCredentials((yield* getOutcome("email")) as string), []);
    }),
  );

  When(
    "the browser's credential is submitted to {string} and {string} fails",
    Effect.fn(function* (_endpoint: string, _port: string) {
      const cookie = (yield* getOutcome("cookie")) as string;
      yield* overrideWebAuthnBehavior({ failVerifyRegistration: true });
      const response = yield* registerCredential(cookie);
      yield* setOutcome("registerVerifyResponse", response);
    }),
  );

  Then(
    "no credential record is persisted",
    Effect.fn(function* () {
      const response = (yield* getOutcome("registerVerifyResponse")) as Response;
      yield* assertRejectedWith(response, "PasskeyVerificationFailed");
      assert.deepStrictEqual(yield* storedCredentials((yield* getOutcome("email")) as string), []);
    }),
  );

  // ---- BEH-EA-131: Authentication ceremony issues a session (361-363) ----

  Given(
    'an authentication assertion that "WebAuthn.verifyAuthentication" verifies successfully',
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("auth-361@example.com");
      yield* registerCredential(cookie);
    }),
  );

  When(
    '"authenticateVerify" handles the assertion',
    Effect.fn(function* () {
      const response = yield* authenticate();
      yield* setOutcome("authenticateResponse", response);
    }),
  );

  Then(
    'a session is issued through the same core "Sessions" capability every sign-in method uses',
    Effect.fn(function* () {
      const response = (yield* getOutcome("authenticateResponse")) as Response;
      if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
      cookieFrom(response);
    }),
  );

  Given(
    "a successfully verified authentication assertion",
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("auth-362@example.com");
      yield* registerCredential(cookie);
    }),
  );

  When(
    '"authenticateVerify" returns its "SessionView"',
    Effect.fn(function* () {
      const response = yield* authenticate();
      yield* setOutcome("authenticateResponse", response);
    }),
  );

  Then(
    'the session is delivered through the shared "SessionDelivery" helper as the "__Host-session" cookie',
    Effect.fn(function* () {
      const response = (yield* getOutcome("authenticateResponse")) as Response;
      const cookie = cookieFrom(response);
      if (!cookie.startsWith("__Host-session=")) {
        throw new Error(`expected a __Host-session cookie, got ${cookie}`);
      }
    }),
  );

  Given(
    "a session issued via a verified passkey authentication",
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("auth-363@example.com");
      yield* registerCredential(cookie);
      const response = yield* authenticate();
      yield* setOutcome("passkeySession", cookieFrom(response));
    }),
  );

  // A password (or OAuth) sign-in mints its session with `Sessions.issue` and no method-specific
  // options; `signIn` does exactly that. Both are read back and their windows compared.
  const windowsOf = (session: {
    readonly createdAt: { readonly epochMilliseconds: number };
    readonly idleExpiresAt: { readonly epochMilliseconds: number };
    readonly absoluteExpiresAt: { readonly epochMilliseconds: number };
  }) => ({
    idle: session.idleExpiresAt.epochMilliseconds - session.createdAt.epochMilliseconds,
    absolute: session.absoluteExpiresAt.epochMilliseconds - session.createdAt.epochMilliseconds,
  });

  When(
    "that session's idle expiry, absolute expiry, and sliding refresh are compared against a session issued via password sign-in",
    Effect.fn(function* () {
      const passkeyCookie = (yield* getOutcome("passkeySession")) as string;
      const passwordCookie = yield* signIn("auth-363-password@example.com");
      const passkeySession = yield* inspectSession(passkeyCookie);
      const passwordSession = yield* inspectSession(passwordCookie);
      yield* setOutcome("passkeyWindows", windowsOf(passkeySession));
      yield* setOutcome("passwordWindows", windowsOf(passwordSession));
      yield* setOutcome("passkeyActingAs", passkeySession.actingAs);
    }),
  );

  Then(
    "both sessions follow the same expiry and refresh rules, uniformly across authentication methods",
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("passkeySession")) as string;
      assert.ok(cookie.startsWith("__Host-session="));
      const passkey = (yield* getOutcome("passkeyWindows")) as { idle: number; absolute: number };
      const password = (yield* getOutcome("passwordWindows")) as { idle: number; absolute: number };
      assert.deepStrictEqual(passkey, password);
      assert.ok(passkey.idle > 0 && passkey.absolute >= passkey.idle);
      // A passkey session is an ordinary one: it slides (it is not an `actingAs` episode, which never does).
      assert.ok(Option.isNone((yield* getOutcome("passkeyActingAs")) as Option.Option<unknown>));
    }),
  );

  // ---- BEH-EA-132: Challenges are single-use and short-lived (364-367) ----

  Given(
    "a challenge issued for a ceremony",
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("challenge-364@example.com");
      yield* setOutcome("cookie", cookie);
      yield* setOutcome("challenge", yield* issueChallenge(cookie));
    }),
  );

  When(
    "a verification attempt for that challenge is made, whether it succeeds or fails",
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const challenge = (yield* getOutcome("challenge")) as string;
      const first = yield* verifyChallenge(cookie, challenge);
      yield* setOutcome("firstAttempt", first);
    }),
  );

  Then(
    'the challenge is deleted from the "ChallengeStore" as part of that attempt',
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const challenge = (yield* getOutcome("challenge")) as string;
      assert.strictEqual(((yield* getOutcome("firstAttempt")) as Response).status, 200);
      // The very same challenge, presented again: gone from the store.
      const again = yield* verifyChallenge(cookie, challenge, "cred-mock-2");
      yield* assertRejectedWith(again, "PasskeyChallengeInvalid");
    }),
  );

  Given(
    "a challenge that has already been consumed by a successful verification",
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("consumed-365@example.com");
      const optionsResponse = yield* request("POST", "/passkey/register/options", {
        body: {},
        headers: { cookie },
      });
      const challenge = extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
      const first = yield* request("POST", "/passkey/register/verify", {
        body: {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge,
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        },
        headers: { cookie },
      });
      if (first.status !== 200) throw new Error("expected the first verification to succeed");
      yield* setOutcome("cookie", cookie);
      yield* setOutcome("consumedChallenge", challenge);
    }),
  );

  When(
    "a second verification call presents the same challenge",
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const challenge = (yield* getOutcome("consumedChallenge")) as string;
      const second = yield* request("POST", "/passkey/register/verify", {
        body: {
          credential: {
            id: "cred-mock-2",
            rawId: "cred-mock-2",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge,
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        },
        headers: { cookie },
      });
      yield* setOutcome("secondAttempt", second);
    }),
  );

  Then(
    "the second call fails, since the challenge is no longer in the store",
    Effect.fn(function* () {
      const second = (yield* getOutcome("secondAttempt")) as Response;
      yield* assertRejectedWith(second, "PasskeyChallengeInvalid");
    }),
  );

  Given(
    "a challenge presented in a verification attempt that fails",
    Effect.fn(function* () {
      yield* configureApp({ webAuthn: { failVerifyRegistration: true } });
      const cookie = yield* signIn("failed-366@example.com");
      const optionsResponse = yield* request("POST", "/passkey/register/options", {
        body: {},
        headers: { cookie },
      });
      const challenge = extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
      const first = yield* request("POST", "/passkey/register/verify", {
        body: {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge,
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        },
        headers: { cookie },
      });
      if (first.status === 200) throw new Error("expected the first attempt to fail");
      yield* setOutcome("cookie", cookie);
      yield* setOutcome("failedChallenge", challenge);
    }),
  );

  When(
    "a second verification attempt is made using that same challenge value",
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const challenge = (yield* getOutcome("failedChallenge")) as string;
      const second = yield* request("POST", "/passkey/register/verify", {
        body: {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge,
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        },
        headers: { cookie },
      });
      yield* setOutcome("secondAttempt", second);
    }),
  );

  Then(
    "the second attempt also fails, since the first attempt already deleted the challenge on failure",
    Effect.fn(function* () {
      const second = (yield* getOutcome("secondAttempt")) as Response;
      // The first attempt failed on verification (PasskeyVerificationFailed); the retry finds no challenge at all.
      yield* assertRejectedWith(second, "PasskeyChallengeInvalid");
    }),
  );

  // REQ-EA-367: the five-minute TTL belongs to `ChallengeStore`. The HTTP handler runs on the real
  // clock, outside any step's `TestClock` (see `PasskeyWorld.signIn`), so this scenario exercises the
  // store the plugin is composed with directly, in the step's own fiber where `TestClock` governs it.
  // Wire-level single-use/replay behaviour is REQ-EA-364..366 above.
  const memoryChallenges = ChallengeStore.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

  Given(
    "a challenge issued and never presented for verification",
    Effect.fn(function* () {
      const context = yield* Layer.build(memoryChallenges);
      const store = Context.get(context, ChallengeStore.ChallengeStore);
      const challenge = yield* store.issue("ceremony-367");
      yield* setOutcome("challengeStore", store);
      yield* setOutcome("issuedChallenge", Redacted.value(challenge));
    }),
  );

  When(
    "five minutes elapse, driven by {string}\\/{string}",
    Effect.fn(function* (_clock: string, _testClock: string) {
      yield* TestClock.adjust("5 minutes");
    }),
  );

  Then(
    "the challenge is no longer valid once its TTL has elapsed",
    Effect.fn(function* () {
      const store = (yield* getOutcome("challengeStore")) as ChallengeStore.ChallengeStoreShape;
      const issued = (yield* getOutcome("issuedChallenge")) as string;
      assert.strictEqual(Duration.toMillis(ChallengeStore.CHALLENGE_TTL), 5 * 60 * 1000);
      // The very challenge that was issued, now past its TTL.
      assert.strictEqual(yield* store.consume("ceremony-367", issued), false);
      // Control: a challenge issued just now still consumes, so the refusal above is the TTL's.
      const fresh = Redacted.value(yield* store.issue("ceremony-367"));
      assert.strictEqual(yield* store.consume("ceremony-367", fresh), true);
    }),
  );

  // ---- BEH-EA-133: RP config is exact origin matching (368-371) ----

  // AH-007: the config Givens resolve through the `passkeyConfig` parameter type (registered in the
  // feature's steps.test.ts); anything but the documented shape fails to match.
  Given(
    "{passkeyConfig}",
    Effect.fn(function* (config: PasskeyConfigChoice) {
      yield* configureApp({ rpId: config.rpId, origins: config.origins });
    }),
  );

  const verifyAtOrigin = Effect.fn("features.passkey.verifyAtOrigin")(function* (origin: string) {
    const cookie = yield* signIn(`origin-check-${Date.now()}-${Math.random()}@example.com`);
    const credentialId = `cred-mock-${Date.now()}-${Math.random()}`;
    const optionsResponse = yield* request("POST", "/passkey/register/options", {
      body: {},
      headers: { cookie },
    });
    const challenge = extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
    return yield* request("POST", "/passkey/register/verify", {
      body: {
        credential: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          response: {
            clientDataJSON: buildClientDataJSON({ type: "webauthn.create", challenge, origin }),
            attestationObject: "",
          },
        },
      },
      headers: { cookie },
    });
  });

  When(
    "a ceremony arrives with origin {string}",
    Effect.fn(function* (origin: string) {
      const response = yield* verifyAtOrigin(origin);
      yield* setOutcome("ceremonyResponse", response);
    }),
  );

  Then(
    "the origin check succeeds",
    Effect.fn(function* () {
      const response = (yield* getOutcome("ceremonyResponse")) as Response;
      if (response.status !== 200)
        throw new Error(`expected origin check to succeed, got ${response.status}`);
    }),
  );

  When(
    "a ceremony arrives with origin {string} or with a non-standard port not present in {string}",
    Effect.fn(function* (origin: string, _field: string) {
      const response = yield* verifyAtOrigin(origin);
      yield* setOutcome("ceremonyResponse", response);
    }),
  );

  Then(
    "the origin check fails, even though the host alone matches",
    Effect.fn(function* () {
      const response = (yield* getOutcome("ceremonyResponse")) as Response;
      if (response.status === 200) throw new Error("expected origin check to fail");
    }),
  );

  When(
    'a ceremony\'s origin host is checked against "rpId"',
    Effect.fn(function* () {
      // Hosts that contain (or end like) "example.com" without being it or a subdomain of it.
      const impostors = [
        "https://evil-example.com.attacker.net",
        "https://notexample.com",
        "https://example.com.evil.io",
      ];
      const responses: Array<Response> = [];
      for (const origin of impostors) responses.push(yield* verifyAtOrigin(origin));
      yield* setOutcome("impostorResponses", responses);
      yield* setOutcome("ceremonyResponse", responses[0]);
    }),
  );

  Then(
    '"rpId" is validated as a registrable-domain suffix of that origin',
    Effect.fn(function* () {
      const response = (yield* getOutcome("ceremonyResponse")) as Response;
      yield* assertRejectedWith(response, "PasskeyOriginMismatch");
    }),
  );

  Then(
    "a bare substring or unrelated host match is not accepted in its place",
    Effect.fn(function* () {
      const responses = (yield* getOutcome("impostorResponses")) as ReadonlyArray<Response>;
      assert.strictEqual(responses.length, 3);
      for (const response of responses) {
        yield* assertRejectedWith(response, "PasskeyOriginMismatch");
      }
    }),
  );

  When(
    "ceremonies arrive from {string} and from {string}",
    Effect.fn(function* (originA: string, originB: string) {
      const responseA = yield* verifyAtOrigin(originA);
      const responseB = yield* verifyAtOrigin(originB);
      yield* setOutcome("responseA", responseA);
      yield* setOutcome("responseB", responseB);
      yield* setOutcome(`ceremony:${originA}`, responseA);
      yield* setOutcome(`ceremony:${originB}`, responseB);
    }),
  );

  Then(
    "both are accepted, each matched against its own explicit entry in {string}",
    Effect.fn(function* (_field: string) {
      const responseA = (yield* getOutcome("responseA")) as Response;
      const responseB = (yield* getOutcome("responseB")) as Response;
      if (responseA.status !== 200 || responseB.status !== 200) {
        throw new Error("expected both explicitly-listed origins to be accepted");
      }
    }),
  );

  // rpId suffix validation is independent of the origin allowlist: a *listed* origin whose host is
  // not the rpId or one of its subdomains is still refused.
  Then(
    "the ceremony from {string} is accepted",
    Effect.fn(function* (origin: string) {
      const response = (yield* getOutcome(`ceremony:${origin}`)) as Response;
      assert.strictEqual(response.status, 200);
    }),
  );

  Then(
    "the ceremony from {string} is rejected as an rpId mismatch",
    Effect.fn(function* (origin: string) {
      const response = (yield* getOutcome(`ceremony:${origin}`)) as Response;
      yield* assertRejectedWith(response, "PasskeyRpIdMismatch");
    }),
  );

  // ---- BEH-EA-134: Multi-credential management (372-374) ----

  const signedInWithCredentials = Effect.fn("features.passkey.signedInWithCredentials")(function* (
    credentialCount: number,
  ) {
    yield* configureApp({});
    const email = `alice-${Date.now()}-${Math.random()}@example.com`;
    const cookie = yield* signIn(email);
    const ids: Array<string> = [];
    for (let i = 0; i < credentialCount; i++) {
      const id = `cred-mock-${i}`;
      yield* registerCredential(cookie, id);
      ids.push(id);
    }
    yield* setOutcome("cookie", cookie);
    yield* setOutcome("signInEmail", email);
    yield* setOutcome("credentialIds", ids);
  });

  Given(
    'a signed-in user "alice" with exactly one passkey credential and no other Account',
    Effect.fn(function* () {
      yield* signedInWithCredentials(1);
    }),
  );

  When(
    '"alice" calls "passkey.remove" for that credential\'s id',
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const ids = (yield* getOutcome("credentialIds")) as Array<string>;
      const response = yield* request("DELETE", `/passkey/credentials/${ids[0]}`, {
        headers: { cookie },
      });
      yield* setOutcome("removeResponse", response);
    }),
  );

  Then(
    "the removal is refused",
    Effect.fn(function* () {
      const response = (yield* getOutcome("removeResponse")) as Response;
      if (response.status === 200)
        throw new Error("expected the last-credential removal to be refused");
    }),
  );

  Given(
    'a signed-in user "alice" with two passkey credentials',
    Effect.fn(function* () {
      yield* signedInWithCredentials(2);
    }),
  );

  When(
    '"alice" calls "passkey.remove" for one of them',
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const ids = (yield* getOutcome("credentialIds")) as Array<string>;
      const response = yield* request("DELETE", `/passkey/credentials/${ids[0]}`, {
        headers: { cookie },
      });
      yield* setOutcome("removeResponse", response);
    }),
  );

  Then(
    "the removal succeeds",
    Effect.fn(function* () {
      const response = (yield* getOutcome("removeResponse")) as Response;
      if (response.status !== 200 && response.status !== 204) {
        throw new Error(`expected removal to succeed, got ${response.status}`);
      }
    }),
  );

  Then(
    '"alice" still has one remaining passkey credential',
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const listResponse = yield* request("GET", "/passkey/credentials", { headers: { cookie } });
      const listed = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<unknown>;
      if (listed.length !== 1)
        throw new Error(`expected 1 remaining credential, got ${listed.length}`);
    }),
  );

  Given(
    'a signed-in user "alice" with exactly one passkey credential and one {string}',
    Effect.fn(function* (otherCredential: string) {
      yield* signedInWithCredentials(1);
      const email = (yield* getOutcome("signInEmail")) as string;
      const providerId = otherCredential.includes("OAuth") ? "google" : "password";
      yield* linkOtherAccount(email, providerId);
    }),
  );

  When(
    '"alice" calls "passkey.remove" for her passkey credential\'s id',
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const ids = (yield* getOutcome("credentialIds")) as Array<string>;
      const response = yield* request("DELETE", `/passkey/credentials/${ids[0]}`, {
        headers: { cookie },
      });
      yield* setOutcome("removeResponse", response);
    }),
  );

  Then(
    "the removal succeeds, since {string} would remain",
    Effect.fn(function* (_otherCredential: string) {
      const response = (yield* getOutcome("removeResponse")) as Response;
      if (response.status !== 200 && response.status !== 204) {
        throw new Error(
          `expected removal to succeed since another credential remains, got ${response.status}`,
        );
      }
    }),
  );

  // ---- BEH-EA-135: Attestation defaults to "none" (375-377) ----

  Given(
    '{string} composed with no explicit "attestation" option',
    Effect.fn(function* (_config: string) {
      yield* configureApp({});
    }),
  );

  When(
    "a registration ceremony's options are generated",
    Effect.fn(function* () {
      const cookie = yield* signIn(`attestation-${Date.now()}@example.com`);
      const response = yield* request("POST", "/passkey/register/options", {
        body: {},
        headers: { cookie },
      });
      const options = (yield* Effect.promise(() => response.json())) as { attestation?: string };
      yield* setOutcome("cookie", cookie);
      yield* setOutcome("attestation", options.attestation ?? "none");
    }),
  );

  Then(
    'the requested attestation conveyance is "none"',
    Effect.fn(function* () {
      const attestation = yield* getOutcome("attestation");
      if (attestation !== "none") throw new Error(`expected "none", got ${String(attestation)}`);
    }),
  );

  Given(
    "{string} or {string} explicitly configured",
    Effect.fn(function* (_direct: string, _enterprise: string) {
      yield* configureApp({ attestation: "direct" });
    }),
  );

  Then(
    "the requested attestation conveyance matches the explicitly configured value",
    Effect.fn(function* () {
      const attestation = yield* getOutcome("attestation");
      if (attestation !== "direct")
        throw new Error(`expected "direct", got ${String(attestation)}`);
    }),
  );

  When(
    "a registration ceremony completes with {string} attestation",
    Effect.fn(function* (_conveyance: string) {
      const cookie = yield* signIn(`v1-attestation-${Date.now()}@example.com`);
      // The conveyance this ceremony's options asked the authenticator for.
      const optionsResponse = yield* request("POST", "/passkey/register/options", {
        body: {},
        headers: { cookie },
      });
      const options = (yield* Effect.promise(() => optionsResponse.json())) as {
        readonly challenge: string;
        readonly attestation?: string;
      };
      yield* setOutcome("requestedAttestation", options.attestation ?? "none");
      const response = yield* verifyChallenge(cookie, options.challenge);
      yield* setOutcome("registerVerifyResponse", response);
    }),
  );

  Then(
    "registration succeeds",
    Effect.fn(function* () {
      const response = (yield* getOutcome("registerVerifyResponse")) as Response;
      if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
    }),
  );

  Then(
    'neither "direct" nor "enterprise" attestation was required for it to succeed',
    Effect.fn(function* () {
      const requested = (yield* getOutcome("requestedAttestation")) as string;
      assert.ok(requested !== "direct" && requested !== "enterprise", `requested ${requested}`);
      assert.strictEqual(requested, "none");
    }),
  );

  // ---- BEH-EA-136: Typed errors are enumeration-safe (378-380) ----

  // Statuses match `PasskeyApi.ts`'s own `httpApiStatus` per error tag —
  // not all 400s, contrary to an earlier draft's guess: `PasskeyChallengeInvalid`/
  // `PasskeyOriginMismatch`/`PasskeyRpIdMismatch`/`PasskeyVerificationFailed`/
  // `PasskeyUserVerificationRequired` are 400 (a malformed/mismatched
  // ceremony request), not 401 (no valid session) — 401 is reserved for
  // `Api.Unauthenticated`, a different failure entirely.
  const FAILURE_TAGS: Record<string, { readonly tag: string; readonly status: number }> = {
    "the challenge is missing or expired": { tag: "PasskeyChallengeInvalid", status: 400 },
    "the ceremony's origin does not match": { tag: "PasskeyOriginMismatch", status: 400 },
    "the ceremony's rpId does not match": { tag: "PasskeyRpIdMismatch", status: 400 },
    // `PasskeyCredentialNotFound` (404) is a credential-*management*
    // (rename/remove) error per `Passkey.ts`'s own handlers — during the
    // authenticate *ceremony* itself, an unknown credential id is
    // deliberately folded into `Api.InvalidCredentials` (BEH-EA-136's own
    // enumeration-safety comment), never `PasskeyCredentialNotFound`. This
    // exercises the real path that tag actually comes from.
    "the credential id is not found": { tag: "PasskeyCredentialNotFound", status: 404 },
    "signature or attestation verification failed": {
      tag: "PasskeyVerificationFailed",
      status: 400,
    },
    "user verification was required but absent": {
      tag: "PasskeyUserVerificationRequired",
      status: 400,
    },
    "removing the account's last credential was attempted": {
      tag: "PasskeyLastCredential",
      status: 409,
    },
  };

  // The wire failure each documented reason produces, induced for real against a fresh app.
  const induceFailure = Effect.fn("features.passkey.induceFailure")(function* (reason: string) {
    const known = FAILURE_TAGS[reason];
    if (known === undefined) throw new Error(`unrecognized failure reason: ${reason}`);

    // Configure with whatever WebAuthn override this failure needs
    // BEFORE signing in — `configureApp` rebuilds the app (a fresh
    // memoMap/handler), which would silently discard a session created
    // by an earlier `signIn` call against the previous app instance.
    yield* configureApp(
      known.tag === "PasskeyVerificationFailed"
        ? { webAuthn: { failVerifyRegistration: true } }
        : known.tag === "PasskeyUserVerificationRequired"
          ? // CB-001 (.issues/high): enforcement follows the RP's own
            // conveyed `userVerification` policy — the default
            // `"preferred"` no longer rejects UV=0, so this scenario
            // must explicitly opt into `"required"` to still exercise
            // the failure it names, mirroring the sign-in path's own
            // already-`"required"`-gated equivalent.
            {
              webAuthn: { registrationVerified: { userVerified: false } },
              authenticatorSelection: { userVerification: "required" },
            }
          : known.tag === "PasskeyRpIdMismatch"
            ? // An accepted origin whose host doesn't match `rpId` as a
              // registrable-domain suffix — needed to reach the rpId
              // check at all, since the origin check runs first and
              // rejects any origin outside `config.origins` before ever
              // reaching it.
              { origins: [ORIGIN, "https://mismatched-host.example"] }
            : {},
      "replace",
    );
    const cookie = yield* signIn(`fails-${Date.now()}-${Math.random()}@example.com`);
    switch (known.tag) {
      case "PasskeyChallengeInvalid":
        return yield* verifyChallenge(cookie, "never-issued");
      case "PasskeyOriginMismatch":
        return yield* verifyAtOrigin("https://not-configured.example.org");
      case "PasskeyRpIdMismatch":
        return yield* verifyAtOrigin("https://mismatched-host.example");
      case "PasskeyCredentialNotFound":
        // A management call (rename) against an id this user never
        // registered — the real source of this tag; see the FAILURE_TAGS
        // comment above for why the authenticate ceremony itself never
        // produces it.
        return yield* request("PATCH", "/passkey/credentials/no-such-credential", {
          body: { name: "New Name" },
          headers: { cookie },
        });
      case "PasskeyVerificationFailed":
      case "PasskeyUserVerificationRequired":
        return yield* registerCredential(cookie);
      case "PasskeyLastCredential": {
        yield* registerCredential(cookie);
        const listResponse = yield* request("GET", "/passkey/credentials", {
          headers: { cookie },
        });
        const listed = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<{
          id: string;
        }>;
        return yield* request("DELETE", `/passkey/credentials/${listed[0]!.id}`, {
          headers: { cookie },
        });
      }
      default:
        throw new Error(`unhandled failure tag: ${known.tag}`);
    }
  });

  Given(
    "a ceremony that fails for the reason {string}",
    Effect.fn(function* (failure: string) {
      const known = FAILURE_TAGS[failure];
      if (known === undefined) throw new Error(`unrecognized failure reason: ${failure}`);
      yield* setOutcome("failureReason", failure);
      yield* setOutcome("expectedTag", known.tag);
      yield* setOutcome("expectedStatus", known.status);
    }),
  );

  When(
    "the failure is returned to the caller",
    Effect.fn(function* () {
      const failure = (yield* getOutcome("failureReason")) as string;
      yield* setOutcome("failureResponse", yield* induceFailure(failure));
    }),
  );

  Then(
    "it is reported as the distinct typed error {string}",
    Effect.fn(function* (expectedTag: string) {
      const response = (yield* getOutcome("failureResponse")) as Response;
      const status = (yield* getOutcome("expectedStatus")) as number;
      assert.strictEqual(response.status, status);
      assert.strictEqual(yield* bodyTag(response), expectedTag);
    }),
  );

  Given(
    "the same set of distinct ceremony failure reasons",
    Effect.fn(function* () {
      yield* setOutcome("failureReasons", Object.keys(FAILURE_TAGS));
    }),
  );

  When(
    "each is returned to the caller",
    Effect.fn(function* () {
      const reasons = (yield* getOutcome("failureReasons")) as ReadonlyArray<string>;
      const observed: Array<{ readonly tag: string | undefined; readonly expected: string }> = [];
      for (const reason of reasons) {
        const response = yield* induceFailure(reason);
        observed.push({ tag: yield* bodyTag(response), expected: FAILURE_TAGS[reason]!.tag });
      }
      yield* setOutcome("observedFailures", observed);
    }),
  );

  Then(
    "no single generic error tag is used for more than one of them",
    Effect.fn(function* () {
      const observed = (yield* getOutcome("observedFailures")) as ReadonlyArray<{
        readonly tag: string | undefined;
        readonly expected: string;
      }>;
      assert.strictEqual(observed.length, Object.keys(FAILURE_TAGS).length);
      // Each reason produced its own tag on the wire, and no two reasons share one.
      for (const { tag, expected } of observed) assert.strictEqual(tag, expected);
      assert.strictEqual(new Set(observed.map((o) => o.tag)).size, observed.length);
    }),
  );

  // The wire tags decode to the plugin's own typed errors, and one `Effect.catchTags` record
  // covering exactly those tags handles every reason — a missing key would not compile.
  const WireFailure = Schema.Union([
    PasskeyApi.PasskeyChallengeInvalid,
    PasskeyApi.PasskeyOriginMismatch,
    PasskeyApi.PasskeyRpIdMismatch,
    PasskeyApi.PasskeyCredentialNotFound,
    PasskeyApi.PasskeyVerificationFailed,
    PasskeyApi.PasskeyUserVerificationRequired,
    PasskeyApi.PasskeyLastCredential,
  ]);

  Then(
    'the caller can use "Effect.catchTags" to distinguish every reason exhaustively',
    Effect.fn(function* () {
      const observed = (yield* getOutcome("observedFailures")) as ReadonlyArray<{
        readonly tag: string | undefined;
      }>;
      const handled: Array<string> = [];
      for (const { tag } of observed) {
        const decoded = yield* Schema.decodeUnknownEffect(WireFailure)({ _tag: tag });
        yield* Effect.fail(decoded).pipe(
          Effect.catchTags({
            PasskeyChallengeInvalid: () =>
              Effect.sync(() => handled.push("PasskeyChallengeInvalid")),
            PasskeyOriginMismatch: () => Effect.sync(() => handled.push("PasskeyOriginMismatch")),
            PasskeyRpIdMismatch: () => Effect.sync(() => handled.push("PasskeyRpIdMismatch")),
            PasskeyCredentialNotFound: () =>
              Effect.sync(() => handled.push("PasskeyCredentialNotFound")),
            PasskeyVerificationFailed: () =>
              Effect.sync(() => handled.push("PasskeyVerificationFailed")),
            PasskeyUserVerificationRequired: () =>
              Effect.sync(() => handled.push("PasskeyUserVerificationRequired")),
            PasskeyLastCredential: () => Effect.sync(() => handled.push("PasskeyLastCredential")),
          }),
        );
      }
      assert.deepStrictEqual(
        handled,
        observed.map((o) => o.tag),
      );
    }),
  );

  // REQ-EA-380: the unknown-credential ceremony and a known-credential-that-fails ceremony
  // answer identically. The Given only arranges; the When performs both attempts.
  Given(
    "an authentication attempt for a user identifier that has no registered passkey credential",
    Effect.fn(function* () {
      yield* configureApp({});
    }),
  );

  When(
    '"PasskeyCredentialNotFound" is returned',
    Effect.fn(function* () {
      const optionsResponse = yield* request("POST", "/passkey/authenticate/options", {
        body: { email: "nobody-registered@example.com" },
      });
      const { ceremonyId, options } = (yield* Effect.promise(() => optionsResponse.json())) as {
        ceremonyId: string;
        options: unknown;
      };
      const challenge = extractChallenge(options);
      const unknownCredResponse = yield* request("POST", "/passkey/authenticate/verify", {
        body: {
          ceremonyId,
          credential: {
            id: "no-such-credential",
            rawId: "no-such-credential",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.get",
                challenge,
                origin: ORIGIN,
              }),
              authenticatorData: "",
              signature: "",
            },
          },
        },
      });
      yield* setOutcome("unknownCredResponse", unknownCredResponse);

      // A second ceremony against a credential that DOES exist but fails
      // verification, to compare the two responses against each other.
      const cookie = yield* signIn(`exists-fails-${Date.now()}@example.com`);
      yield* registerCredential(cookie);
      yield* overrideWebAuthnBehavior({ failVerifyAuthentication: true });
      const failsResponse = yield* authenticate();
      yield* setOutcome("existsButFailsResponse", failsResponse);
    }),
  );

  // ---- CB-004/WPS-006: counter-anomaly policy (REQ-EA-381) ----

  Given(
    "a stored credential with a nonzero counter, and an authentication assertion whose returned counter does not exceed it, under the {string} counter-anomaly policy",
    Effect.fn(function* (policy: string) {
      yield* configureApp({ counterAnomalyPolicy: policy === "reject" ? "reject" : "flag" });
      const cookie = yield* signIn(`counter-${policy}@example.com`);
      yield* registerCredential(cookie);
      // The mocked port always reports `newCounter: 1`: this first sign-in
      // leaves the stored counter at 1, so the next identical assertion
      // (1 <= 1) is a regression.
      yield* authenticate();
      yield* setOutcome("counterCookie", cookie);
    }),
  );

  When(
    '"authenticateVerify" processes the regressed assertion',
    Effect.fn(function* () {
      const response = yield* authenticate();
      yield* setOutcome("counterResponse", response);
    }),
  );

  Then(
    "the outcome is {string}",
    Effect.fn(function* (outcome: string) {
      const response = (yield* getOutcome("counterResponse")) as Response;
      if (outcome === "PasskeyCounterAnomaly") {
        if (response.status !== 409) throw new Error(`expected 409, got ${response.status}`);
        const body = (yield* Effect.promise(() => response.clone().json())) as { _tag?: string };
        if (body._tag !== "PasskeyCounterAnomaly") {
          throw new Error(`expected PasskeyCounterAnomaly, got ${body._tag}`);
        }
      } else {
        if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
        cookieFrom(response);
      }
    }),
  );

  Then(
    "the credential is flagged for the counter anomaly",
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("counterCookie")) as string;
      const response = yield* request("GET", "/passkey/credentials", { headers: { cookie } });
      const listed = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        counterAnomalyAt: string | null;
      }>;
      if (listed[0]?.counterAnomalyAt == null) {
        throw new Error("expected the credential to carry a counterAnomalyAt timestamp");
      }
    }),
  );

  Then(
    "the response does not reveal whether any credential exists for that identifier, distinguishably from a credential that exists but fails verification",
    Effect.fn(function* () {
      const unknownResponse = (yield* getOutcome("unknownCredResponse")) as Response;
      const existsButFailsResponse = (yield* getOutcome("existsButFailsResponse")) as Response;
      if (unknownResponse.status !== existsButFailsResponse.status) {
        throw new Error(
          `expected identical status codes (both InvalidCredentials), got ${unknownResponse.status} vs ${existsButFailsResponse.status}`,
        );
      }
      const unknownBody = (yield* Effect.promise(() => unknownResponse.clone().json())) as {
        _tag?: string;
      };
      const existsBody = (yield* Effect.promise(() => existsButFailsResponse.clone().json())) as {
        _tag?: string;
      };
      if (unknownBody._tag !== existsBody._tag) {
        throw new Error(
          `expected identical error tags, got "${unknownBody._tag}" vs "${existsBody._tag}"`,
        );
      }
    }),
  );
});
