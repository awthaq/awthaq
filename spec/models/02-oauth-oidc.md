# OAuth and OIDC

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-02 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Status flipped to Shipped-Unpublished; "What is missing" and "Verification" rewritten against `packages/oauth` (AOMS-011, CCR-EA-006) |
---

## What it is
OAuth and OIDC is the relying-party social-login method: awthaq redirects to an external provider (Google, GitHub, or a generic OIDC issuer), verifies the callback with PKCE and server-side state, and either creates or links an `Account` row to a `User`. It ships as `@awthaq/oauth`, one of the four plugins named in `archive/PRD.md` §9.4's example tuple.

## Who asks for it
Nearly every consumer-facing application that isn't purely enterprise-internal. `research/05-oauth-oidc.md`'s TL;DR is explicit about the shape this demand takes in 2026: "RFC 10017, OAuth 2.0 for Browser-Based Apps... formalizes what better-auth/Auth.js already practice: JS apps should not hold OAuth tokens; cookie-session BFF is the robust default" — which is directly load-bearing for awthaq's default topology, since awthaq's session is already a cookie, not a bearer token, in the browser case. The same document also notes Arctic's own author concluded "OAuth 2.0 isn't an ideal layer to abstract into a library; any library should target an abstraction one or two layers above it" — i.e. awthaq cannot simply depend on Arctic and must own this layer itself.

## Status
| Property | Value |
|---|---|
| Status | Shipped-Unpublished (`packages/oauth`) |
| Priority | P0 |
| Enabler(s) | E2 — External provider/port abstraction |
| Breaking? | Additive on top of core `Sessions`/`Users` and the `Password` plugin's `Account` table — the plugin-as-Layer model means OAuth only adds to the merged contract's `RIn`/groups, it does not reshape anything Password already committed to. |

## How it would be expressed
```ts
import { OAuthProvider } from "@awthaq/oauth"

export const okta = OAuthProvider.oidc({
  id: "okta",
  issuer: Config.String("AUTH_OAUTH_OKTA_ISSUER"),
  clientId: Config.String("AUTH_OAUTH_OKTA_CLIENT_ID"),
  clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET"),
  scopes: ["openid", "email", "profile"],
  profile: (claims) => ({ subject: claims.sub, email: claims.email, name: claims.name })
})
```
Reproduced from `archive/design/usage-examples-v4.md` §7.3, fence changed to `ts`. Per `archive/PRD.md` §17 the v1 provider set is Google, GitHub and a generic OIDC provider built on this same shape, and linking is explicit by default (see the worked example below) rather than auto-linking on a matching verified email — matching `research/05-oauth-oidc.md`'s recommendation to "default off, explicit `linkSocial` flow, opt-in auto-link per provider." Identity anchor would be `(providerId, subject)` where `subject` is the OIDC `sub`, never email, per the same research file's provider-quirks section (Apple strips email after first login; GitHub, Google and Entra ID all have their own reasons email is untrustworthy as an anchor).

## Worked example
```
GET  /auth/oauth/google/authorize?redirect=/dashboard     → 302 to Google (PKCE S256, state stored server-side)
GET  /auth/oauth/google/callback?code=…&state=…           → sets session cookie, 302 to /dashboard
```
```ts
const url = yield* HttpApiClient.urlBuilder(AuthApi).oauth.authorize({ params: { provider: "google" }, query: { redirect: "/dashboard" } })
```
```ts
oauth({ providers: [google()], linking: "explicit" })
// signed-in user links a provider:
yield* client.oauth.link({ params: { provider: "github" } })     // 302 → callback attaches Account to the current user
// signing in with a provider whose email matches an existing account, unlinked → 409 AccountExists { provider: "password" }

oauth({ providers: [google()], linking: { trustedProviders: ["google"] } })   // opt in to verified-email auto-link
```
Reproduced from `archive/design/usage-examples-v4.md` §7.1–7.2, fences changed to `ts` (one block is the raw HTTP exchange and is left as a plain fence per the source).

## What is missing
The plugin, the `OAuthProvider` port with vendor presets (Google, GitHub, Microsoft, GitLab, Discord) and a generic OIDC issuer, server-held flow state in `Verification` (`purpose: "oauth.flow"`), PKCE S256, `id_token` verification under a per-provider algorithm allowlist, explicit and opt-in account linking, the native return leg (exchange code, `POST /oauth/token`, redirect allowlist) and per-organization connections are built. What `research/05-oauth-oidc.md`'s Q88 slice names as threats (SSRF via provider-configured endpoints, open redirect, state/nonce reuse, mix-up) are covered by the tests below, not by a separate security review, which is an M8 item. Not built: acting as an OAuth *authorization server* (`client_credentials` issuance lives in `@awthaq/api-key`; an OIDC provider is [MOD-EA-011](11-oidc-provider.md), planned).

## Verification
`packages/oauth/test/*` (`OAuth.test.ts`, `OAuthPresets.test.ts`, `OAuthNative.test.ts`, hooks, token access, the real HTTP surface in `AuthHttp.test.ts`) and the wired `16-oauth.feature` scenarios (`features/`); see [`spec/traceability.md`](../traceability.md) §5.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
