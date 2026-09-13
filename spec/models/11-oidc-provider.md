# OIDC Provider
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-11 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is
A plan for an `OidcProvider` plugin that makes an awthaq-backed application act **as** an OpenID Connect identity provider and authorization server — issuing tokens to third-party relying parties, exposing discovery and JWKS documents, and running the authorization-code/consent flow — rather than consuming an external provider the way the `OAuth` plugin does. This is a direction reversal from every other method in this matrix: everywhere else, awthaq is the relying party asking someone else "who is this"; here, awthaq is asked "who is this" by someone else, and has to answer with the same rigor RFC 8725/RFC 9700 demand of any authorization server.

## Who asks for it
Platforms that want to let third-party applications (including their own customers' internal tools, or an MCP/agent ecosystem) authenticate against the platform's own user base — "become the IdP for your own ecosystem" rather than "let users sign in with someone else's IdP." `research/03-auth-landscape.md`'s TL;DR names this directly as an emerging pattern: "the 2026 differentiator wave is agent/MCP identity, and every current implementation is bolted on at the *provider* layer," and its strategy-phase inventory notes better-auth ships an "OAuth 2.1 provider" and MCP plugin at this same tier. The same file frames it as a plausible long-term Effect-capability-graph advantage but explicitly "not an MVP goal." `archive/PRD.md` §17 lists `OidcProvider` as a Phase 3 official plugin. `research/05-oauth-oidc.md` covers the relying-party direction of OAuth/OIDC in depth but does not address the provider role.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase3 |
| Priority | P3 |
| Enabler(s) | E2 — External provider/port abstraction, E5 — Identity-provider-as-server |
| Breaking? | Additive in principle — nothing Planned-MVP or Planned-Phase2 requires awthaq to issue tokens to third parties — but E5 (acting as an identity-provider-as-server) is a self-contained, materially larger subsystem than every relying-party method in this matrix, and no design work has established that it composes cleanly with the plugin/Layer model without new primitives. |

## How it would be expressed
```ts
export class OidcProvider extends AuthPlugin.Service<OidcProvider, {
  discovery: Effect.Effect<OidcDiscoveryDocument>
  jwks: Effect.Effect<JwksDocument>
  authorize(request: AuthorizeRequest): Effect.Effect<RedirectUrl, OidcProviderError>
  token(request: TokenRequest): Effect.Effect<TokenResponse, OidcProviderError>
  userinfo(accessToken: Redacted.Redacted<string>): Effect.Effect<UserInfo, OidcProviderError>
}>()("oidc-provider", {
  apiVersion: 1,
  contract: OidcProviderApi,   // GET /.well-known/openid-configuration, /auth/oidc/jwks, /authorize, /token, /userinfo
  tables: ["oidc_client", "oidc_consent", "oidc_grant"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(OidcProvider, {
    dependsOn: [Sessions, Users, Jwt],
    make: Effect.gen(function*() {
      const clients = yield* OidcClientRegistry     // not yet designed: relying-party registration/trust
      /* consent screen, code issuance, token issuance, discovery/JWKS publication */
      return OidcProvider.of({ discovery, jwks, authorize, token, userinfo })
    }),
    handlers: OidcProviderHandlers
  })
}
```

## Worked example
No worked example drafted yet. Neither `archive/design/usage-examples-v4.md` nor `archive/design/usage-qadi.md` carries a section for this plugin as of this revision; both files' OAuth/OIDC coverage (`usage-examples-v4.md` §7) is entirely about awthaq as a relying party.

## What is missing
No design beyond this row exists yet, and the gap here is unusually large even for a Phase 3 method: there is no client-registration/trust model, no consent-flow design, no decision on scope/claims negotiation, and no answer to how issuing tokens to third parties interacts with `Sessions`' revocation model or with the `Jwt` plugin's key-rotation plan (`08-jwt-bearer.md`). See `research/03-auth-landscape.md` for landscape context — it identifies the demand signal (agent/MCP identity as "the 2026 differentiator wave") but does not propose an awthaq-specific design, and `research/05-oauth-oidc.md` does not cover the provider role at all.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
