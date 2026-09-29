# SAML Service Provider
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-29 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release — the ordered validation chain adopted before any code exists (SFS-007, SFS-003; [ADR-EA-023](../decisions/023-enterprise-federation-packages.md)) <br> 1.1 (2026-09-29): implemented as `@awthaq/saml` over the `XmlSignature` port (SFS-003): the port is generic XML-DSig (the SAML assertion reader is the plugin's), the request is bound to the browser by a state cookie, assertion ids are one-time, and linking by email is a per-connection flag <br> 1.2 (2026-09-29): signed AuthnRequests and the SP signing key at rest (BEH-EA-314), Single Logout in both directions (306), role mapping under a ceiling (307), the `Sso` dispatcher (308) and the administrator's connection CRUD with metadata import (309); IdP-initiated login and encrypted assertions stay refused, as a recorded decision ([ADR-EA-036](../decisions/036-saml-refusals-are-decisions.md)) |
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
             Unsolicited responses are refused in this build, and no connection setting admits one (PV-370: IdP-initiated login is not offered, by decision: [ADR-EA-036](../decisions/036-saml-refusals-are-decisions.md)). An assertion's own
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

## BEH-EA-314: A connection can sign its AuthnRequests with an SP key that is stored sealed, and never falls back to unsigned

```text
REQUIREMENT: A connection with `authnRequestsSigned` MUST send every AuthnRequest
             over the HTTP-Redirect binding with a query-string signature
             (`SigAlg` = RSA-SHA256, `Signature` over the exact octets
             `SAMLRequest=..[&RelayState=..]&SigAlg=..`, SAML bindings 3.4.4.1)
             made with the connection's SP signing key, and its SP metadata MUST
             say `AuthnRequestsSigned="true"` and publish every unexpired SP
             certificate as `KeyDescriptor use="signing"`. Enabling the flag MUST
             generate a key when the connection has none (RSA 2048, a self-signed
             X.509 certificate valid `signingKeyValidityDays`, default five
             years); an operator MAY instead import a pair, which MUST be RSA of
             at least 2048 bits with a certificate for THAT key. The private key
             MUST be stored only as an `Encryption` envelope whose additional
             authenticated data names the key, and MUST never appear in an API
             response, an event or a log. The newest unexpired key signs; the
             older certificates stay published until they expire (a rotation
             overlap). A connection that signs and has no usable key (all
             expired, or one that does not decrypt) MUST fail the login as a
             defect, never send it unsigned. An IdP whose metadata says
             `WantAuthnRequestsSigned="true"` makes the flag default on.
```

The redirect binding forbids an enveloped XML signature, so the signature covers the query octets; the same key signs Single Logout messages (BEH-EA-315) when the connection has one. The negative tests are the verifier's side of it: a signature that fails after any change to the message, under another key, or under a downgraded `SigAlg`.

_Previous: [BEH-EA-245](29-saml-sp.md#beh-ea-245-the-nameid-links-to-an-account-through-the-connection-never-by-email-alone) | Next: [BEH-EA-315](29-saml-sp.md#beh-ea-315-single-logout-ends-sessions-in-both-directions-over-the-redirect-and-post-bindings-verified-like-an-assertion)_

## BEH-EA-315: Single Logout ends sessions in both directions over the Redirect and POST bindings, verified like an assertion

```text
REQUIREMENT: Each connection MUST record, per sign-in, the NameID and SessionIndex
             the IdP knows the session by. `GET|POST /auth/saml/slo/:connection`
             MUST accept a `LogoutRequest` or a `LogoutResponse` (exactly one),
             and MUST refuse, with ONE uniform `SamlLogoutRejected` (reason
             logged and published as `auth.saml.logoutRejected`, never
             answered): a message that is unsigned; whose Redirect signature does
             not verify over the raw parameters the sender encoded (a changed,
             re-ordered, added or dropped parameter, or a `SigAlg` off the
             RSA-SHA256/512 allow-list); whose POST XML signature does not
             verify through the `XmlSignature` port under the connection's
             pinned trust set (XSW, a duplicated element, a signature over
             another element, a DOCTYPE or comment refused as at the ACS); whose
             Issuer is not the connection's IdP; whose `Destination` is not this
             connection's own logout endpoint; whose `IssueInstant` is outside
             `logoutFreshness` (default 5 minutes, skew added) or whose
             `NotOnOrAfter` has passed; whose id was accepted before (one-time,
             so a captured request cannot log the user out again); or for a
             connection whose IdP has no logout endpoint. A valid LogoutRequest MUST
             revoke every session the connection recorded for the NameID (only the
             named SessionIndexes when given) with reason `federatedLogout`, as the
             connection's organization tenant, and answer a `LogoutResponse`
             (Success, also when nothing matched) over the IdP's binding, signed
             with the SP key when the connection has one. SP-initiated: `POST
             /auth/saml/logout` (authenticated, CSRF) MUST end the caller's session
             first (reason `signOut`, as the tenant), expire the session cookie,
             and, when the connection has a logout endpoint, send the IdP a
             `LogoutRequest` naming the NameID and SessionIndex; the IdP's
             `LogoutResponse` MUST answer THAT request id (reserved single-use in
             `Verification`, bound to the browser by the `__Host-saml-logout`
             cookie, `SameSite=None`) and only then lands the browser on the
             callback (checked like a login's). A connection with no logout
             endpoint logs the user out locally and redirects to the callback.
```

A logout endpoint that accepted unsigned messages would be a way for anyone to end anyone's sessions; freshness and one-time ids are what keep a signed capture from being replayed at leisure.

_Previous: [BEH-EA-314](29-saml-sp.md#beh-ea-314-a-connection-can-sign-its-authnrequests-with-an-sp-key-that-is-stored-sealed-and-never-falls-back-to-unsigned) | Next: [BEH-EA-316](29-saml-sp.md#beh-ea-316-an-assertions-groups-map-to-organization-roles-under-a-ceiling-guarded-by-the-cangrant-rule)_

## BEH-EA-316: An assertion's groups map to organization roles under a ceiling, guarded by the canGrant rule

```text
REQUIREMENT: A connection MAY carry a role mapping: rules (`{ attribute, value?,
             roles }`, the attribute matched case-insensitively across every value
             of a multi-valued attribute), a `ceiling` (default `["member"]`) and
             `defaultRoles`. After a sign-in has passed every check and
             `Users.assertCanSignIn`, the roles of the matching rules (else the
             defaults; else nothing) MUST become the user's roles in the
             connection's organization (`Organization.syncMemberRoles`): the
             membership is added, or re-roled. The conferred roles MUST be within
             the ceiling by RRM-001's `canGrant` rule (the statements they hold
             MUST be held by the ceiling), so a connection whose ceiling does not
             hold `owner` MUST NOT confer it; a member whose CURRENT roles exceed
             the ceiling MUST NOT be reshaped; the last owner MUST NOT be
             demoted; unknown role names MUST be refused. A mapping that names or
             could confer `owner` MUST be refused when written unless the
             deployment set `allowOwnerRoleMapping` (default off), and any mapping
             MUST be validated against the organization's roles when written. A
             mapping that cannot be applied at sign-in (a role since deleted, a
             member who out-privileges the connection, the last owner, a
             membership limit) MUST be logged and skipped: the user is signed in
             and the roles are not conferred.
```

The IdP proves who the user is, which stays true when a mapping is stale; what it may confer is bounded, never a reason to lock a person out. The ceiling is the caller-less counterpart of the rule every role-assignment path already obeys ([BEH-EA-288](35-organization.md#beh-ea-288-a-role-can-only-be-conferred-by-someone-who-holds-everything-it-grants)): nobody, and no identity provider, gives what it does not hold.

_Previous: [BEH-EA-315](29-saml-sp.md#beh-ea-315-single-logout-ends-sessions-in-both-directions-over-the-redirect-and-post-bindings-verified-like-an-assertion) | Next: [BEH-EA-317](29-saml-sp.md#beh-ea-317-the-sso-dispatcher-routes-an-email-domain-across-oidc-and-saml-connections-to-the-owning-plugins-login-url)_

## BEH-EA-317: The Sso dispatcher routes an email domain across OIDC and SAML connections to the owning plugin's login URL

```text
REQUIREMENT: `POST /auth/sso/start { email | organizationId, callbackURL? }` MUST
             resolve the hint against BOTH `OrganizationConnectionStore.discover`
             (OIDC/OAuth2) and `SamlConnectionStore.discover`, and answer
             `{ protocol, connectionId, organizationId, loginUrl }` where
             `loginUrl` is the owning plugin's own login route
             (`/auth/saml/login?connection=..` or `/oauth/<providerId>/authorize`),
             with `callbackURL` forwarded for that plugin to check. When both
             protocols route the hint, the configured `preferred` protocol
             (default `saml`) MUST win and `Sso.discoverAll` MUST list every match.
             Nothing routing MUST be one uniform `SsoNotFound` whatever the reason
             (unknown domain, unknown organization, malformed or missing hint),
             and the endpoint MUST be rate limited per source address.
```

The dispatcher is a router, not a third protocol: the state cookie, the redirect and every check stay the owning plugin's ([ADR-EA-023](../decisions/023-enterprise-federation-packages.md) Decision 4).

_Previous: [BEH-EA-316](29-saml-sp.md#beh-ea-316-an-assertions-groups-map-to-organization-roles-under-a-ceiling-guarded-by-the-cangrant-rule) | Next: [BEH-EA-318](29-saml-sp.md#beh-ea-318-the-administrator-manages-connections-fail-closed-tenant-scoped-importing-idp-metadata-with-pinned-certificates)_

## BEH-EA-318: The administrator manages connections fail-closed, tenant-scoped, importing IdP metadata with pinned certificates

```text
REQUIREMENT: The `saml.admin` group MUST be admin-tier (BEH-EA-071), behind
             `Api.AdminAuthentication` and CSRF, and every operation (create, list,
             get, update, delete, refresh metadata, rotate or list SP signing keys)
             MUST be gated by `SamlConfig.canManageSaml({ admin, action,
             organizationId? })`, which denies by default: a denial MUST answer
             403, publish `auth.admin.actionDenied` (`saml.<action>`) and reveal
             nothing about which ids exist; past the gate each administrator is
             limited to `adminRate` (429). Inside a tenant only that tenant's
             organization is in reach: another organization's connection MUST be
             answered exactly like an id that does not exist, and registering one
             for another organization like an organization that does not exist.
             A connection MAY be described by hand, by pasted IdP metadata XML, or
             by a metadata URL; the URL MUST pass `OutboundUrl`, be resolved once
             with every answer public and fetched through the pinned connection
             (BEH-EA-312), never follow a redirect, read at most `maxMetadataBytes`
             within `metadataTimeout`, and fail as a CLASS (`invalidUrl`,
             `blocked`, `timeout`, `connect`, `tooLarge`, `status`), never text from
             the far end. The certificates a metadata document lists MUST be
             parsed as X.509 (RSA >= 2048) and pinned by fingerprint; a refresh
             from the stored URL MUST REPLACE the trust set (the metadata is the
             source of truth for its keys) and MUST refuse metadata naming another
             entity id. Every successful mutation MUST publish an audit event of
             identifiers (`auth.saml.connectionCreated`, `connectionUpdated` naming
             the fields changed but never their values, `connectionDeleted`,
             `signingKeyRotated`); a refused or failed operation MUST publish none.
```

Importing metadata is trusting the channel it arrived by, which is why the channel is guarded as hard as a webhook URL and why what is pinned afterwards is the fingerprint, not the document.

_Previous: [BEH-EA-317](29-saml-sp.md#beh-ea-317-the-sso-dispatcher-routes-an-email-domain-across-oidc-and-saml-connections-to-the-owning-plugins-login-url)_
