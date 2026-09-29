# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@authentication-methods @passkey
Feature: Passkey and WebAuthn

  # BEH-EA-129 — spec/behaviors/17-passkey.md; see also ADR-EA-010.
  @BEH-EA-129
  Rule: WebAuthn is a port, wrapped, not reimplemented

    @REQ-EA-355
    Scenario: The application supplies the default SimpleWebAuthn implementation and Passkey composes against it
      Given an application composing "Passkey"
      When the application provides "WebAuthn.layerSimpleWebAuthn"
      Then "Passkey" performs its ceremonies using the provided "WebAuthn" port

    @REQ-EA-356
    Scenario: The passkey plugin performs no cryptographic verification of its own
      Given a registration or authentication ceremony being verified
      When "Passkey" processes the ceremony
      Then the CBOR/COSE parsing, attestation verification, and signature checking are all performed by the "WebAuthn" port
      And "Passkey"'s own code performs none of that parsing or verification itself

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
    Scenario: The passkey plugin delivers the session only through the shared SessionDelivery helper
      Given a successfully verified authentication assertion
      When "authenticateVerify" returns its "SessionView"
      Then the session is delivered through the shared "SessionDelivery" helper as the "__Host-session" cookie

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

    @REQ-EA-696
    Scenario: rpId suffix validation applies even to an origin the deployment listed
      Given "passkey({ rpId: \"example.com\", origins: [\"https://example.com\", \"https://www.example.com\", \"https://evil-example.com\"] })"
      When ceremonies arrive from "https://www.example.com" and from "https://evil-example.com"
      Then the ceremony from "https://www.example.com" is accepted
      And the ceremony from "https://evil-example.com" is rejected as an rpId mismatch

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
    # Scenario Outline rather than kept in this table — it is only thrown
    # under `counterAnomalyPolicy: "reject"` (under the default "flag" the
    # ceremony still succeeds), so it can't share this table's 7 rows, which
    # are thrown unconditionally.
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

    # CB-004/WPS-006: a counter regression on an otherwise-verified assertion
    # (`newCounter <= stored`, and not the normal 0 === 0 of an authenticator
    # that never reports one) now actually reaches the plugin's policy — the
    # port no longer lets the library throw first. `counterAnomalyPolicy`
    # "flag" (the default, wayfinder ticket 08's "log + step-up, not an instant
    # kill") signs in and flags the credential; "reject" fails the ceremony
    # with the typed anomaly. Either way the credential is flagged and the
    # anomaly is audited.
    @REQ-EA-381
    Scenario Outline: A counter regression on a verified assertion follows the configured policy
      Given a stored credential with a nonzero counter, and an authentication assertion whose returned counter does not exceed it, under the "<policy>" counter-anomaly policy
      When "authenticateVerify" processes the regressed assertion
      Then the outcome is "<outcome>"
      And the credential is flagged for the counter anomaly

      Examples:
        | policy | outcome               |
        | reject | PasskeyCounterAnomaly |
        | flag   | a session is issued   |

  # BEH-EA-255 — spec/behaviors/17-passkey.md; see also BEH-EA-165
  # Over the wire the authentication middleware refuses a revoked or expired session before any
  # passkey handler runs, so the plugin's own "not live for its owner" branch (a session belonging to
  # another user) is not reachable through HTTP; the scenarios below observe what a caller sees.
  @BEH-EA-255
  Rule: Passkey registration requires a fresh session

    @REQ-EA-1007
    Scenario: A session authenticated within the window may start a registration
      Given a user "fresh@example.com" whose session is inside the passkey reauthentication window
      When the session requests registration options
      Then the options are issued

    @REQ-EA-1008
    Scenario: A stale session is refused registration options, and the refusal names the window
      Given a deployment with a 600 millisecond passkey reauthentication window
      And a user "stale-options@example.com" whose session has outlived that window
      When the session requests registration options
      Then the request fails with "PasskeyReauthRequired" naming a window of 600 milliseconds

    @REQ-EA-1009
    Scenario: A stale session is refused Conditional Create options too
      Given a deployment with a 600 millisecond passkey reauthentication window
      And a user "stale-conditional@example.com" whose session has outlived that window
      When the session requests Conditional Create options
      Then the request fails with "PasskeyReauthRequired" naming a window of 600 milliseconds

    @REQ-EA-1010
    Scenario: A challenge obtained while fresh cannot be redeemed after the session has gone stale
      Given a deployment with a 600 millisecond passkey reauthentication window
      And a user "late@example.com" whose session is inside the passkey reauthentication window
      And the session obtained registration options while fresh
      When the session has outlived that window and presents the completed registration
      Then the request fails with "PasskeyReauthRequired" naming a window of 600 milliseconds
      And no credential is stored for "late@example.com"

    @REQ-EA-1011
    Scenario: A session that is no longer live cannot register a passkey
      Given a user "gone@example.com" whose session is inside the passkey reauthentication window
      And that session has been revoked
      When the session requests registration options
      Then the request is refused as unauthenticated and no options are issued

  # BEH-EA-256 — spec/behaviors/17-passkey.md; see also BEH-EA-130, BEH-EA-132
  # The WebAuthn port is mocked everywhere except the one scenario that reads the options the real
  # library builds; user presence is observed as what the plugin asks the port to require.
  @BEH-EA-256
  Rule: Conditional Create is a separate, config-gated ceremony with its own challenge scope

    @REQ-EA-1012
    Scenario: With Conditional Create on, its options force a discoverable credential and discouraged user verification
      Given a deployment composed against the real "WebAuthn.layerSimpleWebAuthn" port
      And a user "cc-on@example.com" whose session is inside the passkey reauthentication window
      When the session requests Conditional Create options
      Then the options are issued
      And the options require a resident key and discourage user verification

    @REQ-EA-1013
    Scenario: With Conditional Create configured off, the endpoint is reported as absent
      Given a deployment with Conditional Create switched off
      And a user "cc-off@example.com" whose session is inside the passkey reauthentication window
      When the session requests Conditional Create options
      Then the request fails with "PasskeyConditionalCreateDisabled"

    @REQ-EA-1014
    Scenario: A deployment that requires user verification cannot offer Conditional Create
      Given a deployment that requires user verification
      And a user "cc-uv@example.com" whose session is inside the passkey reauthentication window
      When the session requests Conditional Create options
      Then the request fails with "PasskeyConditionalCreateDisabled"

    @REQ-EA-1015
    Scenario: A Conditional Create challenge cannot be redeemed as an ordinary registration
      Given a user "cc-scope-a@example.com" whose session is inside the passkey reauthentication window
      And the session obtained Conditional Create options
      When the session presents that challenge as an ordinary registration
      Then the request fails with "PasskeyChallengeInvalid"

    @REQ-EA-1016
    Scenario: An ordinary registration challenge cannot be redeemed as a Conditional Create registration
      Given a user "cc-scope-b@example.com" whose session is inside the passkey reauthentication window
      And the session obtained registration options while fresh
      When the session presents that challenge as a Conditional Create registration
      Then the request fails with "PasskeyChallengeInvalid"

    @REQ-EA-1017
    Scenario: Completing one ceremony does not consume the other's challenge
      Given a user "cc-both@example.com" whose session is inside the passkey reauthentication window
      And the session obtained registration options while fresh
      And the session obtained Conditional Create options
      When the session completes the ordinary registration and then the Conditional Create registration
      Then both registrations succeed and "cc-both@example.com" holds two credentials

    @REQ-EA-1018
    Scenario: Only Conditional Create relaxes the user-presence requirement
      Given a user "cc-up@example.com" whose session is inside the passkey reauthentication window
      And the session obtained registration options while fresh
      And the session obtained Conditional Create options
      When the session completes the ordinary registration and then the Conditional Create registration
      Then the ordinary registration required user presence and the Conditional Create one did not

  # BEH-EA-257 — spec/behaviors/17-passkey.md; see also BEH-EA-130, BEH-EA-132
  @BEH-EA-257
  Rule: A user has one stable, random WebAuthn user handle

    @REQ-EA-1019
    Scenario: Every registration's creation options carry the same handle for one user
      Given a user "handle-stable@example.com" whose session is inside the passkey reauthentication window
      When the session requests registration options twice
      Then both creation options carry the same "user.id"

    @REQ-EA-1020
    Scenario: The handle is 32 random bytes and names no one
      Given a user "handle-a@example.com" whose session is inside the passkey reauthentication window
      When the session requests registration options
      Then the "user.id" is 32 random bytes that contain neither the user's id nor the user's address
      And a second user "handle-b@example.com" is given a different "user.id"

    @REQ-EA-1021
    Scenario: The handle stored with each credential is the one the options carried
      Given a user "handle-stored@example.com" whose session is inside the passkey reauthentication window
      When the session registers two credentials
      Then both credentials are stored under the "user.id" the options carried

    @REQ-EA-1022
    Scenario: An assertion carrying a different user handle fails like any other bad assertion
      Given a user "handle-assert@example.com" who has registered a credential
      When that credential asserts with a "userHandle" that is not the one stored with it
      Then the assertion fails with "InvalidCredentials"

    @REQ-EA-1023
    Scenario: An assertion carrying the stored user handle succeeds
      Given a user "handle-assert-ok@example.com" who has registered a credential
      When that credential asserts with the "userHandle" stored with it
      Then the assertion succeeds

    @REQ-EA-1024
    Scenario: The handle is erased with the user
      Given a user "handle-erase@example.com" who has registered a credential
      When the plugin's erasure contribution runs for that user
      Then no credential remains for "handle-erase@example.com"
      And the next "user.id" minted for that user is a different value
