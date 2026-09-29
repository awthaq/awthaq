// @awthaq/ports — WebAuthn
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
// Deliberately permissive on user-verification, and explicit about
// user-presence: both `verify*` methods always call the underlying library
// with `requireUserVerification: false` and hand back the real
// `userVerified`/`userPresent` flags observed on a structurally-valid,
// cryptographically-verified response. Enforcing *policy* about whether UV
// was required for a given ceremony (an ordinary registration vs.
// `@awthaq/passkey`'s Conditional Create, whose whole point is
// accepting UP=0/UV=0) is the plugin's job, not this port's — this port
// only ever proves "this response is a real, unforged answer to this exact
// challenge," never "...and the caller's policy about it is satisfied."
// UP is the one flag the caller must choose per registration call
// (`VerifyRegistrationInput.requireUserPresence`, CB-002): a required field,
// so no call site can inherit a silently permissive default. Authentication
// always enforces UP — the wrapped library does so whenever
// `advancedFIDOConfig` is absent, which this port never passes.
//
// The signature counter is likewise the plugin's policy, not the library's
// (CB-004): `verifyAuthentication` hands the library a stored counter of 0,
// which disables its hard throw on every non-zero regression, and reports the
// assertion's own `newCounter` so the plugin can flag or reject a suspected
// clone (`PasskeyConfig.counterAnomalyPolicy`) instead of the ceremony
// collapsing into an opaque `PasskeyVerificationFailed` before that policy
// ever runs.
//
// `PasskeyVerificationFailed` is this port's one failure mode (BEH-EA-129's
// own type signature): a tampered/forged response, a wrong challenge, or a
// wrong origin/rpId (as this port's own caller configured `expectedOrigin`/
// `expectedRpId`) all collapse into it here. `@awthaq/passkey` raises
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  decodeAttestationObject,
  isoBase64URL,
  parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";
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

/**
 * BEH-EA-135: `"none"` is the default; `"indirect"` (HSK-006, the WebAuthn L3
 * enum's remaining member), `"direct"` and `"enterprise"` are explicit opt-in.
 * Conveyance is only a *request* — it verifies nothing by itself (HSK-002):
 * see `VerifiedRegistration.attestationFormat`/`attestationType` and
 * `@awthaq/passkey`'s `attestationPolicy`.
 */
export type AttestationConveyance = "none" | "indirect" | "direct" | "enterprise";

/** TC-003/WebAuthn L3 `PublicKeyCredentialHint`: a UI hint about which kind of authenticator to prompt for. */
export type CeremonyHint = "security-key" | "client-device" | "hybrid";

/** TC-003: the client-extension inputs this port knows to request; anything else the wrapped library types is passed through untouched. */
export interface CeremonyExtensions {
  /** Ask the browser to report whether the credential is discoverable (`clientExtensionResults.credProps.rk`). */
  readonly credProps?: boolean;
}

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
  /** Base64url-encoded `webauthnUserId` handle — a per-user, non-PII handle distinct from the internal user id (BEH-EA-anchored in `@awthaq/passkey`'s own `passkey_credential` table). */
  readonly userId: string;
  readonly userName: string;
  readonly userDisplayName: string;
  readonly excludeCredentials?: ReadonlyArray<CredentialDescriptor>;
  readonly attestation?: AttestationConveyance;
  readonly authenticatorSelection?: AuthenticatorSelection;
  /** TC-003: how long the *browser* lets the ceremony run — always set it explicitly, or the wrapped library's own 60 s default silently applies. */
  readonly timeout?: Duration.Duration;
  readonly hints?: ReadonlyArray<CeremonyHint>;
  readonly extensions?: CeremonyExtensions;
}

export interface VerifyRegistrationInput {
  readonly response: RegistrationResponseJSON;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string | ReadonlyArray<string>;
  readonly expectedRpId: string | ReadonlyArray<string>;
  /**
   * CB-002: whether the authenticator's UP flag MUST be set. Required — each
   * call site chooses (an ordinary registration: `true`; Conditional Create,
   * which Chrome performs without a user gesture: `false`).
   */
  readonly requireUserPresence: boolean;
}

/**
 * HSK-002: what kind of attestation statement backed a registration. `"none"`
 * carries no statement; `"self"` is a `packed` statement signed by the
 * credential's own key (proves nothing about the authenticator model);
 * `"certificate"` carries an attestation certificate chain (`x5c`, `apple`,
 * `tpm`, `fido-u2f`, ...). This port surfaces the class; whether a chain
 * *chains to a trusted root* is the wrapped library's `SettingsService` root
 * store, not something this port decides.
 */
export type AttestationType = "none" | "self" | "certificate";

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
  /** CB-002: the real UP flag. `requireUserPresence: true` already made `false` unreachable; a Conditional Create registration may report `false`. */
  readonly userPresent: boolean;
  /** HSK-002: the attestation statement format (`none`, `packed`, `tpm`, `fido-u2f`, ...) the authenticator answered with. */
  readonly attestationFormat: string;
  readonly attestationType: AttestationType;
}

export interface AuthenticationOptionsInput {
  readonly rpId: string;
  /** Empty/omitted for a fully usernameless, discoverable-credential ceremony (BEH-EA-131). */
  readonly allowCredentials?: ReadonlyArray<CredentialDescriptor>;
  readonly userVerification?: "discouraged" | "preferred" | "required";
  /** Base64url-encoded raw challenge bytes — see this module's own header comment. */
  readonly challenge: string;
  /** TC-003: see `RegistrationOptionsInput.timeout`. */
  readonly timeout?: Duration.Duration;
  readonly hints?: ReadonlyArray<CeremonyHint>;
  readonly extensions?: CeremonyExtensions;
}

/**
 * What the plugin's own store hands back in for the credential an assertion
 * claims to be signed by. Deliberately carries no signature counter: counter
 * regression is the caller's policy (CB-004), see this module's own header.
 */
export interface StoredCredential {
  readonly id: string;
  readonly publicKey: Uint8Array_;
  readonly transports?: ReadonlyArray<string>;
}

export interface VerifyAuthenticationInput {
  readonly response: AuthenticationResponseJSON;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string | ReadonlyArray<string>;
  readonly expectedRpId: string | ReadonlyArray<string>;
  /** CB-003: top-level origins an embedded (cross-origin iframe) assertion may come from. Absent ⇒ every cross-origin assertion that reports a `topOrigin` is rejected. */
  readonly expectedTopOrigin?: string | ReadonlyArray<string>;
  readonly credential: StoredCredential;
}

export interface VerifiedAuthentication {
  readonly credentialId: string;
  readonly newCounter: number;
  readonly credentialDeviceType: "singleDevice" | "multiDevice";
  readonly credentialBackedUp: boolean;
  readonly userVerified: boolean;
  /** CB-002: the real UP flag — always `true` here, since the wrapped library refuses an assertion without it. */
  readonly userPresent: boolean;
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

export class WebAuthn extends Context.Service<WebAuthn, WebAuthnShape>()("awthaq/ports/WebAuthn") {}

const toCredentialDescriptor = (
  descriptor: CredentialDescriptor,
): { id: string; transports?: Array<string> } =>
  descriptor.transports === undefined
    ? { id: descriptor.id }
    : { id: descriptor.id, transports: [...descriptor.transports] };

/**
 * HSK-002: classifies an attestation statement from the (already
 * library-verified) attestation object. `packed` without a certificate chain
 * is self-attestation (the library supports no ECDAA); every other format that
 * is not `none` carries a certificate chain.
 */
const classifyAttestation = (fmt: string, attestationObject: Uint8Array_): AttestationType => {
  if (fmt === "none") return "none";
  if (fmt !== "packed") return "certificate";
  const attStmt = decodeAttestationObject(attestationObject).get("attStmt");
  return attStmt.get("x5c") === undefined ? "self" : "certificate";
};

/** CB-002: the UP flag of a registration's `authData`, read from the library-verified attestation object. */
const attestationUserPresent = (attestationObject: Uint8Array_): boolean =>
  parseAuthenticatorData(decodeAttestationObject(attestationObject).get("authData")).flags.up;

/** CB-002: the UP flag of an assertion's `authenticatorData` (base64url), read after the library verified it. */
const assertionUserPresent = (authenticatorData: string): boolean =>
  parseAuthenticatorData(isoBase64URL.toBuffer(authenticatorData)).flags.up;

export const layerSimpleWebAuthn: Layer.Layer<WebAuthn> = Layer.succeed(
  WebAuthn,
  WebAuthn.of({
    registrationOptions: (input) =>
      Effect.promise(async () => {
        const options = await generateRegistrationOptions({
          rpID: input.rpId,
          rpName: input.rpName,
          challenge: isoBase64URL.toBuffer(input.challenge),
          userID: isoBase64URL.toBuffer(input.userId),
          userName: input.userName,
          userDisplayName: input.userDisplayName,
          // HSK-006: the library's own enum lacks `"indirect"`; it is set on
          // the returned options below instead.
          attestationType:
            input.attestation === undefined || input.attestation === "indirect"
              ? "none"
              : input.attestation,
          ...(input.excludeCredentials === undefined
            ? {}
            : { excludeCredentials: input.excludeCredentials.map(toCredentialDescriptor) }),
          ...(input.authenticatorSelection === undefined
            ? {}
            : { authenticatorSelection: input.authenticatorSelection }),
          ...(input.timeout === undefined ? {} : { timeout: Duration.toMillis(input.timeout) }),
          ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
        });
        // The library returns `extensions: undefined` when none apply; an
        // absent member and an `undefined` one are different things to a
        // strict contract schema (AVS-003), so it is left out instead.
        const { extensions, ...rest } = options;
        return {
          ...rest,
          ...(extensions === undefined ? {} : { extensions }),
          ...(input.attestation === "indirect" ? { attestation: "indirect" as const } : {}),
          // `hints` is set here rather than through the library's
          // `preferredAuthenticatorType`, which would also rewrite
          // `authenticatorAttachment` behind the caller's back.
          ...(input.hints === undefined ? {} : { hints: [...input.hints] }),
        };
      }),

    verifyRegistration: (input) =>
      Effect.tryPromise({
        try: () =>
          verifyRegistrationResponse({
            response: input.response,
            expectedChallenge: input.expectedChallenge,
            expectedOrigin: toMutable(input.expectedOrigin),
            expectedRPID: toMutable(input.expectedRpId),
            requireUserPresence: input.requireUserPresence,
            requireUserVerification: false,
          }),
        catch: (cause) =>
          new PasskeyVerificationFailed({
            message: `awthaq: passkey registration verification failed: ${String(cause)}`,
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
                userPresent: attestationUserPresent(result.registrationInfo.attestationObject),
                attestationFormat: result.registrationInfo.fmt,
                attestationType: classifyAttestation(
                  result.registrationInfo.fmt,
                  result.registrationInfo.attestationObject,
                ),
              })
            : Effect.fail(
                new PasskeyVerificationFailed({
                  message: "awthaq: passkey registration was not verified",
                }),
              ),
        ),
      ),

    authenticationOptions: (input) =>
      Effect.promise(async () => {
        const options = await generateAuthenticationOptions({
          rpID: input.rpId,
          challenge: isoBase64URL.toBuffer(input.challenge),
          ...(input.allowCredentials === undefined
            ? {}
            : { allowCredentials: input.allowCredentials.map(toCredentialDescriptor) }),
          ...(input.userVerification === undefined
            ? {}
            : { userVerification: input.userVerification }),
          ...(input.timeout === undefined ? {} : { timeout: Duration.toMillis(input.timeout) }),
          ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
        });
        const { extensions, ...rest } = options;
        return {
          ...rest,
          ...(extensions === undefined ? {} : { extensions }),
          ...(input.hints === undefined ? {} : { hints: [...input.hints] }),
        };
      }),

    verifyAuthentication: (input) =>
      Effect.tryPromise({
        try: () =>
          verifyAuthenticationResponse({
            response: input.response,
            expectedChallenge: input.expectedChallenge,
            expectedOrigin: toMutable(input.expectedOrigin),
            expectedRPID: toMutable(input.expectedRpId),
            ...(input.expectedTopOrigin === undefined
              ? {}
              : { expectedTopOrigin: toMutable(input.expectedTopOrigin) }),
            credential: {
              id: input.credential.id,
              publicKey: input.credential.publicKey,
              // CB-004: 0 disables the library's hard throw on a counter
              // regression (`(counter > 0 || stored > 0) && counter <= stored`);
              // the plugin applies its own `counterAnomalyPolicy` to `newCounter`.
              counter: 0,
              ...(input.credential.transports === undefined
                ? {}
                : { transports: [...input.credential.transports] }),
            },
            requireUserVerification: false,
          }),
        catch: (cause) =>
          new PasskeyVerificationFailed({
            message: `awthaq: passkey authentication verification failed: ${String(cause)}`,
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
                userPresent: assertionUserPresent(input.response.response.authenticatorData),
              })
            : Effect.fail(
                new PasskeyVerificationFailed({
                  message: "awthaq: passkey authentication was not verified",
                }),
              ),
        ),
      ),
  }),
);
