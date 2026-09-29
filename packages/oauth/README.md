# @awthaq/oauth

OAuth 2.0 / OpenID Connect sign-in as a plugin: authorization-code flow with structural PKCE, server-held flow state, explicit-by-default account linking, `id_token` verification, and a scoped provider-token refresh port. Behavior is specified in [`spec/behaviors/16-oauth.md`](../../spec/behaviors/16-oauth.md) (BEH-EA-121 – 128).

```ts
import { OAuth, OAuthProvider } from "@awthaq/oauth";
import * as Config from "effect/Config";

const okta = OAuthProvider.oidc({
  id: "okta",
  issuer: Config.string("OKTA_ISSUER"),
  discoveryUrl: Config.string("OKTA_DISCOVERY_URL"),
  clientId: Config.string("OKTA_CLIENT_ID"),
  clientSecret: Config.redacted("OKTA_CLIENT_SECRET"),
  scopes: ["openid", "email", "profile"],
  mapProfile: (claims) => ({ subject: String(claims["sub"]), email: String(claims["email"]) }),
});

// `baseUrl` is required: the public origin the provider redirects back to.
const OAuthConfig = OAuth.config({ providers: [okta], baseUrl: "https://app.example.com" });
```

## Vendor presets

`@awthaq/oauth/presets` ships data-only presets built on `OAuthProvider.oidc`/`oauth2` — the factories remain the escape hatch for any provider not listed:

```ts
import * as OAuthPresets from "@awthaq/oauth/presets";

const google = OAuthPresets.google({
  clientId: Config.string("GOOGLE_CLIENT_ID"),
  clientSecret: Config.redacted("GOOGLE_CLIENT_SECRET"),
});
```

| Preset | Kind | Notes |
|---|---|---|
| `google` | OIDC (discovery) | Google asserts `email_verified`: the usual candidate for `trustedProviders` |
| `github` | OAuth2 | numeric `id` becomes the string subject; `/user`'s email is not asserted verified; secret in the body |
| `microsoft({ tenant })` | OIDC (discovery) | `tenant` must be the tenant **id** (GUID) — the multi-tenant aliases (`common`, `organizations`) publish a placeholder issuer and fail loudly at boot |
| `gitlab({ baseUrl? })` | OIDC (discovery) | gitlab.com by default; pass a self-managed instance's public URL |
| `discord` | OAuth2 | `verified` is Discord's email assertion |

Every preset accepts `id`, `scopes` and `mapProfile` overrides. **Apple is not shipped:** its `name`/`email` scopes require `response_mode=form_post`, a POST callback this GET-only contract cannot receive.

## Deploying behind a proxy or gateway

`baseUrl` **must be the public scheme + host (+ port) your users and the provider see** — TLS usually terminates at the proxy, so the process itself may only see plain `http` on an internal port. It is validated at boot: no path, query, fragment or credentials, and a plain-`http` non-loopback value logs a warning (most providers refuse such a `redirect_uri`, and the session cookie needs HTTPS).

`redirect_uri` is always `${baseUrl}/oauth/<providerId>/callback` and must be registered **verbatim** at the provider. `Host` and `X-Forwarded-Host` are never consulted, by design (BEH-EA-128). At boot the plugin logs, at info level, the effective `redirect_uri` for every provider so you can diff it against the provider console. Client IPs (for rate limiting) are a separate knob: see `ClientAddress.layerTrustedProxy`.

## OIDC validation scope

| Checked on every `id_token` | |
|---|---|
| Signature | RS256, PS256, ES256, ES384 or EdDSA, whichever the provider's allowlist names (`idTokenSigningAlgs`; default: what discovery advertises that this plugin verifies, else `["RS256"]`; empty dies at boot), against the provider's JWKS (`use` absent or `sig`; `alg` absent or the token's; a key of the right type and curve), one single-flight cache per provider with a 15-minute TTL and at most one forced refetch per 30 seconds on an unknown `kid`. HS256 and `none` are never accepted |
| `iss` | exact match with the configured issuer |
| `aud` / `azp` | string or array containing the client id; `azp` required (and equal) when several audiences are present |
| `exp` / `nbf` / `iat` | with a configurable clock-skew leeway |
| `nonce` | mandatory for `oidc` providers, bound to the flow |
| `sub` | must equal the `userinfo` `sub` when a userinfo endpoint is also called; the signed `id_token` wins `sub`/`email`/`email_verified` |

Deliberately **not** validated, and why:

- **`at_hash`** — only `response_type=code` exists (pinned structurally), where OIDC Core 3.1.3.7 makes it optional. It becomes **required** if a hybrid or implicit response type is ever added.
- **`auth_time` / `max_age`** — freshness and step-up authentication are unsupported here; they belong to the step-up work (wayfinder ticket 15).
- **ES256 / EdDSA signatures** — a documented gap (see `src/Jwt.ts`).

## Operational knobs (`OAuth.config`)

- `httpTimeouts` — a deadline per outbound call class (`tokenExchange` 10s, `jwks` 5s, `userinfo` 5s, `discovery` 10s), covering request and body decode. An overrun answers `ProviderUnavailable` (503).
- `retry` — jittered exponential backoff for the idempotent GETs only (JWKS, userinfo, discovery; default two retries from 50ms). The code exchange and the refresh grant are **never** retried.
- `rateLimits` — per-IP limits for `authorize` (30/min), `callback` (20/min) and the native `token` redemption (20/min).
- `nativeRedirectURLs` / `nativeExchangeTtl` — the native return leg (below); off by default.
- `clockSkew` (default 60s) — leeway on an `id_token`'s `exp`/`nbf`/`iat`; `maxIdTokenAge` — optionally also reject an `id_token` whose `iat` is older than this.
- Provider `discovery: { mode: "lazy", refresh }` resolves a provider's discovery document on first use instead of at boot, answering `ProviderUnavailable` while it is unreachable (an issuer mismatch still disables the provider permanently).

## Native and mobile apps

A native app's system browser (`ASWebAuthenticationSession`, Android Custom Tabs) keeps its own cookie jar, so the browser flow's `Set-Cookie` on the callback `302` never reaches the app. The native flow returns to a deep link with a one-time **exchange code** instead, which the app redeems for its session token. The token itself never appears in a URL.

1. Allow the deep link: `OAuth.config({ nativeRedirectURLs: ["myapp://oauth/callback"] })`. Entries are private-use-scheme URLs (RFC 8252 §7.1: `myapp://oauth/callback`, or `com.example.app:/cb`); `http(s)`, `javascript`, `data`, `blob` and `file` entries are refused at boot. A requested `callbackURL` is matched on the normalized scheme, authority and path (an entry admits deeper paths at a `/`, `?` or `#` boundary, never a bare string prefix). Where the platform supports it, prefer a claimed `https` universal/app link listed in `trustedOrigins`.
2. Start the flow with `GET /oauth/:provider/authorize?mode=native&callbackURL=myapp://oauth/callback[&code_challenge=<S256>]`. Anything not allowlisted (or a deep link without `mode=native`) falls back to `defaultCallbackURL` and logs one warning naming the reason; the request itself still succeeds.
3. The callback redirects to `myapp://oauth/callback?code=<exchange code>` and sets no session cookie.
4. Redeem it once: `POST /oauth/token` with `{ "code": "...", "codeVerifier": "..." }` answers the session with its `token` field set (`Cache-Control: no-store`); present it afterwards as `Authorization: Bearer <token>`. The code is single-use and expires after `nativeExchangeTtl` (60 seconds). Store the token in the Keychain/Keystore; that is the app's job.

**Send a `code_challenge`.** A private-use scheme can be claimed by another app on the device, which would then receive the redirect and its code (RFC 8252 §8.1). With `code_challenge=base64url(SHA-256(verifier))` on the authorize request and the matching `codeVerifier` at redemption, an intercepted code is useless; without it, anyone who can read the redirect within the TTL can redeem it. A wrong or missing verifier spends the code.

## Known limitations

- **First landing request after sign-in may look signed out.** The callback sets the `SameSite=Strict` `__Host-session` cookie on a `302` to your `callbackURL`. Browsers evaluate `SameSite` over the whole redirect chain, and this one began on the provider's site, so the cookie is stored but withheld from that first landing request; every later navigation carries it. If your landing page is server-rendered behind an auth check, land on a route that resolves the session client-side with a same-site `fetch` (or tolerate one re-render). A configurable session-cookie policy or an interstitial bounce page would remove the wrinkle; both are tracked separately (see BEH-EA-122 in the spec).
- ES256/EdDSA `id_token` signatures and POST (`form_post`) callbacks are not supported.

## Migrating from Auth.js

| Auth.js | awthaq |
|---|---|
| `allowDangerousEmailAccountLinking: true` on provider `x` | `linking: { trustedProviders: ["x"] }` |
| no flag (the default) | `linking: "explicit"` (the default) |

awthaq is deliberately stricter than Auth.js: a trusted provider auto-links only when the **provider asserts `email_verified`** *and* the **local account's own email is already verified** (a squatter-registered, unverified local account is never linked into). Otherwise the callback answers `409 AccountExists`, listing the providers the account really has, and the user must sign in and then link explicitly. Users who relied on Auth.js's unconditional auto-link will see `AccountExists` on their first sign-in after migration.

### Auth.js provider id to awthaq preset

| Auth.js provider | awthaq |
|---|---|
| `Google` | `OAuthPresets.google` |
| `GitHub` | `OAuthPresets.github` |
| `AzureAD` / `MicrosoftEntraID` | `OAuthPresets.microsoft({ tenant: "<tenant id>" })` |
| `GitLab` | `OAuthPresets.gitlab` |
| `Discord` | `OAuthPresets.discord` |
| `Apple` | not available (needs a POST callback) — see above |
| any other OIDC provider | `OAuthProvider.oidc({ issuer, discoveryUrl, ... })` |
| any other OAuth2 provider | `OAuthProvider.oauth2({ endpoints, ... })` |

## Importing federated identities

An account is keyed on `(providerId, subject, issuer)` (BEH-EA-125). When importing users from another system, write exactly the key a sign-in will look up, or the first callback silently creates a duplicate user (by design: email is never an anchor). `OAuth.accountAnchorFor(providerConfig, subject)` computes it from the provider config so importers cannot drift:

| Field | Value |
|---|---|
| `providerId` | the awthaq provider `id` |
| `subject` | the IdP's `sub` — for Firebase, `providerUserInfo[].rawId`, **not** the Firebase `uid` |
| `issuer` | the provider's configured issuer (absent for a plain `oauth2` provider) |

| Provider | `subject` source | `issuer` |
|---|---|---|
| Google | `sub` | `https://accounts.google.com` |
| Apple | `sub` | `https://appleid.apple.com` |
| GitHub | numeric user `id`, as a string | *(none — `oauth2`)* |

A dry-run that replays `findByProviderSubject` for every imported row (and reports rows that would fall through) is tracked with the CLI import work (`awthaq import --dry-run`, BEH-EA-207).

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.
