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

## Deploying behind a proxy or gateway

`baseUrl` **must be the public scheme + host (+ port) your users and the provider see** — TLS usually terminates at the proxy, so the process itself may only see plain `http` on an internal port. It is validated at boot: no path, query, fragment or credentials, and a plain-`http` non-loopback value logs a warning (most providers refuse such a `redirect_uri`, and the session cookie needs HTTPS).

`redirect_uri` is always `${baseUrl}/oauth/<providerId>/callback` and must be registered **verbatim** at the provider. `Host` and `X-Forwarded-Host` are never consulted, by design (BEH-EA-128). At boot the plugin logs, at info level, the effective `redirect_uri` for every provider so you can diff it against the provider console. Client IPs (for rate limiting) are a separate knob: see `ClientAddress.layerTrustedProxy`.

## OIDC validation scope

| Checked on every `id_token` | |
|---|---|
| Signature | RS256 only, against the provider's JWKS (`kty: RSA` with `n`/`e`; `use` absent or `sig`; `alg` absent or `RS256`), refetched once on an unknown `kid` and after a 15-minute TTL |
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
- `rateLimits` — per-IP limits for `authorize` (30/min) and `callback` (20/min).
- `clockSkew`-style leeway and id_token age limits for claim validation live alongside these (see `OAuthConfigShape`).
- Provider `discovery: { mode: "lazy", refresh }` resolves a provider's discovery document on first use instead of at boot, answering `ProviderUnavailable` while it is unreachable (an issuer mismatch still disables the provider permanently).

## Migrating from Auth.js

| Auth.js | awthaq |
|---|---|
| `allowDangerousEmailAccountLinking: true` on provider `x` | `linking: { trustedProviders: ["x"] }` |
| no flag (the default) | `linking: "explicit"` (the default) |

awthaq is deliberately stricter than Auth.js: a trusted provider auto-links only when the **provider asserts `email_verified`** *and* the **local account's own email is already verified** (a squatter-registered, unverified local account is never linked into). Otherwise the callback answers `409 AccountExists`, listing the providers the account really has, and the user must sign in and then link explicitly. Users who relied on Auth.js's unconditional auto-link will see `AccountExists` on their first sign-in after migration.

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
