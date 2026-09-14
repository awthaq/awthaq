// spec/behaviors/17-passkey.md, BEH-EA-129/130/131/133.
//
// Exercises `layerSimpleWebAuthn` against real, cryptographically valid
// ceremony payloads built by `webauthnFixtures.ts` — not only deliberately
// broken input — so this port's actual signature/challenge/origin/rpId
// verification is proven to work, not merely to reject.
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { assert, describe, it } from "@effect/vitest";
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
            counter: 4,
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
            counter: 0,
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
            counter: 0,
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(WebAuthn.layerSimpleWebAuthn)),
  );
});
