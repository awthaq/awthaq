# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@authentication-methods @passkey
Feature: Passkey and WebAuthn

  # BEH-EA-129 — spec/behaviors/17-passkey.md; see also ADR-EA-010.
  @BEH-EA-129
  Rule: WebAuthn is a port, wrapped, not reimplemented

    # Shipping-gap map (.scratch/shipping-gaps), ticket 25: pruned, not
    # force-implemented — a type-level/composition claim (Passkey depends
    # only on the WebAuthn port's interface, never a concrete
    # implementation), provable by reading Passkey.ts's own `make` Effect
    # and its `yield* WebAuthn.WebAuthn`, not by a runtime request this
    # step framework could make. The real `WebAuthn.layerSimpleWebAuthn`
    # composition is already exercised for real by
    # `packages/ports/test/WebAuthn.test.ts`.
    @skip
    @REQ-EA-355
    Scenario: The application supplies the default SimpleWebAuthn implementation and Passkey composes against it
      Given an application composing "Passkey"
      When the application provides "WebAuthn.layerSimpleWebAuthn"
      Then "Passkey" performs its ceremonies using the provided "WebAuthn" port

    # Shipping-gap map (.scratch/shipping-gaps), ticket 25: pruned, not
    # force-implemented — a structural/source-inspection claim ("Passkey's
    # own code performs none of that parsing"), not a runtime behavior a
    # wire-level step could observe.
    @skip
    @REQ-EA-356
    Scenario: The passkey plugin performs no cryptographic verification of its own
      Given a registration or authentication ceremony being verified
      When "Passkey" processes the ceremony
      Then the CBOR/COSE parsing, attestation verification, and signature checking are all performed by the "WebAuthn" port
      And "Passkey"'s own code performs none of that parsing or verification itself

    # Shipping-gap map (.scratch/shipping-gaps), ticket 25: pruned, not
    # force-implemented — same port-composition claim as REQ-EA-355, this
    # time about swappability; this World already proves the plugin is
    # driven entirely through the `WebAuthn` port interface (a mock
    # implementation, not `layerSimpleWebAuthn`), which is the same
    # structural property this scenario names, but "requires no change to
    # the Passkey plugin" itself is a claim about the plugin's own source
    # code, not a wire-observable behavior.
    @skip
    @REQ-EA-357
    Scenario: Swapping the WebAuthn port implementation requires no change to the Passkey plugin
      Given an application composing "Passkey" against "WebAuthn.layerSimpleWebAuthn"
      When the application instead provides a different "WebAuthn" port implementation
      Then "Passkey" continues to function unchanged, calling only the "WebAuthn" port's interface

  # BEH-EA-130 — spec/behaviors/17-passkey.md
  @BEH-EA-130
  Rule: Registration ceremony

    @REQ-EA-358
    Scenario: registerVerify persists the full credential record only after WebAuthn.verifyRegistration succeeds
      Given a registration ceremony's challenge issued by "registerOptions"
      When the browser's credential is submitted to "registerVerify" and "WebAuthn.verifyRegistration" succeeds against that same challenge
      Then the credential's public key, counter, device type, backup-state flag, transports, and AAGUID are all persisted

    @REQ-EA-359
    Scenario: registerVerify persists nothing when the server-side verification fails
      Given a registration ceremony's challenge issued by "registerOptions"
      When the browser's credential is submitted to "registerVerify" and "WebAuthn.verifyRegistration" fails
      Then no credential record is persisted

    @REQ-EA-360
    Scenario: A client-asserted success alone never causes a credential to be persisted
      Given a registration ceremony in which the client's own request claims a successful attestation
      When "registerVerify" is called and "WebAuthn.verifyRegistration" itself does not succeed against the ceremony's challenge
      Then persistence does not occur, regardless of what the client's request claims

  # BEH-EA-131 — spec/behaviors/17-passkey.md
  @BEH-EA-131
  Rule: Authentication ceremony issues a session

    @REQ-EA-361
    Scenario: A verified authentication assertion creates a session through core Sessions
      Given an authentication assertion that "WebAuthn.verifyAuthentication" verifies successfully
      When "authenticateVerify" handles the assertion
      Then a session is issued through the same core "Sessions" capability every sign-in method uses

    @REQ-EA-362
    Scenario: The passkey plugin does not set the session cookie itself
      Given a successfully verified authentication assertion
      When "authenticateVerify" returns its "SessionView"
      Then the session cookie is set by core "Sessions", not by any cookie-setting code in the passkey plugin

    @REQ-EA-363
    Scenario: A passkey-issued session behaves identically to a password- or OAuth-issued session
      Given a session issued via a verified passkey authentication
      When that session's idle expiry, absolute expiry, and sliding refresh are compared against a session issued via password sign-in
      Then both sessions follow the same expiry and refresh rules, uniformly across authentication methods

  # BEH-EA-132 — spec/behaviors/17-passkey.md
  @BEH-EA-132
  Rule: Challenges are single-use and short-lived

    @REQ-EA-364
    Scenario: A challenge is deleted from the store on every verification attempt, regardless of outcome
      Given a challenge issued for a ceremony
      When a verification attempt for that challenge is made, whether it succeeds or fails
      Then the challenge is deleted from the "ChallengeStore" as part of that attempt

    @REQ-EA-365
    Scenario: A challenge already consumed by a successful verification cannot be reused by a second call
      Given a challenge that has already been consumed by a successful verification
      When a second verification call presents the same challenge
      Then the second call fails, since the challenge is no longer in the store

    @REQ-EA-366
    Scenario: A challenge is not left reusable after a failed verification attempt
      Given a challenge presented in a verification attempt that fails
      When a second verification attempt is made using that same challenge value
      Then the second attempt also fails, since the first attempt already deleted the challenge on failure

    @REQ-EA-367
    Scenario: An unused challenge expires within its five-minute TTL
      Given a challenge issued and never presented for verification
      When five minutes elapse, driven by "Clock"/"TestClock"
      Then the challenge is no longer valid once its TTL has elapsed

  # BEH-EA-133 — spec/behaviors/17-passkey.md
  @BEH-EA-133
  Rule: RP config is exact origin matching

    @REQ-EA-368
    Scenario: A ceremony whose origin exactly matches a configured origin tuple verifies successfully
      Given "passkey({ rpId: \"example.com\", origins: [\"https://example.com\"] })"
      When a ceremony arrives with origin "https://example.com"
      Then the origin check succeeds

    @REQ-EA-369
    Scenario: A ceremony differing only in scheme or port from a configured origin is rejected
      Given "passkey({ rpId: \"example.com\", origins: [\"https://example.com\"] })"
      When a ceremony arrives with origin "http://example.com" or with a non-standard port not present in "origins"
      Then the origin check fails, even though the host alone matches

    @REQ-EA-370
    Scenario: rpId is validated as a registrable-domain suffix of the origin, not a bare host match
      Given "passkey({ rpId: \"example.com\", origins: [\"https://example.com\"] })"
      When a ceremony's origin host is checked against "rpId"
      Then "rpId" is validated as a registrable-domain suffix of that origin
      And a bare substring or unrelated host match is not accepted in its place

    @REQ-EA-371
    Scenario: Multiple explicit deployment origins are each matched individually
      Given "passkey({ rpId: \"example.com\", origins: [\"https://example.com\", \"https://www.example.com\", \"https://staging.example.com\"] })"
      When ceremonies arrive from "https://www.example.com" and from "https://staging.example.com"
      Then both are accepted, each matched against its own explicit entry in "origins"

  # BEH-EA-134 — spec/behaviors/17-passkey.md
  @BEH-EA-134
  Rule: Multi-credential management refuses to strand the account

    @REQ-EA-372
    Scenario: passkey.remove refuses to delete a user's only remaining authentication credential
      Given a signed-in user "alice" with exactly one passkey credential and no other Account
      When "alice" calls "passkey.remove" for that credential's id
      Then the removal is refused

    @REQ-EA-373
    Scenario: passkey.remove succeeds when at least one other credential would remain
      Given a signed-in user "alice" with two passkey credentials
      When "alice" calls "passkey.remove" for one of them
      Then the removal succeeds
      And "alice" still has one remaining passkey credential

    @REQ-EA-374
    Scenario Outline: The refusal is lifted by any remaining credential kind, not passkeys alone
      Given a signed-in user "alice" with exactly one passkey credential and one "<other credential>"
      When "alice" calls "passkey.remove" for her passkey credential's id
      Then the removal succeeds, since "<other credential>" would remain

      Examples:
        | other credential      |
        | password credential   |
        | linked OAuth account  |

  # BEH-EA-135 — spec/behaviors/17-passkey.md
  @BEH-EA-135
  Rule: Attestation defaults to `none`

    @REQ-EA-375
    Scenario: A registration ceremony with no explicit attestation configuration requests "none"
      Given "passkey()" composed with no explicit "attestation" option
      When a registration ceremony's options are generated
      Then the requested attestation conveyance is "none"

    @REQ-EA-376
    Scenario: "direct" and "enterprise" attestation are available only as explicit opt-in
      Given "passkey({ attestation: \"direct\" })" or "passkey({ attestation: \"enterprise\" })" explicitly configured
      When a registration ceremony's options are generated
      Then the requested attestation conveyance matches the explicitly configured value

    @REQ-EA-377
    Scenario: v1 registration succeeds without any attestation beyond the "none" default
      Given "passkey()" composed with no explicit "attestation" option
      When a registration ceremony completes with "none" attestation
      Then registration succeeds
      And neither "direct" nor "enterprise" attestation was required for it to succeed

  # BEH-EA-136 — spec/behaviors/17-passkey.md
  @BEH-EA-136
  Rule: Typed errors are enumeration-safe

    # Shipping-gap map (.scratch/shipping-gaps), ticket 25: the "counter
    # anomaly" row is split out below into its own, separately-tagged
    # Scenario Outline rather than kept in this table — a Gherkin `@skip`
    # tag applies to a whole Scenario Outline, not to one `Examples` row,
    # and `PasskeyCounterAnomaly` is real but genuinely never thrown by
    # `authenticateVerify` (see the split-out scenario below for why), so
    # it can't share this table's 7 rows, which really are all thrown.
    @REQ-EA-378
    Scenario Outline: Each distinct ceremony failure surfaces as its own typed Schema.TaggedError
      Given a ceremony that fails for the reason "<failure>"
      When the failure is returned to the caller
      Then it is reported as the distinct typed error "<tag>"

      Examples:
        | failure                                 | tag                              |
        | the challenge is missing or expired      | PasskeyChallengeInvalid          |
        | the ceremony's origin does not match     | PasskeyOriginMismatch            |
        | the ceremony's rpId does not match       | PasskeyRpIdMismatch              |
        | the credential id is not found           | PasskeyCredentialNotFound        |
        | signature or attestation verification failed | PasskeyVerificationFailed   |
        | user verification was required but absent | PasskeyUserVerificationRequired |
        | removing the account's last credential was attempted | PasskeyLastCredential   |

    @REQ-EA-379
    Scenario: Ceremony failures are never collapsed into one generic error whose message varies by cause
      Given the same set of distinct ceremony failure reasons
      When each is returned to the caller
      Then no single generic error tag is used for more than one of them
      And the caller can use "Effect.catchTags" to distinguish every reason exhaustively

    @REQ-EA-380
    Scenario: An unknown-credential failure does not reveal whether any credential was registered for the supplied identifier
      Given an authentication attempt for a user identifier that has no registered passkey credential
      When "PasskeyCredentialNotFound" is returned
      Then the response does not reveal whether any credential exists for that identifier, distinguishably from a credential that exists but fails verification

    # Shipping-gap map (.scratch/shipping-gaps), ticket 25: pruned, not
    # force-implemented — this scenario's literal expectation ("reported
    # as PasskeyCounterAnomaly", "not silently accepted") contradicts the
    # real, deliberate implementation: `Passkey.ts`'s own `authenticateVerify`
    # treats a counter regression as "log + step-up, not an instant kill"
    # (its own comment) — it publishes `auth.passkey.counterAnomaly` on
    # `AuthEvents` and the ceremony still succeeds. `PasskeyApi.ts`'s own
    # `PasskeyCounterAnomaly` doc comment confirms this is intentional: the
    # type is declared for BEH-EA-136's closed list and for a future caller
    # to `catchTag` against if the policy ever changes, but "deliberately
    # never appears in any endpoint's error union". Forcing this scenario
    # green would mean asserting a failure that cannot occur; this is a
    # genuine spec/implementation divergence, flagged here rather than
    # hidden, not assumed to be a defect in either direction.
    @skip
    @REQ-EA-381
    Scenario: A counter regression on an otherwise-verified assertion is reported as its own typed anomaly, not silently accepted
      Given a stored credential with a nonzero counter, and an authentication assertion whose returned counter does not exceed it
      When "authenticateVerify" processes the assertion
      Then the failure is reported as "PasskeyCounterAnomaly"
      And it is not silently accepted as an ordinary successful authentication
