# Passkey and WebAuthn
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-17 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Amended BEH-EA-130/131's requirements with the user-presence and config-gated user-verification policy; added BEH-EA-255 (registration requires a fresh session), BEH-EA-256 (Conditional Create) and BEH-EA-257 (one stable random user handle), which the shipped code already enforced; banner replaced with implementation pointers (BPAS-007, CCR-EA-006) |
---

> Status: implemented in `packages/passkey` (`Passkey.ts`, `ChallengeStore.ts`, `PasskeyApi.ts`, `PasskeyCredentials.ts`, `PasskeyUserHandles.ts`; tests `packages/passkey/test`, `packages/ports/test/WebAuthn.test.ts`; the Gherkin scenarios are wired). The `@awthaq/passkey` plugin, the `WebAuthn` port (`@awthaq/ports`, `layerSimpleWebAuthn` over `@simplewebauthn/server`) and the browser layer (`@awthaq/client`'s `passkeyClient`) are implemented and tested against every behavior below; the requirements state what the shipped code enforces. Known remaining gaps are listed in `packages/passkey/README.md` ("Limits").

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

What the port surfaces, and who decides (CB-002, CB-004, HSK-002): `verifyRegistration` takes a required `requireUserPresence` (each call site chooses) and reports the observed `userVerified`/`userPresent` flags, the attestation `attestationFormat` and an `attestationType` (`none`, `self`, `certificate`); `verifyAuthentication` always enforces user presence (the wrapped library does whenever `advancedFIDOConfig` is absent, which the port never passes) and does **not** enforce the signature counter — it hands the library a stored counter of 0 and reports the assertion's own `newCounter`, so counter policy is the plugin's (BEH-EA-131). Options generation sets an explicit `timeout`, optional `hints` and `extensions` (TC-003) and supports the full attestation-conveyance enum, including `"indirect"` (HSK-006).

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
             client-asserted success alone. An ordinary registration MUST
             require the authenticator's user-presence flag, and user
             verification MUST be enforced when, and only when, the
             deployment's conveyed `authenticatorSelection.userVerification`
             is `"required"` (WebAuthn §7.1).
```

The credential record is what every later authentication ceremony trusts, so its fields must come from the server's own verification of the attestation object, not from anything the browser claims about itself. `usage-examples-v4.md` §8 shows the two-call shape (`registerOptions` then `registerVerify`) that keeps the challenge-bound verification step between option generation and persistence.

Shipped details of the ceremony:

- **One ceremony, one challenge scope (WPS-003).** `register/verify` names the ceremony it completes (`ceremony: "modal" | "conditional"`, absent means modal) and consumes exactly that ceremony's `ChallengeStore` scope; completing one never destroys the other's still-valid challenge.
- **User presence (CB-002).** An ordinary registration requires the authenticator's UP flag (`requireUserPresence: true`); only Conditional Create, which Chrome performs without a user gesture, may register with UP=0/UV=0. Conditional Create is unavailable under `userVerification: "required"` (CB-009), and always requests `residentKey: "required"`, so U2F-only and early-CTAP2 keys cannot complete it (HSK-007).
- **One stable user handle per user (BPAS-003).** `user.id` in every registration's options is the same random, per-user, non-PII handle, minted once (`passkey_user_handle`) and stored unchanged on every credential; a discoverable credential's assertion `userHandle` must equal the handle the credential was registered under. The handle is erased with the user.
- **What is recorded (HSK-003).** The browser-reported `transports` (recognized values only) and the AAGUID are persisted and surfaced in the credential list; a duplicate credential id is refused as `PasskeyAlreadyRegistered` (WPS-010), linking nothing.
- **Explicit timing (TC-003).** Every options response carries `PasskeyConfig.ceremonyTimeout` (default 4m30s, never above the five-minute challenge TTL; a larger value refuses to build), and configured `hints`/`extensions`.

_Previous: [BEH-EA-129](17-passkey.md#beh-ea-129-webauthn-is-a-port-wrapped-not-reimplemented) | Next: [BEH-EA-131](17-passkey.md#beh-ea-131-authentication-ceremony-issues-a-session)_

## BEH-EA-131: Authentication ceremony issues a session

```ts
const view = yield* client.passkey.authenticateVerify({ payload: { assertion } })   // SessionView
```

```text
REQUIREMENT: A verified authentication assertion MUST create a session
             through the same core `Sessions` capability every other sign-in
             method uses, and MUST deliver that session only through the
             shared `SessionDelivery` helper (cookie by default, or the body
             `token` under `X-Awthaq-Token-Delivery: bearer`, BEH-EA-066);
             the passkey plugin MUST NOT write the session cookie itself.
             User verification MUST be required of the assertion when the
             conveyed `authenticatorSelection.userVerification` is
             `"required"`, and of every later use of a credential flagged for
             a signature-counter anomaly.
```

Routing every credential-issuing path through one `Sessions` service is what keeps session behavior (idle/absolute expiry, sliding refresh, new-session-on-sign-in) uniform across password, OAuth and passkey sign-in without three separate implementations to keep in sync — a plugin contributes the *authentication*, core owns the *session*.

**Counter anomaly (CB-004, WPS-006).** A signature-counter regression (`newCounter <= stored`, except the normal `0 === 0` of an authenticator that never reports one) reaches the plugin's `counterAnomalyPolicy`. `"flag"` (default, "log + step-up, not an instant kill"): `auth.passkey.counterAnomaly` is published (and durably audited), the credential is flagged (`counterAnomalyAt`, visible in the credential list), the ceremony still succeeds, and the flagged credential needs user verification on every later use. `"reject"` additionally fails the ceremony with `PasskeyCounterAnomaly`. The stored counter never moves backwards. Step-up reauthentication applies the same policy.

**Handle check (BPAS-003).** An assertion carrying a `userHandle` that differs from the credential's stored handle fails like any other bad assertion.

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

Shipped guarantees, stated in the type (WPS-009): `ChallengeStore.guarantees` is `{ singleUse, replacesPriorOnIssue }` — `layerMemory`/`layerSql` claim both, `layerCookie` (stateless) claims neither and `Passkey.layer` warns at build time when the store cannot guarantee single use. The final challenge comparison is constant-time over decoded bytes (BPAS-008). Expired, never-consumed challenges (abandoned anonymous ceremonies) are reclaimed on every `issue` and by `sweepExpired` (WPS-005), and the anonymous `authenticate/options` and `authenticate/verify` are rate-limited per source address (plus per email on options).

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

One origin policy applies to registration, sign-in and step-up alike (MNA-007, CB-003): the origin is an exact member of `origins`; a ceremony reporting `crossOrigin: true` (an embedded iframe) is refused unless its `topOrigin` is listed in `allowedTopOrigins` (default: none); a web origin's host must be `rpId` or a subdomain of it, while a native `android:apk-key-hash:<hash>` origin, listed verbatim in `origins`, is exact-match and exempt from that web-only check (the RP-ID binding is still enforced by the authenticator data's `rpIdHash`). **Related Origin Requests (TC-008)** are opt-in through `relatedOrigins` (default none): exact `https` origins, accepted like `origins` but exempt from the rpId host check, never an allowed top origin, and served as `{ "origins": [...] }` at the anonymous `GET /.well-known/webauthn` (404 when the list is empty); a malformed entry refuses to build the plugin. The browser fetches that document from the `rpId` host, so the deployment must route the path to the application.

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

**Signals (BPAS-006, TC-004).** The server exposes an authenticated `GET /passkey/signals` answering the rpId, the stable user handle, the account name and the caller's own accepted credential ids. `@awthaq/client`'s `passkeyClient` uses it to send the WebAuthn Signals API `allAcceptedCredentials` after a delete and after every successful sign-in, and exposes `signalCurrentUserDetails` for an app to call after a profile change. Every signal is fire-and-forget — an unsupported browser or a failed request never changes a ceremony's outcome — and `unknownCredential` is only ever sent from the signed-in `reauthenticate` ceremony when the server reports the credential is not the caller's, never from the anonymous sign-in (BEH-EA-136).

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

Conveyance is a *request*, not a verification (HSK-002): `"none"` (default), `"indirect"`, `"direct"` and `"enterprise"` only ask the authenticator for a statement. The optional `attestationPolicy` turns it into a decision — `{ trustedAaguids, rejectSelfAttestation }` (self-attestation rejected by default) refuses, as `PasskeyAttestationRejected`, a registration carrying no attestation, a self-signed one, or an authenticator model outside the allow-list; the port reports each registration's `attestationFormat`/`attestationType` for it. Requesting attestation with no policy logs a warning once at layer build. This is an allow-list, not FIDO Metadata Service validation (still deferred): a certificate chain is only validated against roots the host installs in `@simplewebauthn/server`'s process-global settings.

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

The anonymous `authenticate` ceremony sits wholly inside this envelope, options included (TC-001, TSS-004): an unknown email (or a known user with no credentials) receives deterministic HMAC-keyed decoy `allowCredentials` shaped like a registered user's (`enumerationSecret`), an unknown credential id still costs one signature verification against a decoy key, and both endpoints are rate-limited. Beyond the original closed list, `register/verify` also reports `PasskeyAttestationRejected` and `PasskeyAlreadyRegistered` (authenticated, no identifier to enumerate), and `PasskeyCounterAnomaly` is raised under `counterAnomalyPolicy: "reject"` (BEH-EA-131), reachable only after a valid signature from a registered credential.

_Previous: [BEH-EA-135](17-passkey.md#beh-ea-135-attestation-defaults-to-none) | Next: [BEH-EA-255](17-passkey.md#beh-ea-255-passkey-registration-requires-a-fresh-session)_

## BEH-EA-255: Passkey registration requires a fresh session

```ts
yield* client.passkey.registerOptions()          // PasskeyReauthRequired when the session is stale
yield* client.passkey.registerVerify({ payload: { credential } })
```

```text
REQUIREMENT: `registerOptions`, `registerOptionsConditional` and `registerVerify`
             MUST each require that the calling session was authenticated
             within `PasskeyConfig.reauthMaxAgeSeconds`, and MUST fail with
             `PasskeyReauthRequired` naming that window otherwise; a session
             that is not live for its owner (revoked, expired, or belonging to
             another user) MUST fail the same way, never succeed.
```

A passkey is a new way to sign in to the account, so enrolling one is as sensitive as changing the password: a session hijacked an hour ago must not be able to plant a credential that outlives it. The check is the same freshness rule the `reauth` obligation (BEH-EA-165) applies, read from the session's `authenticatedAt` (`Sessions.isStale`), and it runs on both the options call and the verify call so a challenge obtained while fresh cannot be redeemed after the window closes. `PasskeyReauthRequired` carries the window so a client can drive the step-up ceremony (`passkey.reauthenticate`) and retry.

_Previous: [BEH-EA-136](17-passkey.md#beh-ea-136-typed-errors-are-enumeration-safe) | Next: [BEH-EA-256](17-passkey.md#beh-ea-256-conditional-create-is-a-separate-config-gated-ceremony-with-its-own-challenge-scope)_

## BEH-EA-256: Conditional Create is a separate, config-gated ceremony with its own challenge scope

```ts
const options = yield* client.passkey.registerOptionsConditional()   // PasskeyConditionalCreateDisabled when off
yield* client.passkey.registerVerify({ payload: { credential, ceremony: "conditional" } })
```

```text
REQUIREMENT: Conditional Create (browser-initiated passkey enrolment after a
             password sign-in, which performs no user gesture) MUST be
             available only when `PasskeyConfig.conditionalCreate` is on and
             `authenticatorSelection.userVerification` is not `"required"`,
             and MUST otherwise fail with `PasskeyConditionalCreateDisabled`.
             It MUST issue its challenge under its own scope
             (`passkey.register.conditional:<sessionId>`), MUST force
             `residentKey: "required"` and `userVerification: "discouraged"`,
             and MUST accept a registration with user presence and user
             verification unset only for a challenge consumed from that scope;
             an ordinary registration MUST still require user presence, and
             completing one ceremony MUST NOT consume the other's challenge.
```

Chrome's Conditional Create produces UP=0/UV=0 by design, and a discoverable (resident) credential is what makes autofill possible at all, which is why the ceremony forces those two options and why it cannot coexist with a deployment that requires user verification (it could never satisfy BEH-EA-130's UV rule). The exemption is scoped to the ceremony rather than to the deployment: the payload names its ceremony (`ceremony: "modal" | "conditional"`, absent means modal) and only that scope's challenge is consumed, so a relaxed registration can only be completed by a challenge that was issued as relaxed. The requirement refines BEH-EA-130's user-presence rule and BEH-EA-132's single-use challenge rule for the one ceremony that needs an exception.

_Previous: [BEH-EA-255](17-passkey.md#beh-ea-255-passkey-registration-requires-a-fresh-session) | Next: [BEH-EA-257](17-passkey.md#beh-ea-257-a-user-has-one-stable-random-webauthn-user-handle)_

## BEH-EA-257: A user has one stable, random WebAuthn user handle

```ts
// creation options: user: { id: <the user's handle>, name, displayName }
// assertion: response.userHandle must equal the handle stored with the credential
```

```text
REQUIREMENT: The `user.id` placed in every registration's creation options
             MUST be one random, opaque, non-personal value per user, minted
             on first use from 32 random bytes and reused for every credential
             that user enrols; it MUST be the value stored with each credential,
             and an assertion carrying a `userHandle` that differs from the
             credential's stored handle MUST fail like any other bad assertion.
             The handle MUST be erased with the user.
```

A discoverable credential's assertion returns the handle it was created with, and a credential manager keys its whole per-account view on it, so re-randomizing it per ceremony (as a first implementation did, persisting a value the authenticator never bound) breaks discoverable sign-in and the signals surface. It is random rather than derived from the user id or email so the value an authenticator stores cannot be used to identify the account elsewhere (`PasskeyUserHandles`, table `passkey_user_handle`).

_Previous: [BEH-EA-256](17-passkey.md#beh-ea-256-conditional-create-is-a-separate-config-gated-ceremony-with-its-own-challenge-scope) | Next: [BEH-EA-137](18-roles-subject-resolver.md#beh-ea-137-the-subjectresolver-slot-defaults-to-identity-only)_
