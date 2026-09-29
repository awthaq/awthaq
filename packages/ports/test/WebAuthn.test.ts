// spec/behaviors/17-passkey.md, BEH-EA-129/130/131/133.
//
// Exercises `layerSimpleWebAuthn` against real, cryptographically valid
// ceremony payloads built by `webauthnFixtures.ts` — not only deliberately
// broken input — so this port's actual signature/challenge/origin/rpId
// verification is proven to work, not merely to reject.
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as WebAuthn from "../src/WebAuthn.ts";
import * as Fixtures from "./webauthnFixtures.ts";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";

const randomChallenge = (seed: number): string =>
  isoBase64URL.fromBuffer(new Uint8Array([seed, 1, 2, 3, 4, 5, 6, 7]));

describe("WebAuthn.layerSimpleWebAuthn", () => {
  it.effect(
    "BEH-EA-130: registrationOptions embeds the caller-supplied challenge and userId verbatim",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(1);
        const userId = isoBase64URL.fromBuffer(new Uint8Array([42, 42]));
        const options = yield* webAuthn.registrationOptions({
          rpId: RP_ID,
          rpName: "Example",
          challenge,
          userId,
          userName: "ada@example.com",
          userDisplayName: "Ada",
        });
        assert.strictEqual(options.challenge, challenge);
        assert.strictEqual(options.user.id, userId);
        assert.strictEqual(options.attestation, "none");
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("BEH-EA-130: a real, correctly-signed registration response verifies", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(2);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([1, 2, 3, 4, 5]));
      const response = Fixtures.buildRegistrationResponse({
        authenticator,
        rpId: RP_ID,
        origin: ORIGIN,
        challenge,
      });
      const result = yield* webAuthn.verifyRegistration({
        response,
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRpId: RP_ID,
        requireUserPresence: true,
      });
      assert.strictEqual(result.credentialId, isoBase64URL.fromBuffer(authenticator.credentialId));
      assert.strictEqual(result.counter, 0);
      assert.isTrue(result.userVerified);
      assert.strictEqual(result.credentialDeviceType, "singleDevice");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect(
    "BEH-EA-136: a tampered registration response is rejected as PasskeyVerificationFailed",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(3);
        const authenticator = Fixtures.makeAuthenticator(new Uint8Array([9, 9, 9]));
        const response = Fixtures.buildRegistrationResponse({
          authenticator,
          rpId: RP_ID,
          origin: ORIGIN,
          challenge,
        });
        // "none" attestation (BEH-EA-135's default) carries no attestation
        // signature to corrupt — truncating deep enough to break the CBOR
        // structure itself (rather than a few trailing bytes of an otherwise
        // well-formed credential public key, which "none" never re-verifies)
        // is what actually surfaces as a rejected, malformed response here.
        const tampered = {
          ...response,
          response: {
            ...response.response,
            attestationObject: response.response.attestationObject.slice(0, 20),
          },
        };
        const failure = yield* webAuthn
          .verifyRegistration({
            response: tampered,
            expectedChallenge: challenge,
            expectedOrigin: ORIGIN,
            expectedRpId: RP_ID,
            requireUserPresence: true,
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("BEH-EA-133: a registration response from the wrong origin is rejected", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(4);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([4, 4, 4]));
      const response = Fixtures.buildRegistrationResponse({
        authenticator,
        rpId: RP_ID,
        origin: "https://evil.example",
        challenge,
      });
      const failure = yield* webAuthn
        .verifyRegistration({
          response,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          requireUserPresence: true,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("BEH-EA-133: a registration response for the wrong rpId is rejected", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(5);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([5, 5, 5]));
      const response = Fixtures.buildRegistrationResponse({
        authenticator,
        rpId: "other.example",
        origin: ORIGIN,
        challenge,
      });
      const failure = yield* webAuthn
        .verifyRegistration({
          response,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          requireUserPresence: true,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("a registration response answering the wrong challenge is rejected", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([6, 6, 6]));
      const response = Fixtures.buildRegistrationResponse({
        authenticator,
        rpId: RP_ID,
        origin: ORIGIN,
        challenge: randomChallenge(6),
      });
      const failure = yield* webAuthn
        .verifyRegistration({
          response,
          expectedChallenge: randomChallenge(60),
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          requireUserPresence: true,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect(
    "BEH-EA-131: authenticationOptions supports both username-first and usernameless (empty allowCredentials)",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(7);
        const scoped = yield* webAuthn.authenticationOptions({
          rpId: RP_ID,
          challenge,
          allowCredentials: [{ id: isoBase64URL.fromBuffer(new Uint8Array([1])) }],
        });
        assert.strictEqual(scoped.allowCredentials?.length, 1);

        const usernameless = yield* webAuthn.authenticationOptions({
          rpId: RP_ID,
          challenge: randomChallenge(8),
          allowCredentials: [],
        });
        assert.deepStrictEqual(usernameless.allowCredentials, []);
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect(
    "BEH-EA-131/134: a real, correctly-signed authentication assertion verifies and reports the new counter",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(9);
        const authenticator = Fixtures.makeAuthenticator(new Uint8Array([7, 7, 7]));
        const response = Fixtures.buildAuthenticationResponse({
          authenticator,
          rpId: RP_ID,
          origin: ORIGIN,
          challenge,
          counter: 5,
        });
        const result = yield* webAuthn.verifyAuthentication({
          response,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          credential: {
            id: isoBase64URL.fromBuffer(authenticator.credentialId),
            publicKey: Fixtures.encodeCosePublicKey(authenticator),
          },
        });
        assert.strictEqual(
          result.credentialId,
          isoBase64URL.fromBuffer(authenticator.credentialId),
        );
        assert.strictEqual(result.newCounter, 5);
        assert.isTrue(result.userVerified);
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("a tampered authentication signature is rejected as PasskeyVerificationFailed", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(10);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([8, 8, 8]));
      const response = Fixtures.buildAuthenticationResponse({
        authenticator,
        rpId: RP_ID,
        origin: ORIGIN,
        challenge,
        counter: 1,
      });
      const tampered = {
        ...response,
        response: { ...response.response, signature: response.response.signature.slice(0, -4) },
      };
      const failure = yield* webAuthn
        .verifyAuthentication({
          response: tampered,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          credential: {
            id: isoBase64URL.fromBuffer(authenticator.credentialId),
            publicKey: Fixtures.encodeCosePublicKey(authenticator),
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("BEH-EA-133: an authentication assertion from the wrong origin is rejected", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(11);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([11, 11, 11]));
      const response = Fixtures.buildAuthenticationResponse({
        authenticator,
        rpId: RP_ID,
        origin: "https://evil.example",
        challenge,
        counter: 0,
      });
      const failure = yield* webAuthn
        .verifyAuthentication({
          response,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          credential: {
            id: isoBase64URL.fromBuffer(authenticator.credentialId),
            publicKey: Fixtures.encodeCosePublicKey(authenticator),
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );
});

const credentialFor = (authenticator: Fixtures.SoftwareAuthenticator) => ({
  id: isoBase64URL.fromBuffer(authenticator.credentialId),
  publicKey: Fixtures.encodeCosePublicKey(authenticator),
});

describe("WebAuthn.layerSimpleWebAuthn — user presence (CB-002/BPAS-004)", () => {
  it.effect("requireUserPresence: true rejects a UP=0 registration", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(20);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([20, 1]));
      const response = Fixtures.buildRegistrationResponse({
        authenticator,
        rpId: RP_ID,
        origin: ORIGIN,
        challenge,
        userPresent: false,
        userVerified: false,
      });
      const failure = yield* webAuthn
        .verifyRegistration({
          response,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          requireUserPresence: true,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect(
    "requireUserPresence: false accepts a UP=0 registration and reports userPresent false",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(21);
        const authenticator = Fixtures.makeAuthenticator(new Uint8Array([21, 1]));
        const response = Fixtures.buildRegistrationResponse({
          authenticator,
          rpId: RP_ID,
          origin: ORIGIN,
          challenge,
          userPresent: false,
          userVerified: false,
        });
        const result = yield* webAuthn.verifyRegistration({
          response,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          requireUserPresence: false,
        });
        assert.isFalse(result.userPresent);
        assert.isFalse(result.userVerified);
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("an ordinary registration reports userPresent true", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(22);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([22, 1]));
      const result = yield* webAuthn.verifyRegistration({
        response: Fixtures.buildRegistrationResponse({
          authenticator,
          rpId: RP_ID,
          origin: ORIGIN,
          challenge,
        }),
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRpId: RP_ID,
        requireUserPresence: true,
      });
      assert.isTrue(result.userPresent);
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect(
    "verifyAuthentication rejects a UP=0 assertion (the library enforces UP; pinned here)",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(23);
        const authenticator = Fixtures.makeAuthenticator(new Uint8Array([23, 1]));
        const failure = yield* webAuthn
          .verifyAuthentication({
            response: Fixtures.buildAuthenticationResponse({
              authenticator,
              rpId: RP_ID,
              origin: ORIGIN,
              challenge,
              counter: 1,
              userPresent: false,
              userVerified: false,
            }),
            expectedChallenge: challenge,
            expectedOrigin: ORIGIN,
            expectedRpId: RP_ID,
            credential: credentialFor(authenticator),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("verifyAuthentication surfaces userPresent", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(24);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([24, 1]));
      const result = yield* webAuthn.verifyAuthentication({
        response: Fixtures.buildAuthenticationResponse({
          authenticator,
          rpId: RP_ID,
          origin: ORIGIN,
          challenge,
          counter: 1,
        }),
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRpId: RP_ID,
        credential: credentialFor(authenticator),
      });
      assert.isTrue(result.userPresent);
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );
});

describe("WebAuthn.layerSimpleWebAuthn — counter policy is the caller's (CB-004)", () => {
  it.effect(
    "a real assertion whose counter regressed still verifies and reports its newCounter",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(30);
        const authenticator = Fixtures.makeAuthenticator(new Uint8Array([30, 1]));
        // The stored counter (5) is not given to the library at all — a
        // regression is the plugin's policy decision, not a verification failure.
        const result = yield* webAuthn.verifyAuthentication({
          response: Fixtures.buildAuthenticationResponse({
            authenticator,
            rpId: RP_ID,
            origin: ORIGIN,
            challenge,
            counter: 3,
          }),
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          credential: credentialFor(authenticator),
        });
        assert.strictEqual(result.newCounter, 3);
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );
});

describe("WebAuthn.layerSimpleWebAuthn — options knobs (TC-003, HSK-006)", () => {
  it.effect("TC-003: registrationOptions echoes the requested timeout, hints and extensions", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const options = yield* webAuthn.registrationOptions({
        rpId: RP_ID,
        rpName: "Example",
        challenge: randomChallenge(40),
        userId: isoBase64URL.fromBuffer(new Uint8Array([4, 2])),
        userName: "ada@example.com",
        userDisplayName: "Ada",
        timeout: Duration.seconds(120),
        hints: ["security-key"],
        extensions: { credProps: true },
      });
      assert.strictEqual(options.timeout, 120_000);
      assert.deepStrictEqual(options.hints, ["security-key"]);
      assert.strictEqual(options.extensions?.credProps, true);
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect("TC-003: authenticationOptions echoes the requested timeout and hints", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const options = yield* webAuthn.authenticationOptions({
        rpId: RP_ID,
        challenge: randomChallenge(42),
        timeout: Duration.seconds(90),
        hints: ["hybrid", "client-device"],
      });
      assert.strictEqual(options.timeout, 90_000);
      assert.deepStrictEqual(options.hints, ["hybrid", "client-device"]);
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect(
    "HSK-006: registrationOptions with attestation indirect returns attestation indirect",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const options = yield* webAuthn.registrationOptions({
          rpId: RP_ID,
          rpName: "Example",
          challenge: randomChallenge(43),
          userId: isoBase64URL.fromBuffer(new Uint8Array([4, 4])),
          userName: "ada@example.com",
          userDisplayName: "Ada",
          attestation: "indirect",
        });
        assert.strictEqual(options.attestation, "indirect");
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );
});

describe("WebAuthn.layerSimpleWebAuthn — attestation, AAGUID, transports (HSK-002, HSK-008)", () => {
  it.effect("a none registration reports attestationFormat/Type none", () =>
    Effect.gen(function* () {
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challenge = randomChallenge(50);
      const authenticator = Fixtures.makeAuthenticator(new Uint8Array([50, 1]));
      const result = yield* webAuthn.verifyRegistration({
        response: Fixtures.buildRegistrationResponse({
          authenticator,
          rpId: RP_ID,
          origin: ORIGIN,
          challenge,
        }),
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRpId: RP_ID,
        requireUserPresence: true,
      });
      assert.strictEqual(result.attestationFormat, "none");
      assert.strictEqual(result.attestationType, "none");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );

  it.effect(
    "a real packed self-attestation verifies, with its AAGUID, format, type and transports",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const challenge = randomChallenge(51);
        const authenticator = Fixtures.makeAuthenticator(new Uint8Array([51, 1]));
        const result = yield* webAuthn.verifyRegistration({
          response: Fixtures.buildRegistrationResponse({
            authenticator,
            rpId: RP_ID,
            origin: ORIGIN,
            challenge,
            attestation: "packed-self",
            aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
            transports: ["usb", "nfc"],
          }),
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          requireUserPresence: true,
        });
        assert.strictEqual(result.aaguid, "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4");
        assert.strictEqual(result.attestationFormat, "packed");
        assert.strictEqual(result.attestationType, "self");
        assert.deepStrictEqual(result.transports, ["usb", "nfc"]);
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );
});

describe("WebAuthn.layerSimpleWebAuthn — cross-origin top origin (CB-003)", () => {
  it.effect(
    "an assertion from a cross-origin iframe is rejected unless its top origin is expected",
    () =>
      Effect.gen(function* () {
        const webAuthn = yield* WebAuthn.WebAuthn;
        const authenticator = Fixtures.makeAuthenticator(new Uint8Array([60, 1]));
        const build = (challenge: string) =>
          Fixtures.buildAuthenticationResponse({
            authenticator,
            rpId: RP_ID,
            origin: ORIGIN,
            challenge,
            counter: 1,
            crossOrigin: true,
            topOrigin: "https://embedder.example",
          });
        const challenge = randomChallenge(60);
        const rejected = yield* webAuthn
          .verifyAuthentication({
            response: build(challenge),
            expectedChallenge: challenge,
            expectedOrigin: ORIGIN,
            expectedRpId: RP_ID,
            credential: credentialFor(authenticator),
          })
          .pipe(Effect.flip);
        assert.strictEqual(rejected._tag, "PasskeyVerificationFailed");

        const accepted = yield* webAuthn.verifyAuthentication({
          response: build(challenge),
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRpId: RP_ID,
          expectedTopOrigin: ["https://embedder.example"],
          credential: credentialFor(authenticator),
        });
        assert.strictEqual(accepted.newCounter, 1);
      }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );
});
