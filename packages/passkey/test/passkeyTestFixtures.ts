// Shared test support for `Passkey.test.ts` and `AuthHttp.test.ts` — the
// same "one fixtures module per stratum" pattern
// `packages/ports/test/webauthnFixtures.ts` establishes for the port level.
// A mocked `WebAuthn` whose `verifyRegistration`/`verifyAuthentication`
// always succeed with a canned result, ignoring the actual
// attestation/assertion bytes entirely: `clientDataJSON` is always real
// (this plugin decodes it itself, before ever calling the port), only the
// cryptographic verification behind it is stubbed.
import { WebAuthn } from "@awthaq/ports";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const RP_ID = "example.com";
export const ORIGIN = "https://example.com";

export const buildClientDataJSON = (input: {
  readonly type: "webauthn.create" | "webauthn.get";
  readonly challenge: string;
  readonly origin: string;
  /** CB-003: the browser reports `crossOrigin: true` (and, in Chromium, `topOrigin`) for a ceremony run inside a cross-origin iframe. */
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
}): string =>
  Encoding.encodeBase64Url(
    JSON.stringify({
      type: input.type,
      challenge: input.challenge,
      origin: input.origin,
      ...(input.crossOrigin === undefined ? {} : { crossOrigin: input.crossOrigin }),
      ...(input.topOrigin === undefined ? {} : { topOrigin: input.topOrigin }),
    }),
  );

const OptionsChallengeSchema = Schema.Struct({ challenge: Schema.String });

/**
 * `registerOptions`/`authenticateOptions` return the browser's own WebAuthn
 * options dictionary — `mockWebAuthn` below echoes the real `ChallengeStore`
 * value straight through as `.challenge`, so this pulls it back out to
 * build a client response that actually matches what's stored.
 */
export const extractChallenge = (options: unknown): string => {
  const decoded = Schema.decodeUnknownOption(OptionsChallengeSchema)(options);
  if (Option.isNone(decoded)) throw new Error("test fixture: mocked options missing challenge");
  return decoded.value.challenge;
};

/** The `register/verify` body for a mocked ceremony — `ceremony` defaults to the modal one (WPS-003). */
export const registrationPayload = (input: {
  readonly options: unknown;
  readonly id?: string;
  readonly origin?: string;
  readonly ceremony?: "modal" | "conditional";
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
  readonly transports?: ReadonlyArray<"usb" | "nfc" | "internal">;
}) => {
  const id = input.id ?? "cred-mock-1";
  return {
    ...(input.ceremony === undefined ? {} : { ceremony: input.ceremony }),
    credential: {
      id,
      rawId: id,
      type: "public-key" as const,
      response: {
        clientDataJSON: buildClientDataJSON({
          type: "webauthn.create",
          challenge: extractChallenge(input.options),
          origin: input.origin ?? ORIGIN,
          ...(input.crossOrigin === undefined ? {} : { crossOrigin: input.crossOrigin }),
          ...(input.topOrigin === undefined ? {} : { topOrigin: input.topOrigin }),
        }),
        attestationObject: "",
        ...(input.transports === undefined ? {} : { transports: input.transports }),
      },
    },
  };
};

/** The `authenticate/verify` (or `reauthenticate/verify`) credential for a mocked ceremony. */
export const assertionCredential = (input: {
  readonly options: unknown;
  readonly id?: string;
  readonly origin?: string;
  readonly userHandle?: string;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
}) => {
  const id = input.id ?? "cred-mock-1";
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    response: {
      clientDataJSON: buildClientDataJSON({
        type: "webauthn.get",
        challenge: extractChallenge(input.options),
        origin: input.origin ?? ORIGIN,
        ...(input.crossOrigin === undefined ? {} : { crossOrigin: input.crossOrigin }),
        ...(input.topOrigin === undefined ? {} : { topOrigin: input.topOrigin }),
      }),
      authenticatorData: "",
      signature: "",
      ...(input.userHandle === undefined ? {} : { userHandle: input.userHandle }),
    },
  };
};

export const mockWebAuthn = (overrides?: {
  readonly registrationVerified?: Partial<WebAuthn.VerifiedRegistration>;
  readonly authenticationVerified?: Partial<WebAuthn.VerifiedAuthentication>;
  /** Observes every call the plugin makes to the port, so a test can assert what was (or was not) asked of it. */
  readonly spy?: {
    readonly registrationOptions?: Array<WebAuthn.RegistrationOptionsInput>;
    readonly authenticationOptions?: Array<WebAuthn.AuthenticationOptionsInput>;
    readonly verifyRegistration?: Array<WebAuthn.VerifyRegistrationInput>;
    readonly verifyAuthentication?: Array<WebAuthn.VerifyAuthenticationInput>;
  };
}): Layer.Layer<WebAuthn.WebAuthn> =>
  Layer.mock(WebAuthn.WebAuthn, {
    // Echoes the real `challenge` this plugin's own `ChallengeStore` issued
    // back through — the mock only stubs out the cryptographic
    // verification below, never the plugin's own challenge bookkeeping, so
    // a test must be able to read the real value back out to build a
    // matching `clientDataJSON`.
    registrationOptions: (input) => {
      overrides?.spy?.registrationOptions?.push(input);
      return Effect.succeed({
        rp: { id: input.rpId, name: input.rpName },
        user: { id: input.userId, name: input.userName, displayName: input.userDisplayName },
        challenge: input.challenge,
        pubKeyCredParams: [],
        excludeCredentials: (input.excludeCredentials ?? []).map((descriptor) => ({
          id: descriptor.id,
          type: "public-key" as const,
          ...(descriptor.transports === undefined
            ? {}
            : { transports: [...descriptor.transports] }),
        })),
        ...(input.timeout === undefined ? {} : { timeout: Duration.toMillis(input.timeout) }),
      });
    },
    verifyRegistration: (input) => {
      overrides?.spy?.verifyRegistration?.push(input);
      const verified = {
        // The credential id the browser reported, like a real authenticator's —
        // so a test can register several distinct credentials (WPS-003/WPS-010).
        credentialId: input.response.id,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        aaguid: "00000000-0000-0000-0000-000000000000",
        transports: input.response.response.transports ?? [],
        credentialDeviceType: "singleDevice" as const,
        credentialBackedUp: false,
        userVerified: true,
        userPresent: true,
        attestationFormat: "none",
        attestationType: "none" as const,
        ...overrides?.registrationVerified,
      };
      // Like the real library: a required UP flag that is not set fails verification.
      return input.requireUserPresence && !verified.userPresent
        ? Effect.fail(new WebAuthn.PasskeyVerificationFailed({ message: "mocked: UP required" }))
        : Effect.succeed(verified);
    },
    authenticationOptions: (input) => {
      overrides?.spy?.authenticationOptions?.push(input);
      return Effect.succeed({
        challenge: input.challenge,
        allowCredentials: (input.allowCredentials ?? []).map((descriptor) => ({
          id: descriptor.id,
          type: "public-key" as const,
          ...(descriptor.transports === undefined
            ? {}
            : { transports: [...descriptor.transports] }),
        })),
        ...(input.timeout === undefined ? {} : { timeout: Duration.toMillis(input.timeout) }),
      });
    },
    verifyAuthentication: (input) => {
      overrides?.spy?.verifyAuthentication?.push(input);
      return Effect.succeed({
        credentialId: input.response.id,
        newCounter: 1,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        userVerified: true,
        userPresent: true,
        ...overrides?.authenticationVerified,
      });
    },
  });
