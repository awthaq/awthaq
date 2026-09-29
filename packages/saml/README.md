# @awthaq/saml

**SAML 2.0 service provider (SP only)**: an organization's users sign in through the organization's own identity provider (Okta, Entra ID, Google Workspace, ADFS). Specified in [`spec/behaviors/29-saml-sp.md`](../../spec/behaviors/29-saml-sp.md) (BEH-EA-238 through 245) and [`spec/models/10-saml.md`](../../spec/models/10-saml.md); the decisions, including the XML-signature library evaluation, are [ADR-EA-023](../../spec/decisions/023-enterprise-federation-packages.md). awthaq never acts as an identity provider.

```ts
const auth = Auth.make([Organization.Organization, Saml.Saml]); // Saml dependsOn [Organization]

Saml.Saml.layer.pipe(
  Layer.provide(Saml.config({ baseUrl: "https://app.example.com" })), // required: it decides the audience and the ACS URL
  Layer.provideMerge(SamlConnections.layerStore),
  Layer.provideMerge(SamlRecords.layerSql), // or layerMemory; run the plugin's migrations
  Layer.provideMerge(XmlSignatureNode.layer), // the XmlSignature port over xml-crypto
  /* + Organization and its records, Users/Accounts/Sessions/Verification, RateLimiter, ClientAddress, Crypto */
);
```

## A connection

`SamlConnectionStore.create({ organizationId, name, idp, emailDomains?, trustsEmail? })` registers one organization's IdP, either from its metadata (`idp: { metadataXml }`) or by hand (`{ entityId, ssoUrl, certificates }`). There is no HTTP CRUD (like `@awthaq/scim`'s connections): the trust boundary is who may call the store.

- The **trust set** is the IdP's signing certificates: each parsed as X.509 (RSA, at least 2048 bits), stored with its SHA-256 fingerprint and its own validity window. To rotate the IdP's key, `update(id, { certificates: [old, next] })` before the IdP starts signing with the next, and `update(id, { certificates: [next] })` after; the old key's signatures stop at once.
- The **SSO URL** is `https` only, no credentials, no private address (the browser is redirected there).
- An **email domain** routes to exactly one connection (`discover({ email })`): home-realm discovery for an "Sign in with SSO" button.
- **`trustsEmail`** (default off) is the connection's explicit linking policy (BEH-EA-245): a first sign-in may link to an existing local account with the asserted email only when that account's own address is already verified.

Give the IdP administrator `GET /auth/saml/metadata?connection=<id>` (entity id `<baseUrl>/auth/saml/sp/<id>`, ACS `<baseUrl>/auth/saml/acs`, `WantAssertionsSigned="true"`).

## The flow

1. `GET /auth/saml/login?connection=<id>&callbackURL=/dashboard` reserves the AuthnRequest id, redirects to the IdP (HTTP-Redirect binding) and sets the `__Host-saml-request` cookie (`SameSite=None`: the IdP's POST is cross-site).
2. `POST /auth/saml/acs` (`SAMLResponse` as a form): the chain below, then `302` to the callback with the session cookie. The session, and the user it creates on a first sign-in, belong to the connection's organization (`tenantScoped`, ADR-EA-018).

**Every failure at the ACS is the same `400 SamlAssertionRejected` with no detail.** Which check failed is logged (`awthaq/saml: assertion rejected`) and published as `auth.user.signInFailed` (`reason: "assertionInvalid"`, strategy `saml:<organizationId>:<connectionId>`).

## The chain, and what each step defends

| Step | Refuses |
| --- | --- |
| The state cookie names a login this server started | an unsolicited (IdP-initiated) response; login CSRF (an attacker's own valid response posted into a victim's browser) |
| Size cap, before base64 and before any parser | memory/CPU amplification |
| The request id is consumed once, and names the connection: the trust set is what THIS server stored | replay; a document choosing its own trust set |
| `XmlSignature.verify` | DOCTYPE/XXE/entities, comments, processing instructions; more or fewer than one Assertion; a duplicated ID; a signature that is not its element's child; SHA-1/HMAC; XSLT/XPath transforms; an unpinned or out-of-window certificate (a certificate the document names is never a key); any extra signature that does not verify |
| The assertion is read ONLY from the signed bytes the port returned | signature wrapping (XSW): a forged assertion the signature does not cover is never read |
| Issuer = the connection's IdP; every audience restriction names this SP; bearer confirmation to this ACS answering this request id; `NotOnOrAfter` required, skew bounded (60 s, max 300 s) | another IdP's or another SP's assertion; a captured assertion after its window |
| The assertion's `ID` is accepted once | a replay of a captured assertion under a fresh request id |
| Account `(saml:<org>:<connection>, NameID, issuer)`; never linked by email alone; `Users.assertCanSignIn` before a session | account takeover through an IdP-asserted email; a suspended user |

## Why `xml-crypto`, and what surrounds it

The adapter (`XmlSignatureNode`) wraps [`xml-crypto`](https://github.com/node-saml/xml-crypto) 6.3.2, pinned exactly. It has had three critical signature-bypass advisories (all fixed by 6.0.1) and is the engine under `@node-saml/node-saml`; `samlify` and `node-saml` were rejected because they would put their own validation chain on the trust boundary in place of the spec's. So the library is trusted only through the policy around it: a lexical gate before any parser, the caller's cardinality policy, unique IDs, structure checked before any cryptography, `getCertFromKeyInfo` disabled (the library otherwise prefers the document's own certificate), fingerprint pinning inside validity windows, every signature required to verify, algorithm registries pruned to the allow-list, and the result read only from `getSignedReferences()`. The negative-test corpus in `test/XmlSignatureNode.test.ts` (the XSW patterns from the SAML security literature, algorithm downgrades, transform tricks, XXE, comment injection) is what an upgrade of the library must keep passing.

## Not built

Signed AuthnRequests (the metadata says `AuthnRequestsSigned="false"`); IdP-initiated login (refused); single logout; encrypted assertions (refused); attribute mapping beyond the email/name attributes; an HTTP CRUD surface for connections; organization role mapping (qadi's, ADR-EA-009); the `Sso` dispatcher. `RelayState` is accepted and ignored: the return path is held server-side. A session cookie in `SameSite=Strict` mode is not sent on the first navigation after a cross-site POST, as with any federated sign-in; use the default or `Lax` mode, or land on a page that re-navigates.
