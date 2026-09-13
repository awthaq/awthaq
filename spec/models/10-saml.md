# SAML
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-10 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is
A plan for a `Saml` plugin implementing SAML 2.0 as a service-provider (SP) role: consuming assertions from an enterprise identity provider and turning them into an effect-auth session, alongside the metadata exchange and signed-request/response handling the protocol requires. As planned it is one of the two protocol families (with OIDC-based SSO) the `Sso` plugin would dispatch to, and it is also one of the methods that pushes effect-auth toward acting as infrastructure other enterprise systems trust, not merely a relying party.

## Who asks for it
Enterprise buyers whose identity teams standardize on SAML rather than OIDC — an older but still-common enterprise requirement. `research/03-auth-landscape.md`'s strategy-phase inventory lists "SAML SSO" with the note "WorkOS ($125/connection), better-auth SSO plugin, Keycloak, Zitadel, Casdoor, FusionAuth, Logto" as adopters, categorized "Phase 3 / paid tier, always." The same file's landscape survey of Keycloak and Casdoor treats SAML support as part of the enterprise "breadth checklist" every full-IAM competitor ships, and its Wave 3 framing groups SAML SSO with the other capabilities "where every vendor paywalls." `archive/PRD.md` §17 lists `Saml` as a Phase 3 official plugin, without further elaboration.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase3 |
| Priority | P3 |
| Enabler(s) | E2 — External provider/port abstraction, E5 — Identity-provider-as-server |
| Breaking? | Additive in the relying-party direction (consuming SAML assertions extends E2 the same way OAuth does), but SAML also touches E5 if effect-auth is ever asked to act as a SAML identity provider rather than only a service provider — that direction is a materially larger, separable subsystem and is not assumed by anything Planned-MVP or Planned-Phase2 depends on. |

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
      const signer = yield* SamlSigner        // port: XML signature verification/signing, not yet designed
      /* validate the IdP-signed assertion, map NameID/attributes to a principal */
      return Saml.of({ metadata, acsCallback })
    }),
    handlers: SamlHandlers
  })
}
```

## Worked example
No worked example drafted yet. Neither `archive/design/usage-examples-v4.md` nor `archive/design/usage-qadi.md` carries a SAML section as of this revision.

## What is missing
No design beyond this row exists yet — there is no `SamlApi` contract, no XML-signing port, no metadata format decision, and no answer to whether effect-auth ever plans to act as a SAML identity provider (E5) as opposed to only a service provider consuming external assertions. See `research/03-auth-landscape.md` for landscape context on where SAML sits in the competitive field (the WorkOS/Keycloak/Casdoor evidence cited above); that file documents demand and positioning, not an effect-auth-specific protocol design.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
