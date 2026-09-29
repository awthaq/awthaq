# SAML Service Provider
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-29 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release — the ordered validation chain adopted before any code exists (SFS-007, SFS-003; [ADR-EA-023](../decisions/023-enterprise-federation-packages.md)) <br> 1.1 (2026-09-29): implemented as `@awthaq/saml` over the `XmlSignature` port (SFS-003): the port is generic XML-DSig (the SAML assertion reader is the plugin's), the request is bound to the browser by a state cookie, assertion ids are one-time, and linking by email is a per-connection flag |
---

> `@awthaq/saml` implements this ([MOD-EA-010](../models/10-saml.md)). It was written first on purpose — SAML's failure modes are silent signature bypasses, so the checks and their order were fixed before an implementation could drift — and every rule below has a negative test, including the XML signature-wrapping (XSW) corpus from the SAML security literature (`packages/saml/test/XmlSignatureNode.test.ts`). The signature step is the `XmlSignature` port (`@awthaq/ports`), implemented over the maintained `xml-crypto` library (Node adapter in `@awthaq/saml`); the plugin reads the assertion ONLY from the signed bytes that port returns.

The chain runs on `POST /auth/saml/acs` and is ordered **cheap and structural checks before cryptography**, so an attacker cannot make the server spend signature-verification CPU on a payload that fails a size or shape rule. Every failure surfaces as one uniform `SamlAssertionRejected`; the specific reason is logged and published as `auth.user.signInFailed` (reason `assertionInvalid`), never returned (no validation oracle). BEH-EA-238, 239 and 240 are also the mitigation list for the two classic SAML attack classes: XML canonicalization and signature-wrapping (XSW).

## BEH-EA-238: The SAML response is size-capped before it is parsed

```text
REQUIREMENT: The ACS MUST refuse a `SAMLResponse` whose decoded size exceeds a
             configured cap (default 256 KiB) BEFORE any XML parsing, and MUST
             refuse an inflated payload whose expansion exceeds the same cap
             (a decompression-bomb guard for the redirect binding's DEFLATE).
```

A parser handed unbounded attacker input is a denial-of-service surface independent of any signature bug; the cap is the first, cheapest line.

_Previous: [BEH-EA-237](28-tenancy.md#beh-ea-237-a-suspended-organization-refuses-organization-scoped-access) | Next: [BEH-EA-239](29-saml-sp.md#beh-ea-239-the-document-is-parsed-with-dtds-and-external-entities-disabled-and-carries-exactly-one-assertion)_

## BEH-EA-239: The document is parsed with DTDs and external entities disabled, and carries exactly one assertion

```text
REQUIREMENT: Parsing MUST occur inside `XmlSignature.verify` with DTD
             processing and external entity resolution disabled (a document with
             a DOCTYPE is rejected outright: no XXE, no billion-laughs), and with
             comments and processing instructions refused (a comment inside a
             signed value is how a verifier and a reader come to disagree about a
             NameID). The response MUST contain exactly one `Assertion` element
             anywhere in the document; zero or more than one MUST be rejected
             before any signature work (the cardinality check that removes the
             ambiguity signature-wrapping depends on), and an
             `EncryptedAssertion` MUST be refused.
```

Signature wrapping works by presenting a *valid* signature over one element while the application consumes another; with exactly one assertion permitted there is no "another" to consume. Encrypted assertions are out of scope until a decryption port exists and are rejected.

_Previous: [BEH-EA-238](29-saml-sp.md#beh-ea-238-the-saml-response-is-size-capped-before-it-is-parsed) | Next: [BEH-EA-240](29-saml-sp.md#beh-ea-240-the-signature-is-verified-over-the-element-that-is-processed-with-an-algorithm-allow-list)_

## BEH-EA-240: The signature is verified over the element that is processed, with an algorithm allow-list

```text
REQUIREMENT: `XmlSignature.verify` MUST verify an XML-DSig signature that
             covers the Assertion (or the Response that contains exactly that
             one Assertion) and MUST return only the canonical bytes of the
             element the verified signature covers — never a DOM of the input
             and never a re-query of the document; the assertion is read from
             those bytes alone. The `Reference` URI MUST be a same-document
             `#ID` resolving to exactly one element (an ID that occurs twice in
             the document is refused), and the Signature MUST be that element's
             own child. Canonicalization is exclusive C14N, handled inside the
             port; the only transforms are enveloped-signature and exclusive
             C14N (XSLT and XPath are refused by name). The signature and digest
             algorithms MUST be on an allow-list (RSA-SHA256 or SHA-512; SHA-1
             and HMAC refused). The signing certificate MUST be in the
             connection's trust set (matched by SHA-256 fingerprint) and inside
             its `notBefore`/`notAfter` window, so an IdP rotating its key can
             trust both certificates for an overlap; a certificate the document
             names in its own `KeyInfo` MUST never be used to verify and, if it
             is not pinned, refuses the document.
```

This is the fused parse-and-verify contract ([MOD-EA-010](../models/10-saml.md), "The `XmlSignature` port"): no unverified intermediate DOM escapes, so the wrapping class is unrepresentable rather than merely tested for. No home-grown crypto — the port's implementation is `xml-crypto`, a maintained XML-DSig library evaluated before adoption ([ADR-EA-023](../decisions/023-enterprise-federation-packages.md) Decision 3); the adapter's own contribution is the policy around it (allow-lists, pinning, structure, ID uniqueness) and a pruned algorithm registry inside the library.

_Previous: [BEH-EA-239](29-saml-sp.md#beh-ea-239-the-document-is-parsed-with-dtds-and-external-entities-disabled-and-carries-exactly-one-assertion) | Next: [BEH-EA-241](29-saml-sp.md#beh-ea-241-the-issuer-must-be-the-connections-identity-provider)_

## BEH-EA-241: The issuer must be the connection's identity provider

```text
REQUIREMENT: The verified assertion's `Issuer` MUST equal the connection's
             `idpEntityId` exactly; a mismatch MUST be rejected. The trust set
             used in BEH-EA-240 MUST be the one of the connection the response
             was solicited for (BEH-EA-244), never one selected by a value inside
             the unverified document.
```

A response signed by *some* trusted IdP but presented on another organization's connection must not authenticate anyone there.

_Previous: [BEH-EA-240](29-saml-sp.md#beh-ea-240-the-signature-is-verified-over-the-element-that-is-processed-with-an-algorithm-allow-list) | Next: [BEH-EA-242](29-saml-sp.md#beh-ea-242-audience-recipient-and-destination-must-name-this-service-provider)_

## BEH-EA-242: Audience, Recipient and Destination must name this service provider

```text
REQUIREMENT: The assertion's `AudienceRestriction` MUST contain the SP's entity
             id, the `SubjectConfirmationData.Recipient` MUST equal the ACS URL,
             and the Response `Destination` (when present) MUST equal the ACS
             URL. Bearer `SubjectConfirmation` is the only accepted method.
             Any mismatch MUST be rejected.
```

These bind an assertion to *this* consumer; without them an assertion minted for a different SP the same IdP serves could be replayed here.

_Previous: [BEH-EA-241](29-saml-sp.md#beh-ea-241-the-issuer-must-be-the-connections-identity-provider) | Next: [BEH-EA-243](29-saml-sp.md#beh-ea-243-the-assertions-time-window-is-enforced-with-bounded-clock-skew)_

## BEH-EA-243: The assertion's time window is enforced with bounded clock skew

```text
REQUIREMENT: `Conditions.NotBefore`/`NotOnOrAfter` and
             `SubjectConfirmationData.NotOnOrAfter` MUST be enforced against the
             server clock with a configured skew tolerance (default 60 s,
             maximum 300 s); an assertion outside the window MUST be rejected. An
             assertion without a `NotOnOrAfter` MUST be rejected.
```

An unbounded assertion is a bearer credential that never expires; the time window is what makes replay of a captured one finite.

_Previous: [BEH-EA-242](29-saml-sp.md#beh-ea-242-audience-recipient-and-destination-must-name-this-service-provider) | Next: [BEH-EA-244](29-saml-sp.md#beh-ea-244-inresponseto-matches-a-stored-single-consume-request-id)_

## BEH-EA-244: `InResponseTo` matches a stored, single-consume request id

```text
REQUIREMENT: SP-initiated login MUST reserve the AuthnRequest id in
             `Verification` (bound to the connection, with a short TTL) before
             redirecting, and MUST hand the browser the request's state in a
             `__Host-saml-request` cookie (`SameSite=None`: the IdP's POST is
             cross-site). The ACS MUST consume that state exactly once — the
             connection and the trust set come from it, never from the
             document — and MUST require the assertion's `InResponseTo` to equal
             the id it reserved; an absent cookie (an unsolicited, IdP-initiated
             response, or a login-CSRF attempt that posts an attacker's own
             valid response into another browser), an unknown, expired,
             already-consumed or other-connection id MUST be rejected.
             Unsolicited responses are refused in this build. An assertion's own
             `ID` MUST also be accepted once (reserved in `Verification` until it
             could no longer pass the time window): a replay under a fresh
             request id fails.
```

The single-consume request id is the replay defense the assertion alone cannot provide: even a perfectly valid, unexpired assertion works once, for the login that asked for it.

_Previous: [BEH-EA-243](29-saml-sp.md#beh-ea-243-the-assertions-time-window-is-enforced-with-bounded-clock-skew) | Next: [BEH-EA-245](29-saml-sp.md#beh-ea-245-the-nameid-links-to-an-account-through-the-connection-never-by-email-alone)_

## BEH-EA-245: The NameID links to an account through the connection, never by email alone

```text
REQUIREMENT: After every check above passes, the account MUST be resolved by
             `(providerId = "saml:<organizationId>:<connectionId>", NameID)` in
             `Accounts`, exactly the `(providerId, subject, issuer)` anchor OAuth
             uses ([INV-EA-015](../invariants.md#inv-ea-015-the-provider-subject-issuer-tuple-is-unique-per-account-and-the-oauth-state--pkce-verifier-is-single-use)).
             A first sign-in MAY create the user and link it; it MUST NOT link to
             an existing account merely because an attribute carries the same
             email unless the connection's explicit `trustsEmail` policy allows
             it AND the local account's own address is already verified. The
             sign-in acts as the connection's organization (the tenant) and
             MUST go through `Users.assertCanSignIn`
             ([BEH-EA-46](06-domain-users-accounts.md)) before a session is
             minted.
```

The IdP asserts an identity *within its own directory*; treating its email attribute as proof of ownership of a local account would let any organization's IdP take over accounts by email, the same account-linking rule ([BEH-EA-123](16-oauth.md)) OAuth applies.

_Previous: [BEH-EA-244](29-saml-sp.md#beh-ea-244-inresponseto-matches-a-stored-single-consume-request-id) | Next: [BEH-EA-246](30-scim.md#beh-ea-246-a-scim-connection-authenticates-by-a-hashed-revocable-bearer-token-and-scopes-everything-it-reads)_
