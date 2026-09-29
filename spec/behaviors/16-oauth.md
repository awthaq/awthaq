# OAuth and OIDC
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-16 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added the INV-EA-015 callout to BEH-EA-125 (CCR-EA-002) |
---

> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.

## BEH-EA-121: PKCE S256 is structural, not optional

```ts
interface OAuthProvider { readonly pkce: true /* structural */; readonly quirks?: { skipPkce?: boolean } }
```

```text
REQUIREMENT: Every OAuth authorization-code flow MUST use PKCE with the S256
             challenge method; the provider interface MUST NOT expose a
             `"none"` checks escape hatch, only a documented per-provider quirk
             override for providers that reject PKCE outright.
```

research/05-oauth-oidc.md's Q54 recommendation is explicit: "PKCE S256 always... No `\"none\"` checks escape hatch," a stricter stance than Auth.js's `checks: ("none"|"state"|"pkce")[]` array. RFC 9700 (Jan 2025) mandates PKCE for all clients; making the field's type `true` rather than a boolean means a provider author cannot accidentally configure it off — only the documented quirk path (Apple, which rejects PKCE) may skip it, and that skip is visible in the quirk table, not buried in per-call configuration.

_Previous: [BEH-EA-120](15-password.md#beh-ea-120-password-policy-is-configuration-not-a-plugin-variant) | Next: [BEH-EA-122](16-oauth.md#beh-ea-122-flow-state-lives-server-side-in-verification)_

## BEH-EA-122: Flow state lives server-side, in Verification

```ts
// purpose: "oauth.flow", payload = { codeVerifier, nonce?, callbackURL, link?, expiresAt }
```

```text
REQUIREMENT: The `state` parameter and its associated PKCE verifier and nonce
             MUST be stored server-side under core Verification (purpose
             `oauth.flow`), single-use and TTL-bounded; the browser MUST hold
             only an opaque correlation cookie, never the verifier or nonce
             itself.
```

Reusing core Verification (file 08) rather than inventing separate OAuth flow-state storage gives `state` single-use and replay semantics for free, and keeps the security property in one place instead of two. research/05-oauth-oidc.md recommends exactly this generalization of better-auth's `"database"` `storeStateStrategy`, and RFC 9700 §10.12 requires `state` to defend against CSRF and code-injection on the callback; single-use consumption is what makes a replayed callback fail rather than silently re-run the exchange.

_Previous: [BEH-EA-121](16-oauth.md#beh-ea-121-pkce-s256-is-structural-not-optional) | Next: [BEH-EA-123](16-oauth.md#beh-ea-123-linking-is-explicit-by-default)_

## BEH-EA-123: Linking is explicit by default

```ts
oauth({ providers: [google()], linking: "explicit" })   // default
// same-email sign-in, unlinked → 409 AccountExists { provider: "password" }
```

```text
REQUIREMENT: When a provider callback's email matches an existing account that
             has not linked that provider, the default configuration MUST fail
             with a typed `AccountExists`/`AccountNotLinked` outcome rather than
             silently linking the accounts.
```

Auth.js calls its opt-in flag `allowDangerousEmailAccountLinking` for a reason research/05-oauth-oidc.md documents directly: auto-linking by email is account-takeover-prone whenever any linked provider has weak email verification, and email at the provider can change without awthaq ever finding out. Defaulting to explicit linking follows the stricter of the two major frameworks' stances; the typed error drives a "sign in, then link" UI flow instead of a silent account merge the user never asked for.

_Previous: [BEH-EA-122](16-oauth.md#beh-ea-122-flow-state-lives-server-side-in-verification) | Next: [BEH-EA-124](16-oauth.md#beh-ea-124-trusted-provider-auto-link-is-opt-in-per-provider)_

## BEH-EA-124: Trusted-provider auto-link is opt-in, per provider

```ts
oauth({ providers: [google()], linking: { trustedProviders: ["google"] } })
```

```text
REQUIREMENT: Automatic linking on a verified-email match MUST be disabled
             unless the application names the provider in `trustedProviders`;
             naming a provider there MUST apply only to that provider, never
             globally.
```

Some deployments genuinely want the smoother OAuth-only onboarding better-auth's default-on stance provides; `trustedProviders` gives them that trade-off without lowering the bar for every provider at once. Scoping the opt-in per-provider matters because provider email trustworthiness varies — Google's is strong, but Apple only emits an email on first consent, and Facebook exposes no verification flag at all (research/05-oauth-oidc.md), so "trust this provider's email" is a per-provider judgment, not a global one.

_Previous: [BEH-EA-123](16-oauth.md#beh-ea-123-linking-is-explicit-by-default) | Next: [BEH-EA-125](16-oauth.md#beh-ea-125-provider-subject-issuer-is-the-identity-anchor)_

## BEH-EA-125: `(provider, subject, issuer)` is the identity anchor

> **Invariant:** [INV-EA-015](../invariants.md#inv-ea-015-the-provider-subject-issuer-tuple-is-unique-per-account-and-the-oauth-state--pkce-verifier-is-single-use)

```text
REQUIREMENT: An `Account` row MUST be keyed uniquely on `(provider, subject,
             issuer)`; email MUST NOT be used as, or substitute for, that key.
```

Email is documented as an unreliable anchor across every provider awthaq targets: Apple strips it after the first login, Entra ID's own docs forbid using `email`/`preferred_username` for authorization, and Facebook exposes no verification flag (research/05-oauth-oidc.md). `subject` — OIDC's `sub`, or a provider's declared immutable field — never gets reassigned by the provider the way an email address can be changed or reused, which is exactly the property a uniqueness constraint needs to hold across the account's lifetime.

_Previous: [BEH-EA-124](16-oauth.md#beh-ea-124-trusted-provider-auto-link-is-opt-in-per-provider) | Next: [BEH-EA-126](16-oauth.md#beh-ea-126-provider-secrets-are-configredacted-inside-layers)_

## BEH-EA-126: Provider secrets are `Config.Redacted`, inside Layers

```ts
export const okta = OAuthProvider.oidc({
  id: "okta",
  clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET"),
  /* … */
})
```

```text
REQUIREMENT: A provider's client secret MUST be read via `Config.Redacted`
             inside the provider's own Layer construction; it MUST NOT appear
             as a plaintext option, a plugin argument, or in application
             source alongside plugin wiring.
```

`usage-examples-v4.md` §2.1 states the property directly: "Secrets are environment only... nothing secret appears in this file." Reading the secret through `Config.Redacted` inside the Layer means the value is neither loggable by accident nor visible in a diff of the wiring code — the wiring file names the environment variable, never the value, and `Redacted`'s type prevents it from being printed even if someone tries.

_Previous: [BEH-EA-125](16-oauth.md#beh-ea-125-provider-subject-issuer-is-the-identity-anchor) | Next: [BEH-EA-127](16-oauth.md#beh-ea-127-generic-oidc-discovery-with-exact-issuer-match)_

## BEH-EA-127: Generic OIDC discovery, with exact issuer match

```ts
export const okta = OAuthProvider.oidc({ id: "okta", issuer: Config.String("AUTH_OAUTH_OKTA_ISSUER"), /* … */ })
```

```text
REQUIREMENT: When a provider is configured via discovery, the fetched
             document's `issuer` field MUST match the configured `issuer`
             exactly; a mismatch MUST fail provider registration rather than
             proceed with the fetched value.
```

research/05-oauth-oidc.md's Q88 table cites two real incidents this guards against: Keycloak's CVE-2020-10770 and a Cognito SSRF case, both rooted in trusting a provider-controlled endpoint without an exact-match check on the thing that identifies the provider. RFC 8414 and OIDC Discovery already require the returned `issuer` to match the expected value; treating a mismatch as a registration failure (fail closed at boot, not per-request) keeps a compromised or misconfigured discovery document from ever reaching request-serving code.

**Claim precedence (OIT-001, OIDC Core 5.3.2).** For an `oidc` provider that also exposes a userinfo endpoint, the userinfo response `sub` MUST equal the verified `id_token` `sub` (a mismatch fails the callback closed with no account created or linked), and the identity-bearing claims `sub`, `email` and `email_verified` MUST be taken from the signed `id_token` whenever it carries them. Userinfo only enriches the profile (`name`, `picture`, …); it can never re-anchor the identity or flip `email_verified` for the BEH-EA-124 auto-link decision. A plain `oauth2` provider (no `id_token`) still sources everything from userinfo.

_Previous: [BEH-EA-126](16-oauth.md#beh-ea-126-provider-secrets-are-configredacted-inside-layers) | Next: [BEH-EA-128](16-oauth.md#beh-ea-128-callback-destination-is-validated-never-echoed)_

## BEH-EA-128: Callback destination is validated, never echoed

```text
REQUIREMENT: The post-login `callbackURL` MUST be validated against a
             trusted-origin allowlist before the redirect is issued; the OAuth
             callback handler MUST NOT redirect to a URL taken unvalidated from
             a query parameter.
```

research/05-oauth-oidc.md's Q88 table names the real-world failure this prevents — CVE-2026-82274, where a callback handler redirected to an attacker-controlled URL while capturing authorization codes — and states the general rule from RFC 9700: "no open redirectors" for clients. `redirect_uri` itself is always derived from the configured base URL, never from request input, so the two checks together close both ends of the callback: where the authorization code goes, and where the user lands afterward.

_Previous: [BEH-EA-127](16-oauth.md#beh-ea-127-generic-oidc-discovery-with-exact-issuer-match) | Next: [BEH-EA-129](17-passkey.md#beh-ea-129-webauthn-is-a-port-wrapped-not-reimplemented)_
