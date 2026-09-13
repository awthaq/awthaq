// @effect-auth/ports — WebAuthn
//
// spec/behaviors/17-passkey.md, BEH-EA-129. Wraps `@simplewebauthn/server`
// (a WebAuthn L3 spec editor's own library) — this module is exactly the
// "glue" layer research/06-webauthn-passkeys.md warns is where real
// WebAuthn CVEs (CVE-2026-30964, YSA-2026-02, CVE-2026-47841) actually
// land: wrong origin, wrong session, wrong user — never broken
// cryptography. The CBOR/COSE parsing, attestation verification, and
// signature checking all stay inside the wrapped library; this module
// never reimplements any of it (BEH-EA-129's own REQUIREMENT block).
//
// Deliberately permissive on user-presence/user-verification: both
// `verify*` methods always call the underlying library with
// `requireUserPresence: false, requireUserVerification: false` and hand
// back the real `userVerified` flag observed on a structurally-valid,
// cryptographically-verified response. Enforcing *policy* about whether UV
// was required for a given ceremony (an ordinary registration vs.
// `@effect-auth/passkey`'s Conditional Create, whose whole point is
// accepting UP=0/UV=0) is the plugin's job, not this port's — this port
// only ever proves "this response is a real, unforged answer to this exact
// challenge," never "...and the caller's policy about it is satisfied."
//
// `PasskeyVerificationFailed` is this port's one failure mode (BEH-EA-129's
// own type signature): a tampered/forged response, a wrong challenge, or a
// wrong origin/rpId (as this port's own caller configured `expectedOrigin`/
// `expectedRpId`) all collapse into it here. `@effect-auth/passkey` raises
// the other, more specific BEH-EA-136 errors (`PasskeyChallengeInvalid`,
// `PasskeyOriginMismatch`, `PasskeyRpIdMismatch`, `PasskeyUserVerificationRequired`,
// ...) from checks it runs *before* ever calling this port, using facts
// already available to it (its own `ChallengeStore`, and the request's own
// actual origin) rather than by distinguishing this port's own failure.
//
// A `string` `challenge`/`userId` here is always the base64url *encoding of
// raw bytes*, decoded back to a `Uint8Array` before being handed to
// `@simplewebauthn/server` — never passed through as a bare string.
// `generateRegistrationOptions`/`generateAuthenticationOptions` treat a
// *string* `challenge` as UTF-8 text to re-encode (`isoUint8Array.fromUTF8String`
// then `isoBase64URL.fromBuffer`), which would silently double-encode an
// already-base64url value and break the invariant that the challenge
// embedded in the returned options round-trips byte-for-byte back to
// whatever the caller's own `ChallengeStore` issued; a string `userID` is
// rejected outright by the library. Decoding first with `isoBase64URL.toBuffer`
// and passing real bytes sidesteps both.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  Uint8Array_,
} from "@simplewebauthn/server";

/** `string | string[]`, matching `@simplewebauthn/server`'s own option shape exactly — this port's own callers pass a `ReadonlyArray`, converted here rather than via a type assertion. */
const toMutable = (value: string | ReadonlyArray<string>): string | Array<string> =>
  typeof value === "string" ? value : [...value];

/** BEH-EA-136: this port's one failure mode — see this module's own header comment. */
export class PasskeyVerificationFailed extends Data.TaggedError("PasskeyVerificationFailed")<{
  readonly message: string;
}> {}

/** BEH-EA-135: `"none"` is the default; `"direct"`/`"enterprise"` are explicit opt-in. */
export type AttestationConveyance = "none" | "direct" | "enterprise";

export interface AuthenticatorSelection {
  readonly residentKey?: "discouraged" | "preferred" | "required";
  readonly userVerification?: "discouraged" | "preferred" | "required";
  readonly authenticatorAttachment?: "platform" | "cross-platform";
}

/** One entry of `excludeCredentials`/`allowCredentials` — a credential id the ceremony already knows about. */
export interface CredentialDescriptor {
  readonly id: string;
  readonly transports?: ReadonlyArray<string>;
}

export interface RegistrationOptionsInput {
  readonly rpId: string;
  readonly rpName: string;
  /** Base64url-encoded raw challenge bytes — see this module's own header comment. */
  readonly challenge: string;
  /** Base64url-encoded `webauthnUserId` handle — a per-user, non-PII handle distinct from the internal user id (BEH-EA-anchored in `@effect-auth/passkey`'s own `passkey_credential` table). */
  readonly userId: string;
  readonly userName: string;
  readonly userDisplayName: string;
  readonly excludeCredentials?: ReadonlyArray<CredentialDescriptor>;
  readonly attestation?: AttestationConveyance;
  readonly authenticatorSelection?: AuthenticatorSelection;
}

export interface VerifyRegistrationInput {
  readonly response: RegistrationResponseJSON;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string | ReadonlyArray<string>;
  readonly expectedRpId: string | ReadonlyArray<string>;
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: Uint8Array_;
  readonly counter: number;
  readonly aaguid: string;
  readonly transports: ReadonlyArray<string>;
  readonly credentialDeviceType: "singleDevice" | "multiDevice";
  readonly credentialBackedUp: boolean;
  /** The real UV flag from a verified response — the plugin, not this port, decides whether this ceremony required it to be `true`. */
  readonly userVerified: boolean;
}

export interface AuthenticationOptionsInput {
  readonly rpId: string;
  /** Empty/omitted for a fully usernameless, discoverable-credential ceremony (BEH-EA-131). */
  readonly allowCredentials?: ReadonlyArray<CredentialDescriptor>;
  readonly userVerification?: "discouraged" | "preferred" | "required";
  /** Base64url-encoded raw challenge bytes — see this module's own header comment. */
  readonly challenge: string;
}

/** What the plugin's own store hands back in for the credential an assertion claims to be signed by. */
export interface StoredCredential {
  readonly id: string;
  readonly publicKey: Uint8Array_;
  readonly counter: number;
  readonly transports?: ReadonlyArray<string>;
}

export interface VerifyAuthenticationInput {
  readonly response: AuthenticationResponseJSON;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string | ReadonlyArray<string>;
  readonly expectedRpId: string | ReadonlyArray<string>;
  readonly credential: StoredCredential;
}

export interface VerifiedAuthentication {
  readonly credentialId: string;
  readonly newCounter: number;
  readonly credentialDeviceType: "singleDevice" | "multiDevice";
  readonly credentialBackedUp: boolean;
  readonly userVerified: boolean;
}

export interface WebAuthnShape {
  /** BEH-EA-130: mints the options `navigator.credentials.create(...)` needs; the caller supplies the challenge (its own `ChallengeStore` already issued it). */
  readonly registrationOptions: (
    input: RegistrationOptionsInput,
  ) => Effect.Effect<PublicKeyCredentialCreationOptionsJSON>;
  /** BEH-EA-130/133: verifies a registration response is a real, unforged answer to `expectedChallenge` from `expectedOrigin`/`expectedRpId` — never persists anything itself. */
  readonly verifyRegistration: (
    input: VerifyRegistrationInput,
  ) => Effect.Effect<VerifiedRegistration, PasskeyVerificationFailed>;
  /** BEH-EA-131: mints the options `navigator.credentials.get(...)` needs, for either the username-first (`allowCredentials` populated) or usernameless (`allowCredentials: []`) path. */
  readonly authenticationOptions: (
    input: AuthenticationOptionsInput,
  ) => Effect.Effect<PublicKeyCredentialRequestOptionsJSON>;
  /** BEH-EA-131/133: verifies an authentication assertion against the caller-supplied stored credential's own public key and counter. */
  readonly verifyAuthentication: (
    input: VerifyAuthenticationInput,
  ) => Effect.Effect<VerifiedAuthentication, PasskeyVerificationFailed>;
}

export class WebAuthn extends Context.Service<WebAuthn, WebAuthnShape>()(
  "effect-auth/ports/WebAuthn",
) {}

const toCredentialDescriptor = (
  descriptor: CredentialDescriptor,
): { id: string; transports?: Array<string> } =>
  descriptor.transports === undefined
    ? { id: descriptor.id }
    : { id: descriptor.id, transports: [...descriptor.transports] };

export const layerSimpleWebAuthn: Layer.Layer<WebAuthn> = Layer.succeed(
  WebAuthn,
  WebAuthn.of({
    registrationOptions: (input) =>
      Effect.promise(() =>
        generateRegistrationOptions({
          rpID: input.rpId,
          rpName: input.rpName,
          challenge: isoBase64URL.toBuffer(input.challenge),
          userID: isoBase64URL.toBuffer(input.userId),
          userName: input.userName,
          userDisplayName: input.userDisplayName,
          attestationType: input.attestation ?? "none",
          ...(input.excludeCredentials === undefined
            ? {}
            : { excludeCredentials: input.excludeCredentials.map(toCredentialDescriptor) }),
          ...(input.authenticatorSelection === undefined
            ? {}
            : { authenticatorSelection: input.authenticatorSelection }),
        }),
      ),

    verifyRegistration: (input) =>
      Effect.tryPromise({
        try: () =>
          verifyRegistrationResponse({
            response: input.response,
            expectedChallenge: input.expectedChallenge,
            expectedOrigin: toMutable(input.expectedOrigin),
            expectedRPID: toMutable(input.expectedRpId),
            requireUserPresence: false,
            requireUserVerification: false,
          }),
        catch: (cause) =>
          new PasskeyVerificationFailed({
            message: `effect-auth: passkey registration verification failed: ${String(cause)}`,
          }),
      }).pipe(
        Effect.flatMap((result) =>
          result.verified
            ? Effect.succeed({
                credentialId: result.registrationInfo.credential.id,
                publicKey: result.registrationInfo.credential.publicKey,
                counter: result.registrationInfo.credential.counter,
                aaguid: result.registrationInfo.aaguid,
                transports: result.registrationInfo.credential.transports ?? [],
                credentialDeviceType: result.registrationInfo.credentialDeviceType,
                credentialBackedUp: result.registrationInfo.credentialBackedUp,
                userVerified: result.registrationInfo.userVerified,
              })
            : Effect.fail(
                new PasskeyVerificationFailed({
                  message: "effect-auth: passkey registration was not verified",
                }),
              ),
        ),
      ),

    authenticationOptions: (input) =>
      Effect.promise(() =>
        generateAuthenticationOptions({
          rpID: input.rpId,
          challenge: isoBase64URL.toBuffer(input.challenge),
          ...(input.allowCredentials === undefined
            ? {}
            : { allowCredentials: input.allowCredentials.map(toCredentialDescriptor) }),
          ...(input.userVerification === undefined
            ? {}
            : { userVerification: input.userVerification }),
        }),
      ),

    verifyAuthentication: (input) =>
      Effect.tryPromise({
        try: () =>
          verifyAuthenticationResponse({
            response: input.response,
            expectedChallenge: input.expectedChallenge,
            expectedOrigin: toMutable(input.expectedOrigin),
            expectedRPID: toMutable(input.expectedRpId),
            credential: {
              id: input.credential.id,
              publicKey: input.credential.publicKey,
              counter: input.credential.counter,
              ...(input.credential.transports === undefined
                ? {}
                : { transports: [...input.credential.transports] }),
            },
            requireUserVerification: false,
          }),
        catch: (cause) =>
          new PasskeyVerificationFailed({
            message: `effect-auth: passkey authentication verification failed: ${String(cause)}`,
          }),
      }).pipe(
        Effect.flatMap((result) =>
          result.verified
            ? Effect.succeed({
                credentialId: result.authenticationInfo.credentialID,
                newCounter: result.authenticationInfo.newCounter,
                credentialDeviceType: result.authenticationInfo.credentialDeviceType,
                credentialBackedUp: result.authenticationInfo.credentialBackedUp,
                userVerified: result.authenticationInfo.userVerified,
              })
            : Effect.fail(
                new PasskeyVerificationFailed({
                  message: "effect-auth: passkey authentication was not verified",
                }),
              ),
        ),
      ),
  }),
);
