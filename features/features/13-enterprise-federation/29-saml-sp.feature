# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# @unwired: `@awthaq/saml` (the SAML service provider) is not built — there is no package and
# no `SamlSigner` port implementation, so these scenarios are specification only and every one
# is reported as a skipped vitest node (see features/README.md, "Wired versus unwired"). They
# restate spec/behaviors/29-saml-sp.md, which was written first on purpose: SAML's failure modes
# are silent signature bypasses, so the checks and their order are fixed before an implementation
# can drift. Blocked by: AOMS-009 (plan P18, enterprise-federation-saml-scim: packages/saml,
# SP-only) and SFS-003 (the fused parse-and-verify `SamlSigner` port in @awthaq/ports). Wiring
# them belongs to the milestone that builds the plugin; it removes `@skip @unwired` from the
# Feature line below and gives each scenario real steps against the ACS endpoint.

@enterprise-federation @saml @skip @unwired
Feature: SAML Service Provider

  # BEH-EA-238 — spec/behaviors/29-saml-sp.md; see also ADR-EA-023
  @BEH-EA-238
  Rule: The SAML response is size-capped before it is parsed

    @REQ-EA-861
    Scenario: A SAMLResponse within the configured cap is passed on to parsing
      Given a SAML connection whose decoded size cap is 256 KiB
      When the ACS receives a SAMLResponse of 10 KiB
      Then the response proceeds to XML parsing

    @REQ-EA-862
    Scenario: A SAMLResponse above the configured cap is refused before any XML parsing
      Given a SAML connection whose decoded size cap is 256 KiB
      When the ACS receives a SAMLResponse whose decoded size is 257 KiB
      Then the response is rejected with the uniform "SamlAssertionRejected" failure
      And no XML parser was invoked for it

    @REQ-EA-863
    Scenario: A redirect-binding payload that inflates beyond the cap is refused as a decompression bomb
      Given a SAML connection whose decoded size cap is 256 KiB
      When the ACS receives a DEFLATE payload that is small on the wire and inflates beyond 256 KiB
      Then the response is rejected with the uniform "SamlAssertionRejected" failure
      And the payload was not inflated beyond the cap

    @REQ-EA-864
    Scenario: The size cap is configurable and defaults to 256 KiB
      Given a SAML connection with no size cap configured
      Then the effective size cap is 256 KiB

  # BEH-EA-239 — spec/behaviors/29-saml-sp.md; see also ADR-EA-023
  @BEH-EA-239
  Rule: The document is parsed with DTDs and external entities disabled, and carries exactly one assertion

    @REQ-EA-865
    Scenario: A document with a DOCTYPE is rejected outright
      Given a SAML response document that declares a DOCTYPE
      When the ACS processes it
      Then the response is rejected with the uniform "SamlAssertionRejected" failure
      And no external entity was resolved

    @REQ-EA-866
    Scenario: A billion-laughs entity expansion is rejected without expanding
      Given a SAML response document whose DOCTYPE defines nested entity expansions
      When the ACS processes it
      Then the response is rejected with the uniform "SamlAssertionRejected" failure
      And no entity was expanded

    @REQ-EA-867
    Scenario: An external-entity (XXE) reference is never resolved
      Given a SAML response document whose DOCTYPE references a local file as an external entity
      When the ACS processes it
      Then the response is rejected with the uniform "SamlAssertionRejected" failure
      And the referenced file was never read

    @REQ-EA-868
    Scenario: A response with no Assertion element is rejected before any signature work
      Given a SAML response document containing zero Assertion elements
      When the ACS processes it
      Then the response is rejected with the uniform "SamlAssertionRejected" failure
      And no signature verification was attempted

    @REQ-EA-869
    Scenario: A response with more than one Assertion element is rejected before any signature work
      Given a SAML response document containing two Assertion elements
      When the ACS processes it
      Then the response is rejected with the uniform "SamlAssertionRejected" failure
      And no signature verification was attempted

    @REQ-EA-870
    Scenario: An encrypted assertion is rejected while no decryption port exists
      Given a SAML response document carrying an EncryptedAssertion
      When the ACS processes it
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

  # BEH-EA-240 — spec/behaviors/29-saml-sp.md; see also ADR-EA-010
  @BEH-EA-240
  Rule: The signature is verified over the element that is processed, with an algorithm allow-list

    @REQ-EA-871
    Scenario: A response whose Assertion carries a valid signature from a trusted certificate is accepted by this check
      Given a SAML connection whose trust set holds the IdP's signing certificate
      And a response whose only Assertion is signed by that certificate with RSA-SHA256
      When the ACS verifies the signature
      Then the signature check passes

    @REQ-EA-872
    Scenario: The data returned is extracted only from the element the verified signature covers
      Given a response with a valid signature over Assertion "A1" and unsigned attribute data elsewhere in the document
      When the ACS verifies the response
      Then the returned NameID and attributes come only from Assertion "A1"

    @REQ-EA-873
    Scenario: A signature-wrapping attempt cannot make the application consume an unsigned element
      Given a response whose signature is valid over a benign element while a forged Assertion sits elsewhere in the document
      When the ACS verifies the response
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-874
    Scenario: A Reference URI that does not resolve to the processed element by ID is rejected
      Given a response whose signature Reference URI names an element other than the Assertion it accompanies
      When the ACS verifies the response
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-875
    Scenario Outline: A signature or digest algorithm outside the allow-list is refused
      Given a response signed with signature algorithm "<signature>" and digest algorithm "<digest>"
      When the ACS verifies the signature
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

      Examples:
        | signature  | digest |
        | RSA-SHA1   | SHA-1  |
        | RSA-SHA256 | SHA-1  |
        | RSA-SHA1   | SHA-256 |

    @REQ-EA-876
    Scenario: A signing certificate that is not in the connection's trust set is rejected
      Given a response signed by a certificate whose fingerprint is not in the connection's IdpTrustSet
      When the ACS verifies the signature
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-877
    Scenario: A signing certificate outside its notBefore/notAfter window is rejected
      Given a response signed by a trusted certificate that has expired
      When the ACS verifies the signature
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-878
    Scenario: An IdP rotating its key can be trusted with both certificates during an overlap
      Given a SAML connection whose trust set holds the IdP's old and new signing certificates
      When the ACS verifies a response signed by the new certificate
      And the ACS verifies a response signed by the old certificate
      Then both signature checks pass

  # BEH-EA-241 — spec/behaviors/29-saml-sp.md
  @BEH-EA-241
  Rule: The issuer must be the connection's identity provider

    @REQ-EA-879
    Scenario: An assertion whose Issuer equals the connection's idpEntityId passes the issuer check
      Given a SAML connection with idpEntityId "https://idp.acme.example"
      When the ACS checks a verified assertion issued by "https://idp.acme.example"
      Then the issuer check passes

    @REQ-EA-880
    Scenario: An assertion whose Issuer differs from the connection's idpEntityId is rejected
      Given a SAML connection with idpEntityId "https://idp.acme.example"
      When the ACS checks a verified assertion issued by "https://idp.other.example"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-881
    Scenario: The Issuer comparison is exact, not a prefix or case-folded match
      Given a SAML connection with idpEntityId "https://idp.acme.example"
      When the ACS checks a verified assertion issued by "https://idp.acme.example.evil.example"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-882
    Scenario: The trust set used is the one of the connection the response was solicited for
      Given two SAML connections "acme" and "globex", each trusting only its own IdP certificate
      And a login was solicited on connection "acme"
      When the ACS receives a response signed by the certificate trusted by "globex"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-883
    Scenario: A connection is never selected by a value inside the unverified document
      Given a login was solicited on connection "acme"
      When the ACS receives a response whose unverified Issuer names connection "globex"'s identity provider
      Then the trust set consulted is the one of "acme"

  # BEH-EA-242 — spec/behaviors/29-saml-sp.md
  @BEH-EA-242
  Rule: Audience, Recipient and Destination must name this service provider

    @REQ-EA-884
    Scenario: An assertion whose AudienceRestriction contains the SP entity id passes
      Given a service provider with entity id "https://sp.awthaq.example"
      When the ACS checks an assertion whose AudienceRestriction contains "https://sp.awthaq.example"
      Then the audience check passes

    @REQ-EA-885
    Scenario: An assertion minted for a different service provider is rejected
      Given a service provider with entity id "https://sp.awthaq.example"
      When the ACS checks an assertion whose AudienceRestriction contains only "https://other-sp.example"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-886
    Scenario: A SubjectConfirmationData Recipient that is not the ACS URL is rejected
      Given an ACS URL "https://sp.awthaq.example/auth/saml/acs"
      When the ACS checks an assertion whose Recipient is "https://sp.awthaq.example/elsewhere"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-887
    Scenario: A Response Destination that is present and is not the ACS URL is rejected
      Given an ACS URL "https://sp.awthaq.example/auth/saml/acs"
      When the ACS checks a response whose Destination is "https://sp.awthaq.example/elsewhere"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-888
    Scenario: A Response with no Destination is not rejected on that ground
      Given an ACS URL "https://sp.awthaq.example/auth/saml/acs"
      When the ACS checks a response that carries no Destination
      Then the destination check passes

    @REQ-EA-889
    Scenario: A SubjectConfirmation method other than bearer is rejected
      When the ACS checks an assertion whose SubjectConfirmation method is "holder-of-key"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

  # BEH-EA-243 — spec/behaviors/29-saml-sp.md
  @BEH-EA-243
  Rule: The assertion's time window is enforced with bounded clock skew

    @REQ-EA-890
    Scenario: An assertion inside its window is accepted
      Given the server clock is inside an assertion's NotBefore and NotOnOrAfter
      When the ACS checks the assertion's time window
      Then the time check passes

    @REQ-EA-891
    Scenario: An assertion past its NotOnOrAfter beyond the skew tolerance is rejected
      Given a configured skew tolerance of 60 seconds
      And the server clock is 61 seconds after the assertion's NotOnOrAfter
      When the ACS checks the assertion's time window
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-892
    Scenario: An assertion whose NotBefore is in the future beyond the skew tolerance is rejected
      Given a configured skew tolerance of 60 seconds
      And the server clock is 61 seconds before the assertion's NotBefore
      When the ACS checks the assertion's time window
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-893
    Scenario: A clock difference within the skew tolerance is tolerated
      Given a configured skew tolerance of 60 seconds
      And the server clock is 30 seconds after the assertion's NotOnOrAfter
      When the ACS checks the assertion's time window
      Then the time check passes

    @REQ-EA-894
    Scenario: A SubjectConfirmationData NotOnOrAfter in the past is rejected
      Given the assertion's Conditions window is valid but its SubjectConfirmationData NotOnOrAfter is past
      When the ACS checks the assertion's time window
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-895
    Scenario: An assertion without a NotOnOrAfter is rejected
      Given an assertion that carries no NotOnOrAfter
      When the ACS checks the assertion's time window
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-896
    Scenario: The skew tolerance defaults to 60 seconds and cannot be configured above 300 seconds
      Given a SAML connection with no skew tolerance configured
      Then the effective skew tolerance is 60 seconds
      When a skew tolerance of 301 seconds is configured
      Then the configuration is refused

  # BEH-EA-244 — spec/behaviors/29-saml-sp.md; see also BEH-EA-058
  @BEH-EA-244
  Rule: `InResponseTo` matches a stored, single-consume request id

    @REQ-EA-897
    Scenario: SP-initiated login reserves the AuthnRequest id before redirecting
      Given a SAML connection "acme"
      When a login is started on connection "acme"
      Then the AuthnRequest id is reserved in Verification, bound to "acme", with a short TTL
      And the redirect to the identity provider happens after the reservation

    @REQ-EA-898
    Scenario: A response whose InResponseTo is a live reserved id for the same connection is accepted, once
      Given a login was solicited on connection "acme" with AuthnRequest id "req-1"
      When the ACS receives a response with InResponseTo "req-1" for connection "acme"
      Then the InResponseTo check passes
      And the reserved id "req-1" is consumed

    @REQ-EA-899
    Scenario: A replay of an already-consumed request id is rejected
      Given a login was solicited on connection "acme" with AuthnRequest id "req-1"
      And a response with InResponseTo "req-1" was already accepted
      When the same response is presented again
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-900
    Scenario: An unknown InResponseTo is rejected
      When the ACS receives a response with InResponseTo "never-issued" for connection "acme"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-901
    Scenario: An expired reserved request id is rejected
      Given a login was solicited on connection "acme" with AuthnRequest id "req-1"
      And the reservation's TTL has elapsed
      When the ACS receives a response with InResponseTo "req-1" for connection "acme"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-902
    Scenario: A request id reserved for another connection is rejected
      Given a login was solicited on connection "acme" with AuthnRequest id "req-1"
      When the ACS receives a response with InResponseTo "req-1" for connection "globex"
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-903
    Scenario: An unsolicited (IdP-initiated) response is refused by default
      Given a SAML connection that has not opted in to IdP-initiated login
      When the ACS receives a response with no InResponseTo
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

    @REQ-EA-904
    Scenario: An unsolicited response is accepted only when the connection explicitly opts in
      Given a SAML connection that explicitly opts in to IdP-initiated login
      When the ACS receives an otherwise valid response with no InResponseTo
      Then the InResponseTo check passes

  # BEH-EA-245 — spec/behaviors/29-saml-sp.md; see also INV-EA-015, BEH-EA-123
  @BEH-EA-245
  Rule: The NameID links to an account through the connection, never by email alone

    @REQ-EA-905
    Scenario: A returning NameID resolves to the account linked under the connection's provider id
      Given an account linked under providerId "saml:org-1:conn-1" with NameID "name-1"
      When a fully validated response for connection "conn-1" of "org-1" carries NameID "name-1"
      Then the sign-in resolves to that account

    @REQ-EA-906
    Scenario: A first sign-in may create the user and link it
      Given a fully validated response carrying a NameID no account is linked to
      When the ACS resolves the account
      Then a user is created and linked under the connection's provider id and that NameID

    @REQ-EA-907
    Scenario: An email attribute alone never links to an existing local account
      Given an existing local account "victim@acme.example"
      And a fully validated response whose email attribute is "victim@acme.example" and whose NameID is unlinked
      When the ACS resolves the account
      Then the existing account is not linked
      And the sign-in does not resolve to "victim@acme.example"

    @REQ-EA-908
    Scenario: A deployment's explicit linking policy that trusts the connection may link by email
      Given an existing local account "ada@acme.example"
      And a linking policy that trusts the connection
      When a fully validated response whose email attribute is "ada@acme.example" is resolved
      Then the account is linked under the connection's provider id

    @REQ-EA-909
    Scenario: The same NameID on two connections resolves to two different accounts
      Given a NameID "name-1" linked under connection "conn-1" of "org-1"
      When a fully validated response for connection "conn-2" of "org-2" carries NameID "name-1"
      Then the sign-in does not resolve to the account of "conn-1"

    @REQ-EA-910
    Scenario: A suspended account is refused before a session is minted
      Given an account linked to a NameID and suspended
      When a fully validated response carries that NameID
      Then "Users.assertCanSignIn" refuses the sign-in
      And no session is minted
