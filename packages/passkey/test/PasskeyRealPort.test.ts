// spec/behaviors/17-passkey.md, BEH-EA-130/131/135 — HSK-008 (+HSK-003, CB-004, HSK-002).
//
// The other plugin suites mock the `WebAuthn` port, so they can never notice
// a defect that only real ceremony payloads expose. This one composes the
// plugin with `WebAuthn.layerSimpleWebAuthn` and drives it with cryptographically
// valid, software-authenticator payloads (`packages/ports/test/webauthnFixtures.ts`):
// a packed self-attestation carrying a real AAGUID and transports, then real
// assertions with a moving — and a regressing — signature counter.
import { AuditLog, Sessions, Users } from "@awthaq/core";
import { WebAuthn } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import { buildLayer } from "./passkeyTestLayers.ts";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  makeAuthenticator,
} from "../../ports/test/webauthnFixtures.ts";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const GOOGLE_PASSWORD_MANAGER = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";

const authenticator = makeAuthenticator(new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7]));
const credentialId = Encoding.encodeBase64Url(authenticator.credentialId);

const config = {
  attestation: "direct",
  attestationPolicy: { trustedAaguids: [GOOGLE_PASSWORD_MANAGER], rejectSelfAttestation: false },
} as const;

/** Registers the software authenticator for a fresh user via a real packed self-attestation. */
const enroll = (email: string) =>
  Effect.gen(function* () {
    const passkey = yield* Passkey.Passkey;
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Real Port" });
    const issued = yield* sessions.issue({ userId: user.id });
    const options = yield* passkey.registerOptions(user.id, issued.session.id);
    const response = buildRegistrationResponse({
      authenticator,
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge,
      attestation: "packed-self",
      aaguid: GOOGLE_PASSWORD_MANAGER,
      transports: ["usb", "nfc"],
    });
    const record = yield* passkey.registerVerify(user.id, issued.session.id, {
      credential: {
        id: response.id,
        rawId: response.rawId,
        type: "public-key",
        response: {
          clientDataJSON: response.response.clientDataJSON,
          attestationObject: response.response.attestationObject,
          ...(response.response.transports === undefined
            ? {}
            : { transports: response.response.transports }),
        },
      },
    });
    return { user, sessionId: issued.session.id, record, options };
  });

const assertWith = (email: string, counter: number, userHandle?: string) =>
  Effect.gen(function* () {
    const passkey = yield* Passkey.Passkey;
    const { ceremonyId, options } = yield* passkey.authenticateOptions({ email });
    const response = buildAuthenticationResponse({
      authenticator,
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge,
      counter,
      ...(userHandle === undefined ? {} : { userHandle }),
    });
    return yield* passkey.authenticateVerify({
      ceremonyId,
      credential: {
        id: response.id,
        rawId: response.rawId,
        type: "public-key",
        response: {
          clientDataJSON: response.response.clientDataJSON,
          authenticatorData: response.response.authenticatorData,
          signature: response.response.signature,
          ...(response.response.userHandle === undefined
            ? {}
            : { userHandle: response.response.userHandle }),
        },
      },
    });
  });

describe("Passkey over the real WebAuthn port", () => {
  it.effect(
    "registers a packed self-attestation: AAGUID label, transports and handle persist and round-trip",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { user, sessionId, record, options } = yield* enroll("real-register@example.com");

        assert.strictEqual(record.id, credentialId);
        // HSK-008: the AAGUID names the credential.
        assert.strictEqual(record.aaguid, GOOGLE_PASSWORD_MANAGER);
        assert.strictEqual(record.name, "Google Password Manager");
        // HSK-003: what the browser reported is what is stored.
        assert.deepStrictEqual(record.transports, ["usb", "nfc"]);
        // BPAS-003: the stored handle is the very one the options carried.
        assert.strictEqual(record.webauthnUserId, options.user.id);

        // …and it flows back into the next ceremony's excludeCredentials and the sign-in hints.
        const next = yield* passkey.registerOptions(user.id, sessionId);
        assert.deepStrictEqual(next.excludeCredentials, [
          { id: credentialId, type: "public-key", transports: ["usb", "nfc"] },
        ]);
        const signIn = yield* passkey.authenticateOptions({ email: "real-register@example.com" });
        assert.deepStrictEqual(signIn.options.allowCredentials, [
          { id: credentialId, type: "public-key", transports: ["usb", "nfc"] },
        ]);
        // TC-003: the real options carry the plugin's explicit timeout.
        assert.strictEqual(options.timeout, 270_000);
      }).pipe(Effect.provide(buildLayer(WebAuthn.layerSimpleWebAuthn, config))),
  );

  it.effect(
    "signs in with real assertions: the counter advances, and the handle the authenticator returns is accepted",
    () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        const { user, record } = yield* enroll("real-signin@example.com");

        const issued = yield* assertWith("real-signin@example.com", 7, record.webauthnUserId);
        assert.strictEqual(issued.session.userId, user.id);
        const stored = yield* credentials.findById(credentialId);
        assert.isTrue(Option.isSome(stored) && stored.value.counter === 7);
      }).pipe(Effect.provide(buildLayer(WebAuthn.layerSimpleWebAuthn, config))),
  );

  it.effect(
    "CB-004: a real regressed assertion reaches the policy — flagged under 'flag', still signed in",
    () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        const auditLog = yield* AuditLog.AuditLog;
        yield* enroll("real-flag@example.com");
        yield* assertWith("real-flag@example.com", 7);

        // Before the port change the library threw here and it became InvalidCredentials.
        const issued = yield* assertWith("real-flag@example.com", 3);
        assert.isString(issued.session.id);

        const stored = yield* credentials.findById(credentialId);
        assert.isTrue(Option.isSome(stored));
        if (Option.isSome(stored)) {
          assert.isTrue(Option.isSome(stored.value.counterAnomalyAt));
          assert.strictEqual(stored.value.counter, 7);
        }
        // Durably audited too (6bd3f1d), not only published.
        const rows = yield* auditLog.list({ eventTag: "auth.passkey.counterAnomaly" });
        assert.strictEqual(rows.length, 1);
      }).pipe(Effect.provide(buildLayer(WebAuthn.layerSimpleWebAuthn, config))),
  );

  it.effect("CB-004: under 'reject' the same real regression fails PasskeyCounterAnomaly", () =>
    Effect.gen(function* () {
      yield* enroll("real-reject@example.com");
      yield* assertWith("real-reject@example.com", 7);
      const failure = yield* assertWith("real-reject@example.com", 3).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyCounterAnomaly");
    }).pipe(
      Effect.provide(
        buildLayer(WebAuthn.layerSimpleWebAuthn, { ...config, counterAnomalyPolicy: "reject" }),
      ),
    ),
  );

  it.effect(
    "HSK-002: a none-format registration is refused by an attestation policy over the real port",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "real-none@example.com" },
          name: "None",
        });
        const issued = yield* sessions.issue({ userId: user.id });
        const options = yield* passkey.registerOptions(user.id, issued.session.id);
        const response = buildRegistrationResponse({
          authenticator: makeAuthenticator(new Uint8Array([8, 8, 8, 8])),
          rpId: RP_ID,
          origin: ORIGIN,
          challenge: options.challenge,
          aaguid: GOOGLE_PASSWORD_MANAGER,
        });
        const failure = yield* passkey
          .registerVerify(user.id, issued.session.id, {
            credential: {
              id: response.id,
              rawId: response.rawId,
              type: "public-key",
              response: {
                clientDataJSON: response.response.clientDataJSON,
                attestationObject: response.response.attestationObject,
              },
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyAttestationRejected");
      }).pipe(Effect.provide(buildLayer(WebAuthn.layerSimpleWebAuthn, config))),
  );

  it.effect("CB-002: a UP=0 ordinary registration is refused by the real library", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "real-up@example.com" },
        name: "UP",
      });
      const issued = yield* sessions.issue({ userId: user.id });
      const options = yield* passkey.registerOptions(user.id, issued.session.id);
      const response = buildRegistrationResponse({
        authenticator: makeAuthenticator(new Uint8Array([9, 9, 9, 9])),
        rpId: RP_ID,
        origin: ORIGIN,
        challenge: options.challenge,
        userPresent: false,
        userVerified: false,
      });
      const failure = yield* passkey
        .registerVerify(user.id, issued.session.id, {
          credential: {
            id: response.id,
            rawId: response.rawId,
            type: "public-key",
            response: {
              clientDataJSON: response.response.clientDataJSON,
              attestationObject: response.response.attestationObject,
            },
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(buildLayer(WebAuthn.layerSimpleWebAuthn))),
  );
});
