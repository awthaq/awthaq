// Shared test support for `Passkey.test.ts` and `AuthHttp.test.ts` — the
// same "one fixtures module per stratum" pattern
// `packages/ports/test/webauthnFixtures.ts` establishes for the port level.
// A mocked `WebAuthn` whose `verifyRegistration`/`verifyAuthentication`
// always succeed with a canned result, ignoring the actual
// attestation/assertion bytes entirely: `clientDataJSON` is always real
// (this plugin decodes it itself, before ever calling the port), only the
// cryptographic verification behind it is stubbed.
import { WebAuthn } from "@awthaq/ports";
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
}): string =>
  Encoding.encodeBase64Url(
    JSON.stringify({ type: input.type, challenge: input.challenge, origin: input.origin }),
  );

const OptionsChallengeSchema = Schema.Struct({ challenge: Schema.String });

/**
 * `registerOptions`/`authenticateOptions` return `unknown` (`PasskeyApi.ts`'s
 * own header comment: the browser's own WebAuthn dictionary shape, not this
 * plugin's to own) — `mockWebAuthn` below echoes the real `ChallengeStore`
 * value straight through as `.challenge`, so this pulls it back out to
 * build a client response that actually matches what's stored.
 */
export const extractChallenge = (options: unknown): string => {
  const decoded = Schema.decodeUnknownOption(OptionsChallengeSchema)(options);
  if (Option.isNone(decoded)) throw new Error("test fixture: mocked options missing challenge");
  return decoded.value.challenge;
};

export const mockWebAuthn = (overrides?: {
  readonly registrationVerified?: Partial<WebAuthn.VerifiedRegistration>;
  readonly authenticationVerified?: Partial<WebAuthn.VerifiedAuthentication>;
}): Layer.Layer<WebAuthn.WebAuthn> =>
  Layer.mock(WebAuthn.WebAuthn, {
    // Echoes the real `challenge` this plugin's own `ChallengeStore` issued
    // back through — the mock only stubs out the cryptographic
    // verification below, never the plugin's own challenge bookkeeping, so
    // a test must be able to read the real value back out to build a
    // matching `clientDataJSON`.
    registrationOptions: (input) =>
      Effect.succeed({
        rp: { id: input.rpId, name: input.rpName },
        user: { id: input.userId, name: input.userName, displayName: input.userDisplayName },
        challenge: input.challenge,
        pubKeyCredParams: [],
      }),
    verifyRegistration: () =>
      Effect.succeed({
        credentialId: "cred-mock-1",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        aaguid: "00000000-0000-0000-0000-000000000000",
        transports: [],
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        userVerified: true,
        ...overrides?.registrationVerified,
      }),
    authenticationOptions: (input) => Effect.succeed({ challenge: input.challenge }),
    verifyAuthentication: () =>
      Effect.succeed({
        credentialId: "cred-mock-1",
        newCounter: 1,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        userVerified: true,
        ...overrides?.authenticationVerified,
      }),
  });
