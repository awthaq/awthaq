# SAML
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-10 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Scheduled, SP-only, with the `SamlApi` contract, the `SamlSigner` port and the ordered validation chain designed (AOMS-009, SFS-003, SFS-007; [ADR-EA-023](../decisions/023-enterprise-federation-packages.md)) <br> 1.2 (2026-09-29): implemented as `@awthaq/saml`; the port is `XmlSignature` (generic XML-DSig, `@awthaq/ports`), verified by a Node adapter over `xml-crypto` (SFS-003) |
---

## What it is
A plan for a `Saml` plugin implementing SAML 2.0 as a service-provider (SP) role: consuming assertions from an enterprise identity provider and turning them into an awthaq session, alongside the metadata exchange and signed-request/response handling the protocol requires. As planned it is one of the two protocol families (with OIDC-based SSO) the `Sso` plugin would dispatch to, and it is also one of the methods that pushes awthaq toward acting as infrastructure other enterprise systems trust, not merely a relying party.

## Who asks for it
Enterprise buyers whose identity teams standardize on SAML rather than OIDC — an older but still-common enterprise requirement. `research/03-auth-landscape.md`'s strategy-phase inventory lists "SAML SSO" with the note "WorkOS ($125/connection), better-auth SSO plugin, Keycloak, Zitadel, Casdoor, FusionAuth, Logto" as adopters, categorized "Phase 3 / paid tier, always." The same file's landscape survey of Keycloak and Casdoor treats SAML support as part of the enterprise "breadth checklist" every full-IAM competitor ships, and its Wave 3 framing groups SAML SSO with the other capabilities "where every vendor paywalls." `archive/PRD.md` §17 lists `Saml` as a Phase 3 official plugin, without further elaboration.

## Status
| Property | Value |
|---|---|
| Status | Implemented (SP only) — `@awthaq/saml` ([ADR-EA-023](../decisions/023-enterprise-federation-packages.md), [BEH-EA-238 through 245](../behaviors/29-saml-sp.md)) |
| Priority | P3 |
| Enabler(s) | E2 — External provider/port abstraction, E5 — Identity-provider-as-server |
| Breaking? | Additive in the relying-party direction (consuming SAML assertions extends E2 the same way OAuth does). Acting as a SAML *identity provider* (E5) is a materially larger, separable subsystem and is explicitly out of scope: `@awthaq/saml` is a service provider only. |

## How it would be expressed
```ts
export class Saml extends AuthPlugin.Service<Saml, {
  metadata: Effect.Effect<SpMetadataXml>
  acsCallback(samlResponse: Redacted.Redacted<string>): Effect.Effect<SessionView, SamlError>
}>()("saml", {
  apiVersion: 1,
  contract: SamlApi,            // GET /auth/saml/metadata, POST /auth/saml/acs
  tables: ["saml_connection"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Saml, {
    dependsOn: [Sessions, Users],
    make: Effect.gen(function*() {
      const signer = yield* XmlSignature      // port in @awthaq/ports: fused parse + verify (see "The `XmlSignature` port")
      /* validate the IdP-signed assertion, map NameID/attributes to a principal */
      return Saml.of({ metadata, acsCallback })
    }),
    handlers: SamlHandlers
  })
}
```

## Worked example
No worked example drafted yet. Neither `archive/design/usage-examples-v4.md` nor `archive/design/usage-qadi.md` carries a SAML section as of this revision.

## The contract (`SamlApi`)
Two endpoints under the `saml` group ([BEH-EA-4](../behaviors/01-plugin-contract.md)):

- `GET /auth/saml/metadata?connection=<id>` — the SP metadata XML for one connection (entity id, the ACS URL, `WantAssertionsSigned="true"`, the SP's own signing certificate when AuthnRequests are signed).
- `POST /auth/saml/acs` — the Assertion Consumer Service: `SAMLResponse` (and `RelayState`) as a form post. Success mints a session exactly like every other sign-in path (`Users.assertCanSignIn` first, [BEH-EA-46](../behaviors/06-domain-users-accounts.md)); every validation failure is one uniform `SamlAssertionRejected` (no oracle on *which* check failed).

SP-initiated login starts from the `Sso` dispatcher ([ADR-EA-023](../decisions/023-enterprise-federation-packages.md) Decision 4) or `Saml.authnRequest(connectionId)`, which reserves the request id (see below) and returns the redirect.

`saml_connection` (owned by this plugin, an organization's own IdP, exactly the shape `organization_oauth_connection` has for OIDC): `id`, `organizationId`, `name`, `idpEntityId`, `ssoUrl`, `idpCertificates` (the trust set, JSON: PEM + `notBefore`/`notAfter` per certificate, so a rotation overlaps), `emailDomains` (routed like the OIDC connection's), `signAuthnRequests`, `createdAt`/`updatedAt`. Provider ids are `saml:<organizationId>:<connectionId>`; accounts link on `(providerId, NameID)`.

## The `XmlSignature` port
A port in `@awthaq/ports` ([ADR-EA-010](../decisions/010-plugins-require-ports-never-provide.md)), required by the plugin and provided by the application. It is generic XML-DSig, not SAML: the SAML-specific reading of an assertion is the plugin's, done over what the port returns. The production adapter is `XmlSignatureNode` in `@awthaq/saml`, over `xml-crypto` (evaluated before adoption — never home-grown crypto; see ADR-EA-023 Decision 3).

```ts
interface TrustSet {
  readonly certificates: ReadonlyArray<{
    readonly fingerprint: string            // SHA-256 of the DER certificate, hex
    readonly pem: string
    readonly notBefore: DateTime.Utc        // trusted from here (inclusive) ...
    readonly notAfter: DateTime.Utc         // ... until here (exclusive): a rotation overlaps two entries
  }>
}
interface VerifyPolicy {
  readonly signedElements: ReadonlyArray<ElementName>   // what a verified signature may cover: Assertion, Response
  readonly exactlyOne?: ReadonlyArray<ElementName>      // must occur exactly once in the whole document: Assertion
  readonly forbidden?: ReadonlyArray<ElementName>       // refuses the document: EncryptedAssertion
  readonly maxBytes?: number                            // default 256 KiB, before any parse
  readonly now?: DateTime.Utc
}
interface VerifiedXml {                      // ONLY the signed element
  readonly signedXml: string                 // canonical (exclusive C14N, no comments) bytes the digest covers
  readonly signedElement: ElementName
  readonly signedId: string
  readonly signatureAlgorithm: string
  readonly digestAlgorithm: string
  readonly certificateFingerprint: string
}
interface XmlSignatureShape {
  /** Parse and verify as one step: no unverified DOM escapes; DTD, entities, comments and PIs refused inside. */
  readonly verify: (input: { xml: string; trust: TrustSet; policy: VerifyPolicy }) => Effect<VerifiedXml, XmlSignatureError>
}
```

`XmlSignatureError` carries a `reason` (`tooLarge`, `doctype`, `comment`, `cardinality`, `duplicateId`, `signatureNotEnveloped`, `unsupportedAlgorithm`, `unsupportedTransform`, `untrustedKey`, `noTrustedCertificate`, `invalidSignature`, ...) for the log and the audit event — never for the wire — and a constant `detail` that never echoes input.

The contract is what makes signature wrapping (XSW) unrepresentable: `verify` returns the bytes of *the element the verified signature covers*, never "an Assertion somewhere in the document"; exclusive C14N is internal; an algorithm outside the allow-list (RSA-SHA256/512 and SHA-256/512 digests; no SHA-1, no HMAC, no inclusive or with-comments canonicalization, no XSLT/XPath transform) is refused; the signer is pinned by fingerprint (a certificate the document names is never a key source); and a certificate outside its window is not trusted, so an IdP rotating its signing key can publish both certificates for the overlap. The plugin then parses `signedXml` again through the same hardened reader and judges issuer, audience, recipient, destination, bearer confirmation, `InResponseTo` and the time window (`SamlAssertion.validateAssertion`).

## What is missing
The behavior each step of the validation chain owes — size cap, structural parse, assertion cardinality, signature over the processed element, issuer, audience/recipient/destination, time window, single-consume request id, account link — is implemented and fixed in [`../behaviors/29-saml-sp.md`](../behaviors/29-saml-sp.md) (BEH-EA-238 through 245). Not built: signed AuthnRequests (the SP metadata says `AuthnRequestsSigned="false"`), IdP-initiated (unsolicited) login (refused), single logout, encrypted assertions (refused by the policy), an HTTP CRUD surface for connections (`SamlConnectionStore` is the write side, like SCIM's), attribute mapping beyond email/name, and organization role mapping (qadi's, [ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md)). Home-realm discovery is `SamlConnectionStore.discover`; the `Sso` dispatcher that would sit over it is still a design. See `research/03-auth-landscape.md` for the demand evidence.

## Verification
`packages/saml/test/XmlSignatureNode.test.ts` (the port's adapter: valid documents, pinning and rotation, tampering, the XSW corpus, algorithm and transform allow-list, DOCTYPE/XXE/comment/PI/size/depth), `SamlAssertion.test.ts` (the assertion reader and every rule at its boundary), `Saml.test.ts` (the ACS chain end to end and every way of failing it, uniformly), `SamlHttp.test.ts` (real HTTP), `SamlRecords.test.ts` (both layers; Postgres under `pnpm run test:pg`), `SamlConnections.test.ts`.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
