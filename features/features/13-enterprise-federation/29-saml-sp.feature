# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# Wired against the real `@awthaq/saml` plugin: SP-initiated login, then the ACS chain against responses the fixtures'
# IdP signs (features/step-definitions/SamlWorld.ts). The wire only ever shows the uniform SamlAssertionRejected, so a
# rejection scenario also checks the REASON the ACS logged, to tell "rejected by the rule under test" from "rejected
# for some other reason". IdP-initiated login is not built (packages/saml README, "Not built"): that one scenario is
# pruned with its own note.

@enterprise-federation @saml
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

    # PV-370: IdP-initiated login is not offered (packages/saml/src/Saml.ts header and README "Not built"), so
    # there is no per-connection opt-in to enable: no configuration of a connection admits an unsolicited response.
    @REQ-EA-904
    Scenario: No configuration of a connection admits an unsolicited response
      Given a fully configured SAML connection, with every setting the plugin offers
      When the ACS receives a response with no InResponseTo
      Then the response is rejected with the uniform "SamlAssertionRejected" failure

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
      Given an existing local account "ada@acme.example" whose address is verified
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

  # BEH-EA-314 — spec/behaviors/29-saml-sp.md; see also BEH-EA-244, ADR-EA-019
  @BEH-EA-314
  Rule: A connection can sign its AuthnRequests with an SP key that is stored sealed, and never falls back to unsigned

    @REQ-EA-1215
    Scenario: A signing connection's login redirect is signed, and the signature verifies under the certificate its metadata publishes
      Given the connection "acme" signs its AuthnRequests
      When the browser starts a login on "acme"
      Then the redirect to the IdP carries an RSA-SHA256 query signature
      And that signature verifies under the certificate published in the metadata of "acme"
      And that signature no longer verifies once the request is altered
      And that signature does not verify under the IdP's own certificate

    @REQ-EA-1216
    Scenario: A connection that does not sign sends no signature and publishes no key
      When the browser starts a login on "acme"
      Then the redirect to the IdP carries no signature
      And the metadata of "acme" declares AuthnRequestsSigned false and publishes no certificate

    @REQ-EA-1217
    Scenario: The private key is stored only as an Encryption envelope bound to its key
      Given the connection "acme" signs its AuthnRequests
      Then the stored signing key of "acme" is a sealed envelope holding no private key material
      And it opens only under its own key id

    @REQ-EA-1218
    Scenario: A rotated key signs from then on while the previous certificate stays published
      Given the connection "acme" signs its AuthnRequests
      And the browser starts a login on "acme"
      When the administrator rotates the SP signing key of "acme"
      Then the metadata of "acme" publishes 2 certificates
      And a new login on "acme" is signed by the newest key only

    @REQ-EA-1219
    Scenario: A key that no longer opens makes the login fail closed instead of sending an unsigned request
      Given the connection "acme" signs its AuthnRequests
      When a newer signing key of "acme" is stored that cannot be opened
      Then starting a login on "acme" is a defect and produces no redirect

  # BEH-EA-315 — spec/behaviors/29-saml-sp.md; see also BEH-EA-239, BEH-EA-240, BEH-EA-244
  @BEH-EA-315
  Rule: Single Logout ends sessions in both directions over the Redirect and POST bindings, verified like an assertion

    @REQ-EA-1220
    Scenario: The IdP's signed LogoutRequest ends the user's session with reason federatedLogout, as the connection's tenant, and is answered Success
      Given the connection "acme" signs its AuthnRequests and has an IdP logout endpoint
      And "ada" is signed in through "acme"
      When the IdP sends a LogoutRequest for "ada" over the Redirect binding
      Then the session of "ada" is ended with the reason "federatedLogout" in the tenant of "acme"
      And the IdP is answered with a signed LogoutResponse of status Success

    @REQ-EA-1221
    Scenario: A LogoutRequest over the POST binding is verified by the same XML-signature port
      Given the connection "acme" has an IdP logout endpoint
      And "ada" is signed in through "acme"
      When the IdP sends a LogoutRequest for "ada" over the POST binding
      Then the session of "ada" is ended with the reason "federatedLogout" in the tenant of "acme"

    @REQ-EA-1222
    Scenario Outline: A LogoutRequest that is not properly signed is refused, and ends nothing
      Given the connection "acme" has an IdP logout endpoint
      And "ada" is signed in through "acme"
      When the IdP sends a LogoutRequest for "ada" over the <binding> binding that <flaw>
      Then the logout is refused with the uniform "SamlLogoutRejected" failure
      And the session of "ada" is still live

      Examples:
        | binding  | flaw                                        |
        | Redirect | is unsigned                                 |
        | Redirect | is signed by another key                    |
        | Redirect | was tampered with after signing             |
        | Redirect | claims the SHA-1 signature algorithm        |
        | Redirect | loses its RelayState after signing          |
        | POST     | is unsigned                                 |
        | POST     | is signed by another key                    |
        | POST     | was tampered with after signing             |
        | POST     | is wrapped with a second, unsigned request  |
        | POST     | carries a DOCTYPE                           |

    @REQ-EA-1223
    Scenario Outline: A validly signed LogoutRequest is still refused when it does not fit this service provider
      Given the connection "acme" has an IdP logout endpoint
      And "ada" is signed in through "acme"
      When the IdP sends a validly signed LogoutRequest for "ada" over the Redirect binding that <flaw>
      Then the logout is refused with the uniform "SamlLogoutRejected" failure
      And the session of "ada" is still live

      Examples:
        | flaw                                    |
        | names another issuer                    |
        | is addressed to another destination     |
        | was issued half an hour ago             |
        | was issued half an hour from now        |
        | has already expired                     |

    @REQ-EA-1224
    Scenario: A replayed LogoutRequest cannot log the user out again
      Given the connection "acme" has an IdP logout endpoint
      And "ada" is signed in through "acme"
      When the IdP sends a LogoutRequest for "ada" over the Redirect binding
      And "ada" signs in again through "acme"
      And the IdP replays the same LogoutRequest
      Then the logout is refused with the uniform "SamlLogoutRejected" failure
      And the new session of "ada" is still live

    @REQ-EA-1225
    Scenario: A SessionIndex ends only that session of the NameID
      Given the connection "acme" has an IdP logout endpoint
      And "ada" is signed in through "acme" with SessionIndex "idx-1"
      And "ada" is signed in through "acme" with SessionIndex "idx-2"
      When the IdP sends a LogoutRequest for "ada" naming only SessionIndex "idx-2"
      Then exactly 1 session of "ada" is ended

    @REQ-EA-1226
    Scenario: The user's own logout ends the local session first, then sends the IdP a signed LogoutRequest
      Given the connection "acme" signs its AuthnRequests and has an IdP logout endpoint
      And "ada" is signed in through "acme"
      When "ada" logs out through "acme"
      Then the session of "ada" is ended with the reason "signOut" in the tenant of "acme"
      And the IdP receives a signed LogoutRequest naming "ada" and the SessionIndex of that sign-in

    @REQ-EA-1227
    Scenario: The IdP's LogoutResponse finishes our own logout once, and only when it answers that request
      Given the connection "acme" has an IdP logout endpoint
      And "ada" is signed in through "acme"
      And "ada" logs out through "acme"
      When the IdP answers our LogoutRequest with a signed LogoutResponse
      Then the browser lands back on the application
      When the IdP answers our LogoutRequest with a signed LogoutResponse
      Then the logout is refused with the uniform "SamlLogoutRejected" failure

    @REQ-EA-1228
    Scenario: A LogoutResponse that answers another request is refused
      Given the connection "acme" has an IdP logout endpoint
      And "ada" is signed in through "acme"
      And "ada" logs out through "acme"
      When the IdP answers a different request with a signed LogoutResponse
      Then the logout is refused with the uniform "SamlLogoutRejected" failure

    @REQ-EA-1229
    Scenario: A connection whose IdP offers no logout endpoint refuses logout messages and logs the user out locally
      Given "ada" is signed in through "acme"
      When the IdP sends a LogoutRequest for "ada" over the Redirect binding
      Then the logout is refused with the uniform "SamlLogoutRejected" failure
      When "ada" logs out through "acme"
      Then the session of "ada" is ended with the reason "signOut" in the tenant of "acme"
      And the browser is sent straight back to the application

  # BEH-EA-316 — spec/behaviors/29-saml-sp.md; see also BEH-EA-288 (canGrant), ADR-EA-025
  @BEH-EA-316
  Rule: An assertion's groups map to organization roles under a ceiling, guarded by the canGrant rule

    @REQ-EA-1230
    Scenario: A group is mapped to a role within the connection's ceiling, and defaults apply otherwise
      Given the connection "acme" maps the group "admins" to the role "admin" under the ceiling "admin" with the default role "member"
      When "ada" signs in through "acme" carrying the groups "eng, admins"
      And "grace" signs in through "acme" carrying the groups "eng"
      Then "ada" holds the role "admin" in the organization of "acme"
      And "grace" holds the role "member" in the organization of "acme"

    @REQ-EA-1231
    Scenario: A connection with no mapping changes no membership
      When "ada" signs in through "acme" carrying the groups "admins"
      Then "ada" holds no role in the organization of "acme"

    @REQ-EA-1232
    Scenario Outline: A mapping that could mint owner or exceed its ceiling is refused when the connection is written
      When an administrator writes the connection "second" of "acme" mapping the group "g" to the role "<role>" under the ceiling "<ceiling>"
      Then the connection is refused as "<reason>"

      Examples:
        | role   | ceiling | reason                                              |
        | owner  | owner   | may not confer owner                                |
        | admin  | member  | more than the connection's role ceiling             |
        | owner  | admin   | may not confer owner                                |
        | wizard | admin   | does not have                                       |

    @REQ-EA-1233
    Scenario: A mapping rewritten around the store still cannot mint owner at sign-in
      Given the connection "acme" maps the group "admins" to the role "admin" under the ceiling "admin" with the default role "member"
      And the mapping of "acme" is rewritten in the records to give owner to the group "admins" under the ceiling "admin"
      When "ada" signs in through "acme" carrying the groups "admins"
      Then "ada" is signed in
      And "ada" holds no role in the organization of "acme"

    @REQ-EA-1234
    Scenario: An organization's owner is never reshaped by an IdP whose ceiling is lower
      Given the connection "acme" maps the group "admins" to the role "admin" under the ceiling "admin" with the default role "member"
      And "ada" is the only owner of the organization of "acme" and trusts the connection's email
      When "ada" signs in through "acme" carrying the groups "admins"
      Then "ada" holds the role "owner" in the organization of "acme"

  # BEH-EA-317 — spec/behaviors/29-saml-sp.md; see also BEH-EA-235, ADR-EA-023
  @BEH-EA-317
  Rule: The Sso dispatcher routes an email domain across OIDC and SAML connections to the owning plugin's login URL

    @REQ-EA-1235
    Scenario Outline: An email domain routes to the protocol that owns it
      Given the organization "acme" has a <protocol> connection for the domain "acme.example"
      When the Sso dispatcher is asked where "ada@acme.example" signs in
      Then it answers the <protocol> login URL of that connection

      Examples:
        | protocol |
        | SAML     |
        | OIDC     |

    @REQ-EA-1236
    Scenario Outline: When both protocols route the same domain the preference decides and the conflict is listed
      Given the Sso preference is <preferred>
      And the organization "acme" has a SAML connection for the domain "acme.example"
      And the organization "acme" has a OIDC connection for the domain "acme.example"
      When the Sso dispatcher is asked where "ada@acme.example" signs in
      Then it answers the <preferred> login URL of that connection
      And it lists both protocols for the address

      Examples:
        | preferred |
        | SAML      |
        | OIDC      |

    @REQ-EA-1237
    Scenario: Nothing routing is one uniform not-found, whatever the reason
      Given the organization "acme" has a SAML connection for the domain "acme.example"
      Then asking where "ada@other.example" signs in is refused as "SsoNotFound"
      And asking where "" signs in is refused as "SsoNotFound"

  # BEH-EA-318 — spec/behaviors/29-saml-sp.md; see also BEH-EA-281, BEH-EA-309
  @BEH-EA-318
  Rule: The administrator manages connections fail-closed, tenant-scoped, importing IdP metadata with pinned certificates

    @REQ-EA-1238
    Scenario: With no gate configured every administrative operation is denied, audited, and touches nothing
      Given the connection "acme" exists
      When the administrator attempts every SAML admin operation
      Then all 8 are refused as "SamlActionDenied"
      And each refusal published auth.admin.actionDenied naming "saml.<action>"
      And the connection "acme" is unchanged

    @REQ-EA-1239
    Scenario: Pasted IdP metadata pins its certificates and offers its logout endpoint
      Given the administrator gate allows every action
      When the administrator creates a connection for "acme" from IdP metadata listing two certificates and a logout endpoint
      Then the connection pins both certificate fingerprints and the logout endpoint
      And a creation audit event names the administrator and the connection

    @REQ-EA-1240
    Scenario: A refresh from metadata replaces the trust set, so the old key stops signing in
      Given the administrator gate allows every action
      And the connection "acme" was imported from IdP metadata
      When the IdP metadata is refreshed with only the next certificate
      Then the connection trusts only the next certificate

    @REQ-EA-1241
    Scenario: A refresh from metadata that names another entity is refused and changes nothing
      Given the administrator gate allows every action
      And the connection "acme" was imported from IdP metadata
      When the IdP metadata is refreshed naming another entity
      Then the refresh is refused as "InvalidSamlConnectionRequest"
      And the connection still trusts the original certificate

    @REQ-EA-1242
    Scenario: Another tenant's connection is answered like one that does not exist
      Given the administrator gate allows every action
      And the connection "acme" exists
      And a second organization "globex" exists
      When an administrator acting inside "globex" reads the connection "acme"
      Then the read is refused as "SamlConnectionNotFound", exactly as for an unknown id

    @REQ-EA-1243
    Scenario: An update's audit event names the fields, never their values
      Given the administrator gate allows every action
      And the connection "acme" exists
      When the administrator renames the connection "acme" to "a very private new name" and disables its email linking
      Then the update audit event names the fields "name" and "trustsEmail" and no value
