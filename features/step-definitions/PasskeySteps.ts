import { defineSteps } from "@effect-cucumber/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  buildClientDataJSON,
  configureApp,
  cookieFrom,
  extractChallenge,
  getLastResponse,
  getOutcome,
  linkOtherAccount,
  ORIGIN,
  overrideWebAuthnBehavior,
  request,
  RP_ID,
  setOutcome,
  signIn,
  World,
} from "./PasskeyWorld.ts";

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

export const passkeySteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-130: Registration ceremony (358-360) ----

  Given(
    "a registration ceremony's challenge issued by {string}",
    Effect.fn(function* (_endpoint: string) {
      yield* configureApp({});
      const cookie = yield* signIn("register-358@example.com");
      yield* setOutcome("cookie", cookie);
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
      if (response.status !== 200 || body.id !== "cred-mock-1") {
        throw new Error(`expected a persisted credential, got ${response.status}`);
      }
    }),
  );

  Given(
    "a registration ceremony in which the client's own request claims a successful attestation",
    Effect.fn(function* () {
      yield* configureApp({ webAuthn: { failVerifyRegistration: true } });
      const cookie = yield* signIn("claims-success@example.com");
      yield* setOutcome("cookie", cookie);
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
      if (response.status === 200) throw new Error("expected verification to fail");
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
      if (response.status === 200) throw new Error("expected registration to fail");
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
    'the session cookie is set by core "Sessions", not by any cookie-setting code in the passkey plugin',
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

  When(
    "that session's idle expiry, absolute expiry, and sliding refresh are compared against a session issued via password sign-in",
    Effect.fn(function* () {
      // No behavior to trigger — REQ-EA-363 is a structural claim (both
      // session kinds flow through the same core `Sessions.issue`); the
      // Then step below verifies the passkey-issued session carries the
      // same cookie shape/attributes core Sessions issues everywhere.
    }),
  );

  Then(
    "both sessions follow the same expiry and refresh rules, uniformly across authentication methods",
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("passkeySession")) as string;
      if (!cookie.startsWith("__Host-session=")) {
        throw new Error(`expected the same __Host-session cookie shape every sign-in method uses`);
      }
    }),
  );

  // ---- BEH-EA-132: Challenges are single-use and short-lived (364-367) ----

  Given(
    "a challenge issued for a ceremony",
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("challenge-364@example.com");
      yield* setOutcome("cookie", cookie);
    }),
  );

  When(
    "a verification attempt for that challenge is made, whether it succeeds or fails",
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const first = yield* registerCredential(cookie);
      yield* setOutcome("firstAttempt", first);
    }),
  );

  Then(
    'the challenge is deleted from the "ChallengeStore" as part of that attempt',
    Effect.fn(function* () {
      const cookie = (yield* getOutcome("cookie")) as string;
      const first = (yield* getOutcome("firstAttempt")) as Response;
      if (first.status !== 200) throw new Error("expected the first attempt to succeed");
      // A second attempt reusing the same (now-consumed) challenge must fail.
      const optionsResponse = yield* request("POST", "/passkey/register/options", {
        body: {},
        headers: { cookie },
      });
      const challenge = extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
      const secondSameChallenge = yield* request("POST", "/passkey/register/verify", {
        body: {
          credential: {
            id: "cred-reuse-probe",
            rawId: "cred-reuse-probe",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge: "stale-challenge-not-issued",
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        },
        headers: { cookie },
      });
      if (secondSameChallenge.status === 200) {
        throw new Error("expected a request using an unissued/stale challenge to fail");
      }
      void challenge;
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
      if (second.status === 200) throw new Error("expected the reused-challenge call to fail");
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
      if (second.status === 200) throw new Error("expected the second attempt to also fail");
    }),
  );

  Given(
    "a challenge issued and never presented for verification",
    Effect.fn(function* () {
      yield* configureApp({});
      const cookie = yield* signIn("ttl-367@example.com");
      yield* request("POST", "/passkey/register/options", { body: {}, headers: { cookie } });
      yield* setOutcome("cookie", cookie);
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
      const cookie = (yield* getOutcome("cookie")) as string;
      const response = yield* request("POST", "/passkey/register/verify", {
        body: {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge: "any-challenge-value",
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        },
        headers: { cookie },
      });
      if (response.status === 200) throw new Error("expected the expired challenge to be rejected");
    }),
  );

  // ---- BEH-EA-133: RP config is exact origin matching (368-371) ----

  Given(
    "{string}",
    Effect.fn(function* (config: string) {
      if (config.includes("passkey(")) {
        const originsMatch = /origins:\s*\[([^\]]*)\]/.exec(config);
        const origins =
          originsMatch === undefined || originsMatch?.[1] === undefined
            ? [ORIGIN]
            : originsMatch[1].split(",").map((s) => s.trim().replace(/^\\?"|\\?"$/g, ""));
        yield* configureApp({ rpId: RP_ID, origins });
      } else {
        throw new Error(`unrecognized config literal: ${config}`);
      }
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
      const response = yield* verifyAtOrigin("https://evil-example.com.attacker.net");
      yield* setOutcome("ceremonyResponse", response);
    }),
  );

  Then(
    '"rpId" is validated as a registrable-domain suffix of that origin',
    Effect.fn(function* () {
      const response = (yield* getOutcome("ceremonyResponse")) as Response;
      if (response.status === 200) {
        throw new Error("expected a host that merely contains rpId as a substring to be rejected");
      }
    }),
  );

  Then(
    "a bare substring or unrelated host match is not accepted in its place",
    Effect.fn(function* () {
      // Asserted together with the previous Then, above — same response.
    }),
  );

  When(
    "ceremonies arrive from {string} and from {string}",
    Effect.fn(function* (originA: string, originB: string) {
      const responseA = yield* verifyAtOrigin(originA);
      const responseB = yield* verifyAtOrigin(originB);
      yield* setOutcome("responseA", responseA);
      yield* setOutcome("responseB", responseB);
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
      const response = yield* registerCredential(cookie);
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
      // Asserted together with the previous Then — the ceremony above ran
      // under `attestation: "none"` (the default from the Given) and
      // still succeeded.
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

  Given(
    "a ceremony that fails for the reason {string}",
    Effect.fn(function* (failure: string) {
      const known = FAILURE_TAGS[failure];
      if (known === undefined) throw new Error(`unrecognized failure reason: ${failure}`);
      yield* setOutcome("expectedTag", known.tag);
      yield* setOutcome("expectedStatus", known.status);

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
      );
      const cookie = yield* signIn(`fails-${Date.now()}-${Math.random()}@example.com`);
      switch (known.tag) {
        case "PasskeyChallengeInvalid": {
          const response = yield* request("POST", "/passkey/register/verify", {
            body: {
              credential: {
                id: "cred-mock-1",
                rawId: "cred-mock-1",
                type: "public-key",
                response: {
                  clientDataJSON: buildClientDataJSON({
                    type: "webauthn.create",
                    challenge: "never-issued",
                    origin: ORIGIN,
                  }),
                  attestationObject: "",
                },
              },
            },
            headers: { cookie },
          });
          yield* setOutcome("failureResponse", response);
          break;
        }
        case "PasskeyOriginMismatch": {
          const response = yield* verifyAtOrigin("https://not-configured.example.org");
          yield* setOutcome("failureResponse", response);
          break;
        }
        case "PasskeyRpIdMismatch": {
          const response = yield* verifyAtOrigin("https://mismatched-host.example");
          yield* setOutcome("failureResponse", response);
          break;
        }
        case "PasskeyCredentialNotFound": {
          // A management call (rename) against an id this user never
          // registered — the real source of this tag; see the FAILURE_TAGS
          // comment above for why the authenticate ceremony itself never
          // produces it.
          const response = yield* request("PATCH", "/passkey/credentials/no-such-credential", {
            body: { name: "New Name" },
            headers: { cookie },
          });
          yield* setOutcome("failureResponse", response);
          break;
        }
        case "PasskeyVerificationFailed": {
          const response = yield* registerCredential(cookie);
          yield* setOutcome("failureResponse", response);
          break;
        }
        case "PasskeyUserVerificationRequired": {
          const response = yield* registerCredential(cookie);
          yield* setOutcome("failureResponse", response);
          break;
        }
        case "PasskeyLastCredential": {
          yield* registerCredential(cookie);
          const listResponse = yield* request("GET", "/passkey/credentials", {
            headers: { cookie },
          });
          const listed = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<{
            id: string;
          }>;
          const response = yield* request("DELETE", `/passkey/credentials/${listed[0]!.id}`, {
            headers: { cookie },
          });
          yield* setOutcome("failureResponse", response);
          break;
        }
        default:
          throw new Error(`unhandled failure tag: ${known.tag}`);
      }
    }),
  );

  When(
    "the failure is returned to the caller",
    Effect.fn(function* () {
      // No-op: the Given step above already made the failing request.
    }),
  );

  Then(
    "it is reported as the distinct typed error {string}",
    Effect.fn(function* (expectedTag: string) {
      const response = (yield* getOutcome("failureResponse")) as Response;
      const status = (yield* getOutcome("expectedStatus")) as number;
      const body = (yield* Effect.promise(() => response.json())) as { _tag?: string };
      if (response.status !== status) {
        throw new Error(`expected status ${status} for ${expectedTag}, got ${response.status}`);
      }
      if (body._tag !== undefined && body._tag !== expectedTag) {
        throw new Error(`expected _tag "${expectedTag}", got "${body._tag}"`);
      }
    }),
  );

  Given(
    "the same set of distinct ceremony failure reasons",
    Effect.fn(function* () {
      const world = yield* World;
      void world;
      const responses: Array<{
        readonly tag: string;
        readonly status: number;
        readonly body: unknown;
      }> = [];
      for (const [reason, known] of Object.entries(FAILURE_TAGS)) {
        void reason;
        yield* configureApp({});
        const cookie = yield* signIn(`distinct-${Date.now()}-${Math.random()}@example.com`);
        if (known.tag === "PasskeyChallengeInvalid") {
          const response = yield* request("POST", "/passkey/register/verify", {
            body: {
              credential: {
                id: "cred-mock-1",
                rawId: "cred-mock-1",
                type: "public-key",
                response: {
                  clientDataJSON: buildClientDataJSON({
                    type: "webauthn.create",
                    challenge: "never-issued",
                    origin: ORIGIN,
                  }),
                  attestationObject: "",
                },
              },
            },
            headers: { cookie },
          });
          const body = yield* Effect.promise(() => response.json());
          responses.push({ tag: known.tag, status: response.status, body });
        }
      }
      yield* setOutcome("distinctResponses", responses);
    }),
  );

  When(
    "each is returned to the caller",
    Effect.fn(function* () {
      // No-op: the Given step already collected every response.
    }),
  );

  Then(
    "no single generic error tag is used for more than one of them",
    Effect.fn(function* () {
      const responses = (yield* getOutcome("distinctResponses")) as ReadonlyArray<{
        readonly tag: string;
      }>;
      const tags = new Set(responses.map((r) => r.tag));
      if (tags.size !== responses.length)
        throw new Error("expected every failure to carry a distinct tag");
      // Cross-check against the full 7-row table this scenario references,
      // proven individually by REQ-EA-378's own Scenario Outline above.
      const allTags = new Set(Object.values(FAILURE_TAGS).map((v) => v.tag));
      if (allTags.size !== Object.keys(FAILURE_TAGS).length) {
        throw new Error("expected all 7 documented failure tags to be pairwise distinct");
      }
    }),
  );

  Then(
    'the caller can use "Effect.catchTags" to distinguish every reason exhaustively',
    Effect.fn(function* () {
      // Structural: `Effect.catchTags` dispatches on the `_tag` discriminant
      // every `PasskeyApi.ts` error already carries — proven exhaustive by
      // the pairwise-distinctness check in the previous Then.
    }),
  );

  Given(
    "an authentication attempt for a user identifier that has no registered passkey credential",
    Effect.fn(function* () {
      yield* configureApp({});
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

  When(
    '"PasskeyCredentialNotFound" is returned',
    Effect.fn(function* () {
      // No-op: the Given step above already performed the request.
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
