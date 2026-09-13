# SSO
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-09 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Noted that the `Organization` dependency is itself only the non-normative MOD-EA-014 adoption record, so this plugin's dependency on it is presently unresolved/blocked (CCR-EA-002) |
---

## What it is
A plan for an `Sso` plugin that lets an application's own users authenticate through an enterprise identity provider the application does not control — the umbrella capability that a customer's IT department configures once per organization, distinct from the `OAuth` plugin's consumer-facing "Sign in with Google" flows. As planned it would sit on the same external-provider port abstraction as OAuth and Passkey, but resolve the provider per tenant/organization rather than per application.

## Who asks for it
B2B applications selling to enterprise buyers whose procurement requires "sign in with our identity provider." `research/03-auth-landscape.md` documents this as an industry-wide pattern rather than a speculative one: "Every B2B platform treats tenancy as the monetization boundary" and specifically calls out WorkOS charging roughly $125/connection for SAML/SCIM, Clerk gating organizations and SSO by tier, and Logto leading its marketing with "multi-tenancy, enterprise SSO, and RBAC." The same file's Wave 3 framing ("B2B money (enterprise tier): API keys, JWT, SAML SSO, SCIM, organizations, audit, impersonation... where every vendor paywalls") and its strategy-phase inventory place SSO squarely in Phase 3, "always" a paid/enterprise tier across every framework studied. `archive/PRD.md` §17 lists `Sso` as a Phase 3 official plugin.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase3 |
| Priority | P2 |
| Enabler(s) | E2 — External provider/port abstraction |
| Breaking? | Additive: SSO is planned to reuse the same external-provider port abstraction OAuth is planned to introduce (E2), with a per-tenant provider resolution layered on top; it does not require reopening any Planned-MVP contract or service shape. |

## How it would be expressed
```ts
export class Sso extends AuthPlugin.Service<Sso, {
  signIn(connectionId: string): Effect.Effect<RedirectUrl, SsoError>
  callback(connectionId: string, params: CallbackParams): Effect.Effect<SessionView, SsoError>
}>()("sso", {
  apiVersion: 1,
  contract: SsoApi,             // GET /auth/sso/:connectionId, GET /auth/sso/:connectionId/callback
  tables: ["sso_connection"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Sso, {
    dependsOn: [Sessions, Users, Organization],
    make: Effect.gen(function*() {
      const resolver = yield* SsoConnectionResolver   // port: per-tenant/organization connection lookup
      /* resolve the tenant's configured connection, delegate to the shared OIDC/SAML port(s) */
      return Sso.of({ signIn, callback })
    }),
    handlers: SsoHandlers
  })
}
```

**Note on the `Organization` dependency.** `Organization` above is itself only
a non-normative adoption record — [MOD-EA-014](14-organization.md) — with no
behaviors file and no `BEH-EA` ids allocated to it anywhere in
`spec/behaviors/`. This plugin's `dependsOn: [Sessions, Users, Organization]`
is therefore presently **unresolved/blocked** on `Organization` becoming
normative, not a dependency this document should be read as silently
assuming will be satisfied. Until `Organization` acquires a normative
behavior file, `Sso`'s own design cannot proceed past this row either.

## Worked example
No worked example drafted yet. Neither `archive/design/usage-examples-v4.md` nor `archive/design/usage-qadi.md` carries a section for SSO as of this revision.

## What is missing
No design beyond this row exists yet. There is no `SsoApi` contract, no connection model, no per-tenant resolution mechanism, and no decision on whether SSO wraps SAML and OIDC-based enterprise connections under one plugin or dispatches to the separate `Saml`/`OAuth` plugins underneath. See `research/03-auth-landscape.md` for the landscape context (Wave 3 "B2B money" framing, the WorkOS/Clerk/Logto pricing evidence) that justifies the Phase 3 placement; that file does not itself propose an awthaq-specific design.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
