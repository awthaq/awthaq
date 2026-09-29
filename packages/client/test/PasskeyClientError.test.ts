// BPAS-002 (.issues/high) / wayfinder ticket 32
// (browser-webauthn-ux-layer): `PasskeyClientError.fromCeremonyFailure`'s
// own classification table — the concrete "maps raw NotAllowedError/
// InvalidStateError into distinct, human cases" ask BPAS-002's own Summary
// named. Exercised directly against real `WebAuthnError`/`DOMException`
// instances (the same shapes `@simplewebauthn/browser` itself throws), not
// through a full ceremony — that's `PasskeyClient.test.ts`'s job.
import { WebAuthnError } from "@simplewebauthn/browser";
import { assert, describe, it } from "@effect/vitest";
import * as PasskeyClientError from "../src/passkey/PasskeyClientError.ts";

const webAuthnError = (code: WebAuthnError["code"], cause: Error): WebAuthnError =>
  new WebAuthnError({ message: "boom", code, cause });

describe("PasskeyClientError.fromCeremonyFailure", () => {
  it("ERROR_CEREMONY_ABORTED classifies as PasskeyUserCancelled", () => {
    const error = webAuthnError(
      "ERROR_CEREMONY_ABORTED",
      new DOMException("aborted", "AbortError"),
    );
    const classified = PasskeyClientError.fromCeremonyFailure(error);
    assert.strictEqual(classified._tag, "PasskeyUserCancelled");
  });

  it("ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT classifies as PasskeyNoPlatformAuthenticator", () => {
    const error = webAuthnError(
      "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT",
      new DOMException("no discoverable credential support", "ConstraintError"),
    );
    const classified = PasskeyClientError.fromCeremonyFailure(error);
    assert.strictEqual(classified._tag, "PasskeyNoPlatformAuthenticator");
  });

  it("ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT classifies as PasskeyNoPlatformAuthenticator", () => {
    const error = webAuthnError(
      "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT",
      new DOMException("no UV support", "ConstraintError"),
    );
    const classified = PasskeyClientError.fromCeremonyFailure(error);
    assert.strictEqual(classified._tag, "PasskeyNoPlatformAuthenticator");
  });

  it("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED classifies as PasskeyAlreadyRegistered", () => {
    const error = webAuthnError(
      "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
      new DOMException("already registered", "InvalidStateError"),
    );
    const classified = PasskeyClientError.fromCeremonyFailure(error);
    assert.strictEqual(classified._tag, "PasskeyClient/AlreadyRegistered");
  });

  it("an unclassified WebAuthnError code (e.g. ERROR_INVALID_DOMAIN) falls back to PasskeyCeremonyFailed with the original error as cause", () => {
    const error = webAuthnError(
      "ERROR_INVALID_DOMAIN",
      new DOMException("bad domain", "SecurityError"),
    );
    const classified = PasskeyClientError.fromCeremonyFailure(error);
    assert.strictEqual(classified._tag, "PasskeyCeremonyFailed");
    if (classified._tag === "PasskeyCeremonyFailed") {
      assert.strictEqual(classified.cause, error);
    }
  });

  it("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY wrapping a real NotAllowedError DOMException classifies as PasskeyUserCancelled (the real-world 'user declined' path)", () => {
    const notAllowed = new DOMException(
      "The operation either timed out or was not allowed",
      "NotAllowedError",
    );
    const error = webAuthnError("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", notAllowed);
    const classified = PasskeyClientError.fromCeremonyFailure(error);
    assert.strictEqual(classified._tag, "PasskeyUserCancelled");
  });

  it("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY wrapping anything other than a NotAllowedError DOMException falls back to PasskeyCeremonyFailed", () => {
    const other = new DOMException("weird", "UnknownError");
    const error = webAuthnError("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", other);
    const classified = PasskeyClientError.fromCeremonyFailure(error);
    assert.strictEqual(classified._tag, "PasskeyCeremonyFailed");
  });

  it("a raw NotAllowedError DOMException (not wrapped in a WebAuthnError) classifies as PasskeyUserCancelled", () => {
    const classified = PasskeyClientError.fromCeremonyFailure(
      new DOMException("declined", "NotAllowedError"),
    );
    assert.strictEqual(classified._tag, "PasskeyUserCancelled");
  });

  it("a raw AbortError DOMException classifies as PasskeyUserCancelled", () => {
    const classified = PasskeyClientError.fromCeremonyFailure(
      new DOMException("aborted", "AbortError"),
    );
    assert.strictEqual(classified._tag, "PasskeyUserCancelled");
  });

  it("a raw InvalidStateError DOMException classifies as PasskeyAlreadyRegistered", () => {
    const classified = PasskeyClientError.fromCeremonyFailure(
      new DOMException("already registered", "InvalidStateError"),
    );
    assert.strictEqual(classified._tag, "PasskeyClient/AlreadyRegistered");
  });

  it("an arbitrary error classifies as PasskeyCeremonyFailed with the original error as cause", () => {
    const cause = new Error("network hiccup");
    const classified = PasskeyClientError.fromCeremonyFailure(cause);
    assert.strictEqual(classified._tag, "PasskeyCeremonyFailed");
    if (classified._tag === "PasskeyCeremonyFailed") {
      assert.strictEqual(classified.cause, cause);
    }
  });
});
