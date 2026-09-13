# Passkey and WebAuthn
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-17 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.

## BEH-EA-129: WebAuthn is a port, wrapped, not reimplemented

> **See:** [ADR-EA-010](../decisions/010-plugins-require-ports-never-provide.md)

```ts
interface WebAuthn {
  readonly registrationOptions: (input: RegistrationInput) => Effect<PublicKeyCredentialCreationOptionsJSON>
  readonly verifyRegistration: (input: VerifyRegistrationInput) => Effect<VerifiedRegistration, PasskeyVerificationFailed>
  readonly authenticationOptions: (input: AuthenticationInput) => Effect<PublicKeyCredentialRequestOptionsJSON>
  readonly verifyAuthentication: (input: VerifyAuthenticationInput) => Effect<VerifiedAuthentication, PasskeyVerificationFailed>
}
```

```text
REQUIREMENT: `WebAuthn` MUST be a port with a default implementation
             (`layerSimpleWebAuthn`); the passkey plugin MUST NOT hand-roll
             CBOR/COSE parsing, attestation verification, or signature
             checking itself.
```

research/06-webauthn-passkeys.md's structural pitfall note applies directly here: three 2026 CVEs across independent WebAuthn server libraries (CVE-2026-30964, YSA-2026-02, CVE-2026-47841) all verified cryptography correctly and got the *glue* wrong — which origin, which session, which user. Wrapping a maintained library (`@simplewebauthn/server`, whose author is a WebAuthn L3 spec editor) behind a port means awthaq's own code is exactly that glue layer, kept small and auditable, while the attestation-format matrix stays someone else's already-hardened problem.

_Previous: [BEH-EA-128](16-oauth.md#beh-ea-128-callback-destination-is-validated-never-echoed) | Next: [BEH-EA-130](17-passkey.md#beh-ea-130-registration-ceremony)_

## BEH-EA-130: Registration ceremony

```ts
const options = yield* client.passkey.registerOptions()
const credential = await navigator.credentials.create({ publicKey: options })
yield* client.passkey.registerVerify({ payload: { credential } })
```

```text
REQUIREMENT: `registerVerify` MUST persist the credential's public key,
             counter, device type, backup-state flag, transports and AAGUID
             only after `WebAuthn.verifyRegistration` succeeds against the
             challenge issued for that ceremony; it MUST NOT persist on a
             client-asserted success alone.
```

The credential record is what every later authentication ceremony trusts, so its fields must come from the server's own verification of the attestation object, not from anything the browser claims about itself. `usage-examples-v4.md` §8 shows the two-call shape (`registerOptions` then `registerVerify`) that keeps the challenge-bound verification step between option generation and persistence.

_Previous: [BEH-EA-129](17-passkey.md#beh-ea-129-webauthn-is-a-port-wrapped-not-reimplemented) | Next: [BEH-EA-131](17-passkey.md#beh-ea-131-authentication-ceremony-issues-a-session)_

## BEH-EA-131: Authentication ceremony issues a session

```ts
const view = yield* client.passkey.authenticateVerify({ payload: { assertion } })   // SessionView
```

```text
REQUIREMENT: A verified authentication assertion MUST create a session
             through the same core `Sessions` capability every other sign-in
             method uses; the passkey plugin MUST NOT set a session cookie
             itself.
```

Routing every credential-issuing path through one `Sessions` service is what keeps session behavior (idle/absolute expiry, sliding refresh, new-session-on-sign-in) uniform across password, OAuth and passkey sign-in without three separate implementations to keep in sync — a plugin contributes the *authentication*, core owns the *session*.

_Previous: [BEH-EA-130](17-passkey.md#beh-ea-130-registration-ceremony) | Next: [BEH-EA-132](17-passkey.md#beh-ea-132-challenges-are-single-use-and-short-lived)_

## BEH-EA-132: Challenges are single-use and short-lived

```ts
interface ChallengeStore {
  readonly issue: (scope: ChallengeScope) => Effect<Redacted<string>>
  readonly consume: (scope: ChallengeScope, challenge: string) => Effect<boolean>
}
```

```text
REQUIREMENT: A challenge MUST be deleted from the store on every verification
             attempt for it, regardless of whether that attempt succeeds; a
             challenge MUST NOT be reusable across two verification calls, and
             MUST expire within a bounded TTL (five minutes) if never used.
```

research/06-webauthn-passkeys.md states this exactly: "consumed (deleted) on every verification attempt regardless of outcome, bound to ceremony type + session/cookie" — deleting only on success would let a failed attempt be retried against the same challenge, reopening a replay window the single-use design exists to close. `ChallengeStore` is injected (Redis, memory, or cookie-backed), so its expiry is `Clock`/`TestClock`-driven and testable without real wall-clock waits.

_Previous: [BEH-EA-131](17-passkey.md#beh-ea-131-authentication-ceremony-issues-a-session) | Next: [BEH-EA-133](17-passkey.md#beh-ea-133-rp-config-is-exact-origin-matching)_

## BEH-EA-133: RP config is exact origin matching

```ts
passkey({ rpId: "example.com", origins: ["https://example.com"] })
```

```text
REQUIREMENT: Verification MUST compare the ceremony's origin against the
             configured `origins` as exact `(scheme, host, port)` tuples; `rpId`
             MUST be validated as a registrable-domain suffix of the origin,
             never as a bare match on `host` alone.
```

CVE-2026-30964 is the documented failure mode: a WebAuthn library reduced its configured origins to host-only matching and silently accepted the wrong scheme or port. research/06-webauthn-passkeys.md's recommended default carries `origins` as an array precisely so multiple deployment origins (a `www.` host and its apex, or a staging origin) can each be listed explicitly rather than approximated by a looser match rule.

_Previous: [BEH-EA-132](17-passkey.md#beh-ea-132-challenges-are-single-use-and-short-lived) | Next: [BEH-EA-134](17-passkey.md#beh-ea-134-multi-credential-management-refuses-to-strand-the-account)_

## BEH-EA-134: Multi-credential management refuses to strand the account

```ts
yield* client.passkey.remove({ params: { id } })   // refuses to remove the last credential when no other method exists
```

```text
REQUIREMENT: `passkey.remove` MUST refuse to delete a user's only remaining
             authentication credential; it MUST succeed once at least one other
             credential (a passkey, a password, or a linked OAuth account)
             would remain.
```

`usage-examples-v4.md` §8 states the guard directly. Without it, a user could delete their only passkey and permanently lock themselves out with no recovery path — the same "cannot unlink the last credential" rule PRD §13 states for `Accounts` generally applies here, keeping the invariant "every user can always authenticate somehow" true across every plugin that contributes a credential type.

_Previous: [BEH-EA-133](17-passkey.md#beh-ea-133-rp-config-is-exact-origin-matching) | Next: [BEH-EA-135](17-passkey.md#beh-ea-135-attestation-defaults-to-none)_

## BEH-EA-135: Attestation defaults to `none`

```ts
passkey({ attestation: "none" })   // "direct" | "enterprise" opt-in
```

```text
REQUIREMENT: The passkey plugin's default `attestation` conveyance MUST be
             `"none"`; `"direct"` and `"enterprise"` attestation MUST be
             available only as explicit opt-in configuration, and MUST NOT be
             required for v1 registration to succeed.
```

Requesting attestation from a synced consumer passkey is meaningless — there is no device-level attestation chain to validate — and research/06-webauthn-passkeys.md is explicit that FIDO Metadata Service validation, which real attestation checking requires, is "not needed" for a consumer-focused v1 and belongs in a deferred enterprise module. Defaulting to `"none"` also lets WebAuthn Level 3's AAGUID-without-attestation change still provide friendly credential-manager labels in the management UI.

_Previous: [BEH-EA-134](17-passkey.md#beh-ea-134-multi-credential-management-refuses-to-strand-the-account) | Next: [BEH-EA-136](17-passkey.md#beh-ea-136-typed-errors-are-enumeration-safe)_

## BEH-EA-136: Typed errors are enumeration-safe

```ts
PasskeyChallengeInvalid | PasskeyOriginMismatch | PasskeyRpIdMismatch |
PasskeyCredentialNotFound | PasskeyVerificationFailed | PasskeyUserVerificationRequired |
PasskeyCounterAnomaly | PasskeyLastCredential
```

```text
REQUIREMENT: Every distinct passkey ceremony failure MUST be its own typed
             `Schema.TaggedError`; the failure MUST NOT be collapsed into a
             single generic error whose message varies with the internal
             cause, and an unknown-credential failure MUST NOT reveal whether
             any credential was registered for the supplied user identifier.
```

A separate tag per failure keeps the client's error handling exhaustive and typed (`Effect.catchTags`) without the server needing to expose distinguishing detail in the message text itself: `PasskeyCredentialNotFound` and `PasskeyVerificationFailed` are different branches internally, but neither response needs to help an attacker enumerate which usernames have registered credentials — the same enumeration discipline PRD §18 applies to `InvalidCredentials` extends to every credential type, passkeys included.

_Previous: [BEH-EA-135](17-passkey.md#beh-ea-135-attestation-defaults-to-none) | Next: [BEH-EA-137](18-roles-subject-resolver.md#beh-ea-137-the-subjectresolver-slot-defaults-to-identity-only)_
