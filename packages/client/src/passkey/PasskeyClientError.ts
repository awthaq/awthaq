// @awthaq/client — PasskeyClientError
//
// BPAS-002 (.issues/high) / wayfinder ticket 32 (browser-webauthn-ux-layer):
// a typed taxonomy over @simplewebauthn/browser's own already-classified
// `WebAuthnError` (produced internally by `startRegistration`/
// `startAuthentication` via that library's own
// `identifyRegistrationError`/`identifyAuthenticationError`) so a caller
// never has to hand-parse a raw `NotAllowedError`/`InvalidStateError`
// `DOMException` — the concrete gap BPAS-002's own Summary named ("maps
// raw NotAllowedError/InvalidStateError into distinct, human cases").
//
// `Data.TaggedError`, not `Schema.TaggedError`: these never cross the
// wire — unlike `@awthaq/passkey`'s own `PasskeyApi.ts` errors, which are
// real HTTP response bodies with a declared status code — so there's no
// schema/status to declare, the same in-process-only distinction
// `@awthaq/oauth`'s `OAuthTokenAccess.ts` already draws for its own
// `OAuthTokenUnavailable`/`OAuthRefreshFailed`.
import { WebAuthnError, type WebAuthnErrorCode } from "@simplewebauthn/browser";
import * as Data from "effect/Data";

/** The user dismissed the platform UI, or the ceremony was otherwise aborted (`ERROR_CEREMONY_ABORTED`, or a raw `NotAllowedError`/`AbortError`). */
export class PasskeyUserCancelled extends Data.TaggedError("PasskeyUserCancelled")<{}> {}

/** No authenticator on this device can satisfy the request (`ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT`/`ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT`) — render a fallback sign-in method, not a raw platform error. */
export class PasskeyNoPlatformAuthenticator extends Data.TaggedError(
  "PasskeyNoPlatformAuthenticator",
)<{}> {}

/** This authenticator already holds a credential for this account (`ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED`, or a raw `InvalidStateError`). */
export class PasskeyAlreadyRegistered extends Data.TaggedError("PasskeyClient/AlreadyRegistered")<{}> {}

/** No `PublicKeyCredential` global at all — this browser/runtime cannot do WebAuthn. Checked before ever attempting a ceremony (`browserSupportsWebAuthn()`), not something the library itself throws for `startRegistration`/`startAuthentication` as a classified `WebAuthnError`. */
export class PasskeyNotSupported extends Data.TaggedError("PasskeyNotSupported")<{}> {}

/** Catch-all: `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`, any other `WebAuthnError` code, or a raw error this module doesn't otherwise classify (including a malformed options payload from this package's own server calls). The original error is always preserved via `cause`. */
export class PasskeyCeremonyFailed extends Data.TaggedError("PasskeyCeremonyFailed")<{
  readonly cause: unknown;
}> {}

export type PasskeyClientError =
  | PasskeyUserCancelled
  | PasskeyNoPlatformAuthenticator
  | PasskeyAlreadyRegistered
  | PasskeyNotSupported
  | PasskeyCeremonyFailed;

const CLASSIFIED_CODES: Partial<Record<WebAuthnErrorCode, () => PasskeyClientError>> = {
  ERROR_CEREMONY_ABORTED: () => new PasskeyUserCancelled(),
  ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT: () =>
    new PasskeyNoPlatformAuthenticator(),
  ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT: () => new PasskeyNoPlatformAuthenticator(),
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: () => new PasskeyAlreadyRegistered(),
};

/**
 * Classifies whatever `startRegistration`/`startAuthentication` reject
 * with. Both already convert a raw `DOMException` into a `WebAuthnError`
 * internally before throwing, so the `WebAuthnError` branch below is the
 * path a real browser ceremony failure always takes; the raw-`DOMException`
 * and catch-all branches exist for defense in depth, not because either
 * function is expected to bypass its own classification.
 */
export const fromCeremonyFailure = (error: unknown): PasskeyClientError => {
  if (error instanceof WebAuthnError) {
    // `@simplewebauthn/browser`'s own `identifyRegistrationError`/
    // `identifyAuthenticationError` deliberately leave `NotAllowedError`
    // unclassified beyond this passthrough code ("platforms are
    // overloading this error beyond what the spec defines") — but
    // `NotAllowedError` is, in practice, the overwhelmingly common real
    // "user declined the platform prompt" case, so this module still
    // looks past the passthrough at the real `DOMException` it preserves
    // via `.cause` rather than collapsing it into the generic catch-all.
    if (error.code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY") {
      const cause = error.cause;
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        return new PasskeyUserCancelled();
      }
      return new PasskeyCeremonyFailed({ cause: error });
    }
    const classify = CLASSIFIED_CODES[error.code];
    return classify === undefined ? new PasskeyCeremonyFailed({ cause: error }) : classify();
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  ) {
    return new PasskeyUserCancelled();
  }
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return new PasskeyAlreadyRegistered();
  }
  return new PasskeyCeremonyFailed({ cause: error });
};
