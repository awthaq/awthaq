# @awthaq/saml

**SAML 2.0 service provider (SP only)**: an organization's users sign in through the organization's own identity provider (Okta, Entra ID, Google Workspace, ADFS). Specified in [`spec/behaviors/29-saml-sp.md`](../../spec/behaviors/29-saml-sp.md) (BEH-EA-238 through 245 and 314 through 318) and [`spec/models/10-saml.md`](../../spec/models/10-saml.md); the decisions, including the XML-signature library evaluation, are [ADR-EA-023](../../spec/decisions/023-enterprise-federation-packages.md) and, for what it refuses, [ADR-EA-036](../../spec/decisions/036-saml-refusals-are-decisions.md). awthaq never acts as an identity provider.

```ts
const auth = Auth.make([Organization.Organization, Saml.Saml]); // Saml dependsOn [Organization]

Saml.Saml.layer.pipe(
  Layer.provide(
    Saml.config({
      baseUrl: "https://app.example.com", // required: it decides the audience and the ACS URL
      canManageSaml: ({ admin }) => isPlatformOwner(admin), // the admin group's gate: denies by default
    }),
  ),
  Layer.provideMerge(SamlConnections.layerStore),
  Layer.provideMerge(SamlSpKeys.layer), // the SP's signing keys, sealed with Encryption
  Layer.provideMerge(SamlMetadataFetcher.layerPinned), // IdP metadata by URL, through the pinned SSRF-safe fetch
  Layer.provideMerge(SamlRecords.layerSql), // or layerMemory; run the plugin's migrations
  Layer.provideMerge(XmlSignatureNode.layer), // the XmlSignature port over xml-crypto
  /* + Organization and its records, Users/Accounts/Sessions/Verification, RateLimiter, ClientAddress, Crypto,
       Encryption, HostResolver, the admin-tier and user authentication */
);

// Optional: the `Sso` dispatcher, over the organization's OIDC connections and these SAML ones.
Sso.Sso.layer; // POST /auth/sso/start
```

## A connection

`SamlConnectionStore.create({ organizationId, name, idp, emailDomains?, trustsEmail?, authnRequestsSigned?, roleMapping? })` registers one organization's IdP, from its metadata (`idp: { metadataXml }`, or, through the administrator's API, a metadata URL) or by hand (`{ entityId, ssoUrl, certificates, sloUrl? }`). The HTTP surface is the `saml.admin` group (below): the store is what an application calls directly, the API is what an operator's tool calls.

- The **trust set** is the IdP's signing certificates: each parsed as X.509 (RSA, at least 2048 bits), stored with its SHA-256 fingerprint and its own validity window. To rotate the IdP's key, `update(id, { certificates: [old, next] })` before the IdP starts signing with the next, and `update(id, { certificates: [next] })` after; the old key's signatures stop at once.
- The **SSO URL** is `https` only, no credentials, no private address (the browser is redirected there).
- An **email domain** routes to exactly one connection (`discover({ email })`): home-realm discovery for an "Sign in with SSO" button.
- **`trustsEmail`** (default off) is the connection's explicit linking policy (BEH-EA-245): a first sign-in may link to an existing local account with the asserted email only when that account's own address is already verified.

Give the IdP administrator `GET /auth/saml/metadata?connection=<id>` (entity id `<baseUrl>/auth/saml/sp/<id>`, ACS `<baseUrl>/auth/saml/acs`, `WantAssertionsSigned="true"`).

## Signed AuthnRequests

A connection with `authnRequestsSigned` sends every AuthnRequest with a **query-string signature** (the HTTP-Redirect binding forbids an enveloped one; SAML bindings 3.4.4.1): `SigAlg` RSA-SHA256 and `Signature` over the exact octets `SAMLRequest=..[&RelayState=..]&SigAlg=..`, made with the connection's **SP signing key**. Enabling the flag generates one (RSA 2048, a self-signed certificate valid `signingKeyValidityDays`, five years by default) when the connection has none; an operator can import their own pair (RSA >= 2048, the certificate must be for the key). The private key is stored only as an `Encryption` envelope bound to the key's id and is never returned, published or logged; the certificate is published in the connection's SP metadata (`KeyDescriptor use="signing"`, `AuthnRequestsSigned="true"`). The newest unexpired key signs and every unexpired certificate stays published, so a rotation overlaps. **A connection that signs never sends unsigned**: with every key expired or a key that no longer decrypts, the login is a defect. An IdP whose metadata says `WantAuthnRequestsSigned="true"` makes the flag default on. The same key signs Single Logout messages.

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

## Single Logout

`GET|POST /auth/saml/slo/:connection` is the logout endpoint the SP metadata publishes (Redirect and POST bindings, one URL per connection, which is also the `Destination` every signed message must carry). Both directions:

- **The IdP ends sessions** (`LogoutRequest`): verified like an assertion (a Redirect signature over the raw parameters, or an XML signature through the same `XmlSignature` port under the connection's pinned trust set), judged (issuer, destination, freshness `logoutFreshness` 5 minutes, `NotOnOrAfter`), accepted once (its id is reserved: a replayed capture cannot log the user out again), then every session **the connection's sign-ins created** for that NameID (only the named `SessionIndex`es when given) is revoked with reason `federatedLogout`, as the connection's organization tenant. The answer is a `LogoutResponse` over the IdP's binding, signed with the SP key when there is one. Success even when nothing matched (no oracle for who is signed in).
- **The user ends their session** (`POST /auth/saml/logout`, authenticated and CSRF-protected): the local session ends first (reason `signOut`) and its cookie is expired, whatever the IdP does next; then, when the connection's IdP has a logout endpoint, the browser is sent there with a signed `LogoutRequest` naming the NameID and SessionIndex. The IdP's `LogoutResponse` must answer THAT request id (reserved single-use, bound to the browser by the `__Host-saml-logout` cookie) before the browser lands on the callback. A connection with no logout endpoint is a local sign-out.

An unsigned logout message is refused (a logout endpoint that accepted them would let anyone end anyone's sessions); every refusal is one uniform `SamlLogoutRejected`, with the reason logged and published as `auth.saml.logoutRejected`. The sign-in records each session's NameID and SessionIndex in `saml_session` (pruned after `sessionRecordRetention`, 90 days).

## Roles from groups

A connection's `roleMapping` turns the assertion's attributes into the organization's roles: rules `{ attribute, value?, roles }` (attribute matched case-insensitively, across every value of a multi-valued `groups`; the roles of every matching rule are added), a **ceiling** (default `["member"]`) and `defaultRoles`. After a sign-in has passed every check and `Users.assertCanSignIn`, `Organization.syncMemberRoles` adds or re-roles the membership, bounded by RRM-001's `canGrant` rule with the ceiling standing in for a caller: **a connection cannot mint `owner` unless its ceiling holds it, and `allowOwnerRoleMapping` (default off) says whether any connection may**; a member whose current roles exceed the ceiling is never reshaped, the last owner is never demoted, and unknown roles are refused. A mapping is validated against the organization's roles when it is written; one that cannot be applied at sign-in (a role since deleted, a limit reached) is logged and skipped: the user is signed in, the roles are simply not conferred.

## Administration

The `saml.admin` group is admin-tier (behind `Api.AdminAuthentication` and CSRF), gated by `canManageSaml({ admin, action, organizationId? })` (**denies by default**; a denial publishes `auth.admin.actionDenied` `saml.<action>` and reveals nothing about which ids exist), rate limited per administrator (`adminRate`), and scoped to the ambient tenant: inside a tenant only its organization is in reach and another's connection is answered like an id that does not exist.

| Endpoint | Behavior |
| --- | --- |
| `POST /admin/saml/connections` | Creates a connection from `{ organizationId, name, idp, emailDomains?, trustsEmail?, authnRequestsSigned?, roleMapping? }`; `idp` is `{ metadataXml }`, `{ metadataUrl }` (fetched through the pinned, SSRF-safe path) or `{ entityId, ssoUrl, certificates, sloUrl?, sloBinding? }`. The response names the SP entity id and metadata URL to give the IdP administrator. |
| `GET /admin/saml/connections?organizationId=` | List an organization's connections. |
| `GET\|PATCH\|DELETE /admin/saml/connections/:id` | Read, update (a `certificates` list REPLACES the trust set), delete (keys and session rows go too). |
| `POST /admin/saml/connections/:id/refresh-metadata` | Re-fetches the stored metadata URL and REPLACES the trust set with what it lists; refused if it names another entity id (a changed IdP is a new connection). |
| `POST /admin/saml/connections/:id/signing-key` | Generates a new SP signing key (or imports `{ privateKeyPem, certificatePem }`); `GET .../signing-keys` lists them (certificates only). |

Metadata URLs pass `OutboundUrl`, are resolved once with every answer required to be public, and are fetched over the pinned connection (`PinnedHttp`, `@awthaq/ports`): no redirect, at most `maxMetadataBytes`, within `metadataTimeout`; a failure is a class (`invalidUrl`, `blocked`, `timeout`, `connect`, `tooLarge`, `status`), never text from the far end. Every successful mutation publishes `auth.saml.connectionCreated`, `connectionUpdated` (the field NAMES, never values), `connectionDeleted` or `signingKeyRotated`.

## The `Sso` dispatcher

`Sso.Sso` (`POST /auth/sso/start { email | organizationId, callbackURL? }`) answers "where does this person sign in?": it routes an email domain (or an organization id) across the organization's OIDC connections (`OrganizationConnectionStore`) and these SAML ones and returns `{ protocol, connectionId, organizationId, loginUrl }`, the owning plugin's own login route, which the browser then follows (`/auth/saml/login?connection=..` or `/oauth/<providerId>/authorize`). When both protocols route the hint, `Sso.config({ preferred })` (default `saml`) decides and `Sso.discoverAll` lists every match, so the conflict is visible. Nothing routing is one uniform `SsoNotFound`, and the endpoint is rate limited per source address (`rateLimits.sso`).

## Why `xml-crypto`, and what surrounds it

The adapter (`XmlSignatureNode`) wraps [`xml-crypto`](https://github.com/node-saml/xml-crypto) 6.3.2, pinned exactly. It has had three critical signature-bypass advisories (all fixed by 6.0.1) and is the engine under `@node-saml/node-saml`; `samlify` and `node-saml` were rejected because they would put their own validation chain on the trust boundary in place of the spec's. So the library is trusted only through the policy around it: a lexical gate before any parser, the caller's cardinality policy, unique IDs, structure checked before any cryptography, `getCertFromKeyInfo` disabled (the library otherwise prefers the document's own certificate), fingerprint pinning inside validity windows, every signature required to verify, algorithm registries pruned to the allow-list, and the result read only from `getSignedReferences()`. The negative-test corpus in `test/XmlSignatureNode.test.ts` (the XSW patterns from the SAML security literature, algorithm downgrades, transform tricks, XXE, comment injection) is what an upgrade of the library must keep passing.

## Not built

**IdP-initiated login and encrypted assertions are refused, as recorded decisions** ([ADR-EA-036](../../spec/decisions/036-saml-refusals-are-decisions.md)): the ACS requires the state of a login this server started (start the flow from an IdP app launcher by pointing it at `GET /auth/saml/login?connection=<id>`), and it holds no decryption key (configure the IdP to send signed, unencrypted assertions to this SP). `RelayState` is accepted and ignored: the return path is held server-side. A session cookie in `SameSite=Strict` mode is not sent on the first navigation after a cross-site POST, as with any federated sign-in; use the default or `Lax` mode, or land on a page that re-navigates.
