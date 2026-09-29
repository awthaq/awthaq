// @awthaq/client — PasskeyClient
//
// BPAS-002 (.issues/high) / wayfinder ticket 32
// (browser-webauthn-ux-layer): the browser-side platform-authenticator
// layer BPAS-002's own Summary found entirely absent — feature detection
// before rendering a "Sign in with Face ID" button, conditional-mediation
// autofill with its mandatory button fallback, and a typed error taxonomy
// (see `PasskeyClientError.ts`) instead of a raw `NotAllowedError`/
// `InvalidStateError` reaching application code.
//
// Wraps `@simplewebauthn/browser` v14 (already the server-side pin
// `@awthaq/ports`' own `WebAuthn.ts` uses, matching the split
// `research/06-webauthn-passkeys.md` names) — `startRegistration`/
// `startAuthentication` already classify a ceremony's own failure into a
// `WebAuthnError` internally; this module never re-implements that, only
// maps the closed set of codes it cares about (`PasskeyClientError.ts`).
//
// **Not a subpath export.** Wayfinder ticket 32's own decision text
// described this as a new `@awthaq/client/passkey` subpath package export
// (a `"./*"` entry in `packages/client/package.json`). No package in this
// repository actually uses that convention — every one of them (including
// `@awthaq/react`'s own `AuthCore`/`SubjectContract` imports from
// `@awthaq/api`) re-exports its modules as named namespaces off the
// package's single `"."` root export, consumed as
// `import { X } from "@awthaq/pkg"`. This module follows that real,
// working convention instead: `PasskeyClient`/`PasskeyClientError`, barrel
// re-exported from this package's own `index.ts`, exactly like
// `AuthClient` already is.
//
// **Signals (TC-004/BPAS-006).** The WebAuthn Signals API lets the server tell
// the browser's credential manager what it currently accepts, so a deleted
// passkey stops being offered. Every signal here is fire-and-forget: an
// unsupported browser, a failed `GET /passkey/signals`, or a browser-side
// rejection is swallowed and can never change a ceremony's outcome or error
// type. `allAcceptedCredentials` is sent after a delete and after every
// successful sign-in (which also prunes stale credentials for the common
// case); `currentUserDetails` is exposed for an app to call after a profile
// change. `unknownCredential` is only ever sent from the *signed-in*
// `reauthenticate` ceremony, when the server reports the presented credential
// is not the caller's own — never from the anonymous sign-in, whose uniform
// `InvalidCredentials` (BEH-EA-136) must not become an existence oracle, and
// where a bad signature would otherwise get a perfectly valid passkey hidden.
//
// **Takes an already-built client slice, not a connection to build one
// itself.** `passkeyClient(client)` accepts the three `PasskeyApi` group
// clients an app has already constructed via `HttpApiClient.make`/`group`
// against its own composed contract — the same "composition-agnostic
// helper layered on top of a caller-supplied client, not a second client"
// discipline `AuthClient.ts`'s own `SessionStore`/`toPromiseFacade` already
// follow. This also means every domain error this module's methods can
// fail with (`PasskeyReauthRequired`, `PasskeyChallengeInvalid`, …) is
// *inferred* from the real `PasskeyApi` contract via `HttpApiClient.ForApi`
// rather than hand-duplicated here — the same "never re-declare a real
// API's generics independently" discipline `AuthClient.ts`'s own header
// comment documents for `make`/`group`/`endpoint`. `PasskeyClientShape` is
// therefore derived from `passkeyClient`'s own return type below, not
// declared ahead of it.
import type { Api, SessionContract } from "@awthaq/api";
import type { Hooks } from "@awthaq/core";
import type { PasskeyApi } from "@awthaq/passkey";
import {
  browserSupportsWebAuthn,
  getBrowserCapabilities,
  sendSignal,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type SendSignalAllAcceptedCredentialsOpts,
  type SendSignalCurrentUserDetailsOpts,
  type SendSignalUnknownCredentialOpts,
} from "@simplewebauthn/browser";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as PasskeyClientError from "./PasskeyClientError.ts";

/** The four `PasskeyApi` group clients this module needs — whatever an app already built against its own composed contract, never fewer. */
export type PasskeyApiClient = Pick<
  HttpApiClient.ForApi<typeof PasskeyApi.PasskeyApi>,
  "passkey" | "passkey.authenticate" | "passkey.credentials" | "passkey.reauthenticate"
>;

export type PasskeyClientCapabilitySupport = "supported" | "unsupported" | "unknown";

/**
 * BPAS-002's own `getClientCapabilities` ask, sourced from
 * `@simplewebauthn/browser`'s own `getBrowserCapabilities()` — which
 * itself already implements the "browser reports unknown but an
 * alternative WebAuthn API can settle it" fallback research/06:31 names,
 * so this module does not reimplement `PublicKeyCredential.
 * getClientCapabilities()`/`isConditionalMediationAvailable()`/
 * `isUserVerifyingPlatformAuthenticatorAvailable()` fallback logic by
 * hand. The real three-state `"unknown"` (browser may or may not support
 * it) is preserved rather than collapsed into a boolean — losing that
 * distinction would tell a caller "not available" when the honest answer
 * is "try it and see."
 */
export interface PasskeyClientCapabilities {
  readonly conditionalCreate: PasskeyClientCapabilitySupport;
  readonly conditionalGet: PasskeyClientCapabilitySupport;
  readonly hybridTransport: PasskeyClientCapabilitySupport;
  readonly passkeyPlatformAuthenticator: PasskeyClientCapabilitySupport;
  readonly userVerifyingPlatformAuthenticator: PasskeyClientCapabilitySupport;
  /** TC-004: whether this client will act on `allAcceptedCredentials`/`currentUserDetails`/`unknownCredential` signals. */
  readonly signalAllAcceptedCredentials: PasskeyClientCapabilitySupport;
  readonly signalCurrentUserDetails: PasskeyClientCapabilitySupport;
  readonly signalUnknownCredential: PasskeyClientCapabilitySupport;
  /** Whether the browser can use one RP ID's passkey across related origins. */
  readonly relatedOrigins: PasskeyClientCapabilitySupport;
}

/** `authenticate()`'s own wire session — `@awthaq/api`'s `SessionContract.SessionDto`, not a parallel type (mirrors `AuthClient.ts`'s own `Session` alias). */
export type PasskeySession = SessionContract.SessionDto;

/**
 * Named here (not just inline in `authenticate`'s inferred return type) so
 * this module's own compiled declaration file has a portable path to it —
 * `authenticateVerify`'s real contract declares it, the same uniform
 * "wrong credential" `@awthaq/password`'s own `signIn` already answers for
 * an unrecognized identifier (BEH-EA-136-style enumeration safety).
 */
export type PasskeyInvalidCredentials = Api.InvalidCredentials;
/**
 * `authenticate`'s error union mentions the second-factor gate a
 * `BeforeSessionIssue` tap raises. Naming it here keeps `@awthaq/core` in scope
 * for declaration emit (otherwise the published `.d.ts` points into core's
 * `src/`, which attw rejects); type-only, erased at runtime.
 */
export type PasskeyTwoFactorRequired = Hooks.TwoFactorRequired;

const UNSUPPORTED_CAPABILITIES: PasskeyClientCapabilities = {
  conditionalCreate: "unsupported",
  conditionalGet: "unsupported",
  hybridTransport: "unsupported",
  passkeyPlatformAuthenticator: "unsupported",
  userVerifyingPlatformAuthenticator: "unsupported",
  signalAllAcceptedCredentials: "unsupported",
  signalCurrentUserDetails: "unsupported",
  signalUnknownCredential: "unsupported",
  relatedOrigins: "unsupported",
};

// ---------------------------------------------------------------------------
// Wire shape conversions — the two `Passkey.ts`-side schemas capture only
// the fields this plugin's own `WebAuthn` port reads (see `PasskeyApi.ts`'s
// own header comment); these are the client-side mirror of that same
// narrowing, picked off `@simplewebauthn/browser`'s richer response.
// ---------------------------------------------------------------------------

const toRegistrationCredentialInput = (
  credential: RegistrationResponseJSON,
): PasskeyApi.RegistrationCredentialInput => ({
  id: credential.id,
  rawId: credential.rawId,
  response: {
    clientDataJSON: credential.response.clientDataJSON,
    attestationObject: credential.response.attestationObject,
    // HSK-003: carry the browser-reported transports to the server.
    ...(credential.response.transports === undefined
      ? {}
      : { transports: credential.response.transports }),
  },
  type: "public-key",
});

const toAuthenticationCredentialInput = (
  credential: AuthenticationResponseJSON,
): PasskeyApi.AuthenticationCredentialInput => ({
  id: credential.id,
  rawId: credential.rawId,
  response: {
    clientDataJSON: credential.response.clientDataJSON,
    authenticatorData: credential.response.authenticatorData,
    signature: credential.response.signature,
    ...(credential.response.userHandle === undefined
      ? {}
      : { userHandle: credential.response.userHandle }),
  },
  type: "public-key",
});

// ---------------------------------------------------------------------------
// registerPasskey / registerPasskeyConditional
// ---------------------------------------------------------------------------

const registerPasskey = (client: PasskeyApiClient) =>
  Effect.gen(function* () {
    if (!browserSupportsWebAuthn()) {
      return yield* new PasskeyClientError.PasskeyNotSupported();
    }
    const optionsJSON = yield* client.passkey.registerOptions();
    const credential = yield* Effect.tryPromise({
      try: () => startRegistration({ optionsJSON }),
      catch: PasskeyClientError.fromCeremonyFailure,
    });
    return yield* client.passkey.registerVerify({
      payload: { credential: toRegistrationCredentialInput(credential) },
    });
  });

/**
 * BPAS-002/`research/06-webauthn-passkeys.md:195`: conditional (silent)
 * passkey creation is opportunistic background UX, not a user-initiated
 * action — a ceremony failure here (declined, no eligible authenticator, a
 * malformed options payload) resolves to `void` exactly like a no-op,
 * never surfacing error UI. Only `registerOptionsConditional`'s own
 * declared errors (`PasskeyConditionalCreateDisabled`/
 * `PasskeyReauthRequired` — real, composition-level signals about whether
 * this call should have been made at all) still propagate.
 */
const registerPasskeyConditional = (client: PasskeyApiClient) =>
  Effect.gen(function* () {
    if (!browserSupportsWebAuthn()) return;
    const optionsJSON = yield* client.passkey.registerOptionsConditional();
    yield* Effect.gen(function* () {
      const credential = yield* Effect.tryPromise({
        try: () => startRegistration({ optionsJSON, useAutoRegister: true }),
        catch: PasskeyClientError.fromCeremonyFailure,
      });
      yield* client.passkey.registerVerify({
        // WPS-003: names the ceremony so the server consumes the conditional
        // challenge scope and leaves any modal one alone.
        payload: { credential: toRegistrationCredentialInput(credential), ceremony: "conditional" },
      });
    }).pipe(Effect.catch(() => Effect.void));
  });

// ---------------------------------------------------------------------------
// authenticate — both the button-triggered and conditional-UI (autofill)
// ceremonies share this one method, per `research/06:85`'s explicit
// "do not ship conditional UI exclusively" warning: `autoFill` selects
// which ceremony runs, so an app is structurally required to wire up the
// non-autofill path too, never left to assume autofill alone suffices.
// ---------------------------------------------------------------------------

const authenticate = (
  client: PasskeyApiClient,
  options?: { readonly autoFill?: boolean; readonly email?: string },
) =>
  Effect.gen(function* () {
    if (!browserSupportsWebAuthn()) {
      return yield* new PasskeyClientError.PasskeyNotSupported();
    }
    const useBrowserAutofill = options?.autoFill ?? false;
    const { ceremonyId, options: optionsJSON } = yield* client[
      "passkey.authenticate"
    ].authenticateOptions({
      payload: { ...(options?.email === undefined ? {} : { email: options.email }) },
    });
    const credential = yield* Effect.tryPromise({
      try: () => startAuthentication({ optionsJSON, useBrowserAutofill }),
      catch: PasskeyClientError.fromCeremonyFailure,
    });
    const session = yield* client["passkey.authenticate"].authenticateVerify({
      payload: { ceremonyId, credential: toAuthenticationCredentialInput(credential) },
    });
    // TC-004: now signed in, tell the credential manager what this account
    // accepts — prunes any passkey that was since deleted server-side.
    yield* signalAcceptedCredentials(client);
    return session;
  });

// ---------------------------------------------------------------------------
// reauthenticate — the signed-in step-up ceremony (`passkey.reauthenticate`).
// ---------------------------------------------------------------------------

const reauthenticate = (client: PasskeyApiClient) =>
  Effect.gen(function* () {
    if (!browserSupportsWebAuthn()) {
      return yield* new PasskeyClientError.PasskeyNotSupported();
    }
    const optionsJSON = yield* client["passkey.reauthenticate"].reauthenticateOptions();
    const credential = yield* Effect.tryPromise({
      try: () => startAuthentication({ optionsJSON }),
      catch: PasskeyClientError.fromCeremonyFailure,
    });
    yield* client["passkey.reauthenticate"]
      .reauthenticateVerify({
        payload: { credential: toAuthenticationCredentialInput(credential) },
      })
      .pipe(
        // TC-004 (decision B): the caller is authenticated, so "this
        // credential is not yours / not known" is safe to act on — tell the
        // credential manager to stop offering it. The error still propagates.
        Effect.tapErrorTag("PasskeyCredentialNotFound", () =>
          optionsJSON.rpId === undefined
            ? Effect.void
            : sendSignalSafely({
                signalName: "unknownCredential",
                rpID: optionsJSON.rpId,
                credentialID: credential.id,
              }),
        ),
      );
  });

// ---------------------------------------------------------------------------
// Signals — fire-and-forget (see this module's own header).
// ---------------------------------------------------------------------------

/** Never fails and never throws: an unsupported browser or a rejected signal is simply dropped. */
const sendSignalSafely = (
  options:
    | SendSignalUnknownCredentialOpts
    | SendSignalAllAcceptedCredentialsOpts
    | SendSignalCurrentUserDetailsOpts,
) => Effect.promise(() => sendSignal(options).catch(() => undefined));

/** Fetches what the server accepts (`GET /passkey/signals`, authenticated) and sends `allAcceptedCredentials`. Never fails. */
const signalAcceptedCredentials = (client: PasskeyApiClient) =>
  client["passkey.credentials"].signals().pipe(
    Effect.flatMap((signals) =>
      sendSignalSafely({
        signalName: "allAcceptedCredentials",
        rpID: signals.rpId,
        userID: signals.userId,
        allAcceptedCredentialIDs: [...signals.allAcceptedCredentialIds],
      }),
    ),
    Effect.ignore,
  );

/** Sends `currentUserDetails` — call after the user changes their account name. Never fails. */
const signalCurrentUserDetails = (client: PasskeyApiClient) =>
  client["passkey.credentials"].signals().pipe(
    Effect.flatMap((signals) =>
      sendSignalSafely({
        signalName: "currentUserDetails",
        rpID: signals.rpId,
        userID: signals.userId,
        userName: signals.name,
        userDisplayName: signals.displayName,
      }),
    ),
    Effect.ignore,
  );

// ---------------------------------------------------------------------------
// Credential management — thin pass-throughs, no ceremony involved.
// ---------------------------------------------------------------------------

const listPasskeys = (client: PasskeyApiClient) => client["passkey.credentials"].listCredentials();

const renamePasskey = (client: PasskeyApiClient, id: string, name: string) =>
  client["passkey.credentials"].renameCredential({ params: { id }, payload: { name } });

const deletePasskey = (client: PasskeyApiClient, id: string) =>
  client["passkey.credentials"]
    .removeCredential({ params: { id } })
    // TC-004: a deleted passkey must stop being offered by the credential manager.
    .pipe(Effect.tap(() => signalAcceptedCredentials(client)));

/**
 * Never fails — every capability check degrades to `"unsupported"` on a
 * runtime with no `PublicKeyCredential` global at all (SSR, a non-WebAuthn
 * browser) rather than throwing, so a caller can gate "Sign in with Face
 * ID" button rendering without a dead-end UX.
 */
const getClientCapabilities: Effect.Effect<PasskeyClientCapabilities> = Effect.promise(async () => {
  if (!browserSupportsWebAuthn()) return UNSUPPORTED_CAPABILITIES;
  const capabilities = await getBrowserCapabilities();
  return {
    conditionalCreate: capabilities.conditionalCreate,
    conditionalGet: capabilities.conditionalGet,
    hybridTransport: capabilities.hybridTransport,
    passkeyPlatformAuthenticator: capabilities.passkeyPlatformAuthenticator,
    userVerifyingPlatformAuthenticator: capabilities.userVerifyingPlatformAuthenticator,
    signalAllAcceptedCredentials: capabilities.signalAllAcceptedCredentials,
    signalCurrentUserDetails: capabilities.signalCurrentUserDetails,
    signalUnknownCredential: capabilities.signalUnknownCredential,
    relatedOrigins: capabilities.relatedOrigins,
  };
});

export const passkeyClient = (client: PasskeyApiClient) => ({
  registerPasskey: () => registerPasskey(client),
  registerPasskeyConditional: () => registerPasskeyConditional(client),
  authenticate: (options?: { readonly autoFill?: boolean; readonly email?: string }) =>
    authenticate(client, options),
  reauthenticate: () => reauthenticate(client),
  listPasskeys: () => listPasskeys(client),
  renamePasskey: (id: string, name: string) => renamePasskey(client, id, name),
  deletePasskey: (id: string) => deletePasskey(client, id),
  signalCurrentUserDetails: () => signalCurrentUserDetails(client),
  getClientCapabilities: () => getClientCapabilities,
});

export type PasskeyClientShape = ReturnType<typeof passkeyClient>;
