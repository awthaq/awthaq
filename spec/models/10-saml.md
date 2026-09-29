# SAML
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-10 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Scheduled, SP-only, with the `SamlApi` contract, the `SamlSigner` port and the ordered validation chain designed (AOMS-009, SFS-003, SFS-007; [ADR-EA-023](../decisions/023-enterprise-federation-packages.md)) |
---

## What it is
A plan for a `Saml` plugin implementing SAML 2.0 as a service-provider (SP) role: consuming assertions from an enterprise identity provider and turning them into an awthaq session, alongside the metadata exchange and signed-request/response handling the protocol requires. As planned it is one of the two protocol families (with OIDC-based SSO) the `Sso` plugin would dispatch to, and it is also one of the methods that pushes awthaq toward acting as infrastructure other enterprise systems trust, not merely a relying party.

## Who asks for it
Enterprise buyers whose identity teams standardize on SAML rather than OIDC — an older but still-common enterprise requirement. `research/03-auth-landscape.md`'s strategy-phase inventory lists "SAML SSO" with the note "WorkOS ($125/connection), better-auth SSO plugin, Keycloak, Zitadel, Casdoor, FusionAuth, Logto" as adopters, categorized "Phase 3 / paid tier, always." The same file's landscape survey of Keycloak and Casdoor treats SAML support as part of the enterprise "breadth checklist" every full-IAM competitor ships, and its Wave 3 framing groups SAML SSO with the other capabilities "where every vendor paywalls." `archive/PRD.md` §17 lists `Saml` as a Phase 3 official plugin, without further elaboration.

## Status
| Property | Value |
|---|---|
| Status | Scheduled — specified, not yet built ([ADR-EA-023](../decisions/023-enterprise-federation-packages.md)) |
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
      const signer = yield* SamlSigner        // port in @awthaq/ports: fused parse + verify (see "The `SamlSigner` port")
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
Two endpoints under the `saml` group ([BEH-EA-004](../behaviors/01-plugin-contract.md)):

- `GET /auth/saml/metadata?connection=<id>` — the SP metadata XML for one connection (entity id, the ACS URL, `WantAssertionsSigned="true"`, the SP's own signing certificate when AuthnRequests are signed).
- `POST /auth/saml/acs` — the Assertion Consumer Service: `SAMLResponse` (and `RelayState`) as a form post. Success mints a session exactly like every other sign-in path (`Users.assertCanSignIn` first, [BEH-EA-046](../behaviors/06-domain-users-accounts.md)); every validation failure is one uniform `SamlAssertionRejected` (no oracle on *which* check failed).

SP-initiated login starts from the `Sso` dispatcher ([ADR-EA-023](../decisions/023-enterprise-federation-packages.md) Decision 4) or `Saml.authnRequest(connectionId)`, which reserves the request id (see below) and returns the redirect.

`saml_connection` (owned by this plugin, an organization's own IdP, exactly the shape `organization_oauth_connection` has for OIDC): `id`, `organizationId`, `name`, `idpEntityId`, `ssoUrl`, `idpCertificates` (the trust set, JSON: PEM + `notBefore`/`notAfter` per certificate, so a rotation overlaps), `emailDomains` (routed like the OIDC connection's), `signAuthnRequests`, `createdAt`/`updatedAt`. Provider ids are `saml:<organizationId>:<connectionId>`; accounts link on `(providerId, NameID)`.

## The `SamlSigner` port
A port in `@awthaq/ports` ([ADR-EA-010](../decisions/010-plugins-require-ports-never-provide.md)), required by the plugin and provided by the application; a maintained XML-DSig library (audited before adoption — never home-grown crypto) is its production implementation.

```ts
interface IdpTrustSet {
  readonly certificates: ReadonlyArray<{
    readonly fingerprint: string            // SHA-256 of the DER certificate
    readonly pem: string
    readonly notBefore: DateTime.Utc
    readonly notAfter: DateTime.Utc
  }>
}
interface VerifiedAssertion {                // data of the *signed* Assertion only
  readonly issuer: string
  readonly nameId: { readonly value: string; readonly format: string | null }
  readonly attributes: Record<string, ReadonlyArray<string>>
  readonly conditions: { readonly notBefore: DateTime.Utc | null; readonly notOnOrAfter: DateTime.Utc | null; readonly audiences: ReadonlyArray<string> }
  readonly subjectConfirmation: { readonly recipient: string | null; readonly inResponseTo: string | null; readonly notOnOrAfter: DateTime.Utc | null }
  readonly destination: string | null
}
interface SamlSignerShape {
  /** Parse and verify as one step: no unverified DOM escapes; DTD and external entities disabled inside. */
  readonly verifyResponse: (xml: string, trust: IdpTrustSet) => Effect.Effect<VerifiedAssertion, SamlVerificationError>
  readonly trustFromMetadata: (metadataXml: string) => Effect.Effect<IdpTrustSet, SamlVerificationError>
  /** Optional: signing the SP's AuthnRequest / metadata. */
  readonly sign?: (xml: string) => Effect.Effect<string, SamlVerificationError>
}
```

The contract is what makes signature wrapping (XSW) unrepresentable: `verifyResponse` returns data extracted from *the element the verified signature covers*, never from "an Assertion somewhere in the document"; exclusive C14N is internal; an algorithm outside the allow-list (RSA-SHA256 or stronger, no SHA-1) is a `SamlVerificationError`; a certificate outside its `notBefore`/`notAfter` window is not trusted, so an IdP rotating its signing key can publish both certificates for the overlap.

## What is missing
The `@awthaq/saml` package itself and the `SamlSigner` implementation. The behavior each step of the validation chain owes — size cap, structural parse, assertion cardinality, signature over the processed element, issuer, audience/recipient/destination, time window, single-consume request id, account link — is fixed in [`../behaviors/29-saml-sp.md`](../behaviors/29-saml-sp.md) (BEH-EA-233 through 240), including the canonicalization and signature-wrapping defenses, so the implementation has a normative target before it exists. IdP-initiated (unsolicited) responses are refused by default. See `research/03-auth-landscape.md` for the demand evidence.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
