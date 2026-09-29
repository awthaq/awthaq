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

**`skipPkce` is for confidential clients only (OAP-005, RFC 9700 §2.1.1).** Provider registration MUST fail at boot when `quirks.skipPkce` is set on a provider with no `clientSecret` — with neither a secret nor PKCE, the bare authorization code would be the entire credential. Every permitted use (a confidential client) logs a warning naming the provider at boot.

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

**Authorization-error redirects are part of the contract (AP-005, RFC 6749 §4.1.2.1).** A provider may redirect back with `error` (and optionally `error_description`/`error_uri`) instead of `code` — most commonly `access_denied` when the user declines consent — so `code` is optional in the callback's query. The callback validates the correlation cookie and `state` and consumes the single-use flow entry *first*; only then does an enumerated `error` code (`access_denied`, `invalid_request`, `unauthorized_client`, `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable`) surface as the typed `OAuthAuthorizationDenied { error }` (400), letting an application tell "you cancelled" from "something went wrong". `error_description` and `error_uri` are provider-controlled free text: never echoed, and logged at debug level only. An unknown `error` value, or a callback with neither `code` nor `error`, is the uniform `OAuthCallbackFailed`; an error redirect with a bad state or cookie is too (state is validated on the error path as well). No token exchange is ever attempted for a denial, and because the flow is consumed a replay carrying a `code` fails. *Decision (2026-09-29): option B of the plan, adopted as recommended; the user may revisit.*

**HTTP-level hardening of the two endpoints (TSS-003, CSS-006, PDR-004, OAP-008).** The correlation cookie is compared with the returned `state` in constant time over fixed-length SHA-256 digests (`ConstantTime.constantTimeEqual`), never with `!==`. Because the cookie is single-use, *every* callback response — success, link, and typed failure — expires `__Host-oauth-state` with the attributes it was set with. Both endpoints answer `Referrer-Policy: no-referrer` (their URLs carry the provider's `code`/`state`), including on framework-encoded error responses; a broader header set is available as the opt-in `@awthaq/server` `SecurityHeaders.layer`. Both endpoints are also throttled per source IP through registered `RateLimits` rules (`oauth`/`authorize`, default 30 per minute, and `oauth`/`callback`, default 20 per minute, both configurable via `OAuthConfig.rateLimits`); an over-limit request answers `429 RateLimited`.

**Provider outages are a distinct outcome (EEM-004).** The callback separates *protocol* failures from *availability* failures. A token, JWKS or userinfo endpoint that answers but rejects the request (a 4xx such as `invalid_grant`, a body that does not decode, a failed `id_token` check) is the uniform, field-less `OAuthCallbackFailed` (400); a transport failure, a deadline overrun, or a 5xx/429 answer is the equally field-less `ProviderUnavailable` (503) so a client can offer "try again shortly" instead of a dead-flow message. Distinguishing the two leaks nothing to an attacker: it is reachable only after state, cookie and PKCE validation of a flow the caller initiated.

_Previous: [BEH-EA-121](16-oauth.md#beh-ea-121-pkce-s256-is-structural-not-optional) | Next: [BEH-EA-123](16-oauth.md#beh-ea-123-linking-is-explicit-by-default)_

## BEH-EA-123: Linking is explicit by default

```ts
oauth({ providers: [google()], linking: "explicit" })   // default
// same-email sign-in, unlinked → 409 AccountExists { providers: ["password"] }
```

```text
REQUIREMENT: When a provider callback's email matches an existing account that
             has not linked that provider, the default configuration MUST fail
             with a typed `AccountExists`/`AccountNotLinked` outcome rather than
             silently linking the accounts.
```

Auth.js calls its opt-in flag `allowDangerousEmailAccountLinking` for a reason research/05-oauth-oidc.md documents directly: auto-linking by email is account-takeover-prone whenever any linked provider has weak email verification, and email at the provider can change without awthaq ever finding out. Defaulting to explicit linking follows the stricter of the two major frameworks' stances; the typed error drives a "sign in, then link" UI flow instead of a silent account merge the user never asked for.

**`AccountExists` names the real providers (NAM-006).** The error's `providers` are the provider ids the matching account actually has (`"password"`, `"passkey"`, another OAuth provider, …), read from its account rows — never a hardcoded `"password"`. They are populated only when the callback's own provider asserted `email_verified`; otherwise `providers` is `[]`, so a caller holding an unverified identity for the victim's address is not handed a map of the victim's sign-in methods (the error's existence is already disclosed by this behavior itself). *Decision (2026-09-29): option C of the plan, adopted as recommended; the user may revisit.*

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

Some deployments genuinely want the smoother OAuth-only onboarding better-auth's default-on stance provides; `trustedProviders` gives them that trade-off without lowering the bar for every provider at once. **Both sides must be proven (TMS-007).** A verified-email match auto-links only when the provider asserts `email_verified` **and** the local account's own `emailVerified` is already `true`. An unverified local account may have been registered by someone squatting the victim's address; linking a trusted identity into it would hand that person the account the moment anything verifies the address. Otherwise the callback answers `AccountExists`, exactly as the explicit path does.

**Just-in-time creation inherits a trusted provider's verification (AOMS-007).** When a first-time sign-in with no matching local account creates a user, and the provider is named in `trustedProviders` *and* asserts `email_verified`, the new user is marked verified in the same transaction. An untrusted provider's claim never flips local state (it would otherwise let a weak provider mint a "verified" squat account for TMS-007's gate to trust), and the auto-link and explicit-link paths never call `verifyEmail` — a local account keeps its own verification state.

Scoping the opt-in per-provider matters because provider email trustworthiness varies — Google's is strong, but Apple only emits an email on first consent, and Facebook exposes no verification flag at all (research/05-oauth-oidc.md), so "trust this provider's email" is a per-provider judgment, not a global one.

_Previous: [BEH-EA-123](16-oauth.md#beh-ea-123-linking-is-explicit-by-default) | Next: [BEH-EA-125](16-oauth.md#beh-ea-125-provider-subject-issuer-is-the-identity-anchor)_

## BEH-EA-125: `(provider, subject, issuer)` is the identity anchor

> **Invariant:** [INV-EA-015](../invariants.md#inv-ea-015-the-provider-subject-issuer-tuple-is-unique-per-account-and-the-oauth-state--pkce-verifier-is-single-use)

```text
REQUIREMENT: An `Account` row MUST be keyed uniquely on `(provider, subject,
             issuer)`; email MUST NOT be used as, or substitute for, that key.
```

Email is documented as an unreliable anchor across every provider awthaq targets: Apple strips it after the first login, Entra ID's own docs forbid using `email`/`preferred_username` for authorization, and Facebook exposes no verification flag (research/05-oauth-oidc.md). `subject` — OIDC's `sub`, or a provider's declared immutable field — never gets reassigned by the provider the way an email address can be changed or reused, which is exactly the property a uniqueness constraint needs to hold across the account's lifetime.

**Provider tokens live on the account row (BE-002, BAM-008).** The exchanged token set — access token, refresh token and, for an `oidc` provider, the `id_token` — is persisted on the account, each token encrypted at rest with row-and-column-bound additional data, and readable only through `Accounts.findProviderTokens`. The `id_token` is kept so a better-auth account import (BEH-EA-207, which must not drop a source field) has a destination and a future RP-initiated logout can send it as `id_token_hint`; a refresh response without a new `id_token` keeps the stored one, and one with a fresh `id_token` replaces it.

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

**Token-endpoint client authentication (AP-006).** The secret is sent by the method the provider's token endpoint supports, chosen once at boot (`tokenEndpointAuthMethod`, RFC 6749 §2.3.1 / RFC 8414 `token_endpoint_auth_methods_supported`): `client_secret_basic` (an `Authorization: Basic` header over the *form-urlencoded* client id and secret, then base64 — the RFC default, and used when the discovery document advertises it or advertises nothing), `client_secret_post` (the secret in the request body, used when only that is advertised or explicitly configured), or `none` for a public client. An explicitly configured method that the discovery document does not advertise, a secret-bearing method with no `clientSecret`, `none` alongside a `clientSecret`, or a provider advertising only methods this plugin cannot use, all fail at boot rather than as an `invalid_client` at the first sign-in. The code exchange and the refresh grant authenticate identically.

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

**Boot-time configuration validation (ESS-002, JR-009).** The discovery document is decoded with a schema, never asserted: a non-object body, a non-string `issuer`, or a present-but-malformed endpoint (`authorization_endpoint`, `token_endpoint`, `jwks_uri`, `userinfo_endpoint` must each be an absolute URL) fails provider registration with a defect naming the provider and the offending field. Explicitly configured endpoints get the same absolute-URL check, and an `oidc` provider whose `scopes` omit `openid` also fails at boot (it would otherwise never receive an `id_token`).

**Provider responses are decoded, never asserted (ESS-003, ACS-004).** The token-endpoint body (code exchange and refresh alike) and the userinfo body are decoded with shared schemas at the boundary: a body without a string `access_token`, with a mistyped member, or (userinfo) that is not a JSON object fails the flow with the typed callback/refresh failure, never a defect; `expires_in` is accepted as a number or a numeric string. JWKS entries are narrowed structurally before they can become key material: only RSA entries carrying `n` and `e`, with `use` absent or `sig` and `alg` absent or `RS256`, are candidates — a `kty`-less entry is never selected.

**Deadlines and retries on every outbound call (ECF-001, ERS-003).** No outbound provider call may outlive a configured deadline. `OAuthConfig.httpTimeouts` sets one per call class — `tokenExchange` (the code exchange and the refresh grant), `jwks`, `userinfo`, `discovery` (defaults 10s/5s/5s/10s) — each covering the request and its body decode; an overrun is interrupted and surfaces as `ProviderUnavailable` (or `OAuthRefreshFailed` on the refresh port; a discovery overrun at boot dies). Only the idempotent GETs (JWKS, userinfo, discovery) are retried, with jittered exponential backoff inside their deadline (`OAuthConfig.retry`, default two retries from 50ms). The code exchange and the refresh grant are never retried: an authorization code is single-use (RFC 6749 §4.1.2) and a refresh token may rotate on use.

**Discovery availability (NAM-004).** Provider resolution is shared: `OAuth` and `OAuthTokenAccess` read one `OAuthProviders` registry, so each discovery document is fetched once per process. By default (`discovery: { mode: "boot" }`) a provider is resolved while the layer builds — misconfiguration and issuer mismatch die at boot, and a merely *unreachable* endpoint is retried before it too fails startup. A provider may opt into `discovery: { mode: "lazy", refresh }`: it resolves on first use and is refreshed on the `refresh` interval (default one hour); while discovery is unreachable it answers `ProviderUnavailable` without blocking the rest of the auth runtime, and a fetched issuer that mismatches (or a malformed document) disables that provider permanently with a logged defect — the exact-match guarantee above still fails closed, only at first use instead of boot.

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

**`baseUrl` is required configuration (PDR-005, AGA-005).** `redirect_uri` is derived from `baseUrl`, so `OAuthConfig` is a plain `Context.Service` with no default (the `JwtConfig` precedent): composing OAuth without `OAuth.config({ baseUrl })` fails to type-check. `baseUrl` must be the public scheme+host(+port) the provider redirects to — no path, query, fragment or credentials — and is validated when the plugin boots (a malformed value dies with a descriptive message; a plain-`http` non-loopback host logs a warning). The origin, not the raw string, is used, so a trailing slash never doubles into `redirect_uri`; `Host`/`X-Forwarded-Host` are never consulted. Each provider's effective `redirect_uri` is logged once at boot so an operator can diff it against the provider console.

_Previous: [BEH-EA-127](16-oauth.md#beh-ea-127-generic-oidc-discovery-with-exact-issuer-match) | Next: [BEH-EA-129](17-passkey.md#beh-ea-129-webauthn-is-a-port-wrapped-not-reimplemented)_
