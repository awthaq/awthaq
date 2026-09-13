# OAuth & OIDC — Research

## TL;DR

- **OAuth 2.1 is still an IETF draft** as of 2026-09 (`draft-ietf-oauth-v2-1-16`, expires 2027-03; the WG milestone lists "Submit OAuth 2.1 to IESG" for Dec 2026). Design to 2.1 semantics (PKCE mandatory, implicit/ROPC removed, exact `redirect_uri` matching) but treat RFC 6749/7636/6750 + RFC 9700 as the normative stack; 9700 supersedes RFC 6819 and its guidance "is incorporated into OAuth 2.1". Live follow-ups: "Updates to OAuth 2.0 Security BCP" (July 2026) and the JWT BCP revision `rfc8725bis` — assume the security floor keeps rising.
- **Arctic is deprecated.** Its author (pilcrowonpaper, the Lucia author — verified via his blog) deprecated the npm package (latest 3.7.0 still pulls ~828K weekly downloads) and wrote that OAuth 2.0 "isn't an ideal layer to abstract into a library; any library should target an abstraction one or two layers above it." effect-auth must own its client layer; Arctic's per-provider fact tables remain reference material, not a dependency.
- **A new BCP landed mid-2026: RFC 10017, OAuth 2.0 for Browser-Based Apps** (BCP 212, Aug 2026, editors Parecki/Waite/De Ryck). It formalizes what better-auth/Auth.js already practice: JS apps should not hold OAuth tokens; cookie-session BFF is the robust default. This is directly load-bearing for effect-auth's default topology and Q87.
- **Ecosystem consolidation:** Auth.js (NextAuth) is now maintained by the Better Auth team (announced 2025-09); Better Auth itself joined Vercel. better-auth is now the dominant TS reference design; Auth.js's `OAuth2Config` (`issuer`/`wellKnown` + `authorization`/`token`/`userinfo`/`profile` + `checks: ["pkce"|"state"|"none"]`) remains the best-typed generic-provider shape to borrow.
- **State/nonce storage:** the two proven designs are (a) an encrypted, short-TTL, `HttpOnly` cookie blob (Auth.js: state+PKCE verifier+nonce; better-auth `storeStateStrategy: "cookie"`) and (b) server-side verification storage with an opaque cookie handle (better-auth default `"database"`). effect-auth already has a purpose-scoped single-use Verification core (PRD Q46) — reuse it for flow state (`purpose: "oauth.flow"`), which gives single-use + TTL + replay protection by construction.
- **Account linking splits the ecosystem:** Auth.js defaults auto-link **off** (`allowDangerousEmailAccountLinking`, opt-in, name says "dangerous"); Better Auth defaults implicit verified-email linking **on** (opt-out via `disableImplicitLinking`; `trustedProviders` links even without `email_verified`). Recommendation: default off, explicit `linkSocial` flow, opt-in auto-link per provider.
- **Identity anchor is always `(providerId, subject)`** where subject = OIDC `sub` (stable, never reassign) or the provider's numeric id — never email (Apple strips it after first login; Entra ID explicitly forbids using email for authorization).
- **Provider quirks are the real work:** Apple (no PKCE, ES256 JWT client secret, `form_post`, name/email only on first consent, no userinfo endpoint, nonce required for id-token binding); GitHub (private email ⇒ `null` on `/user`, must call `/user/emails` with `user:email` scope; OAuth App tokens never expire vs GitHub App 8h+6mo-refresh); Google (refresh tokens die after 7 days while consent screen is "Testing"); Entra ID (email untrustworthy; anchor on `oid`).
- **Q88 OAuth threat classes with real CVEs:** SSRF via provider-configured endpoints (`request_uri` — Keycloak CVE-2020-10770; Cognito discovery SSRF; Open WebUI CVE-2026-54008 via attacker-controlled avatar URLs), open redirect on post-login destination (Twenty, CVE-2026-82274), missing/reusable state (Holtmann's OIDC series), mix-up attacks (countermeasure: RFC 9207 `iss`), code substitution (PKCE fixes).
- **Delivery (Q48) intersects OAuth**: per-provider `requireEmailVerification` gating only makes sense with a `Mailer` capability present; better-auth's docs warn plugins must not assume provider emails are deliverable (placeholder emails for Apple/Discord/Entra). Mailer should be an optional capability with a hard dependency declared only by plugins that need it, and email sends must not be awaited on request paths (timing/enumeration).
- v1 provider set: **Google, GitHub, Apple built-ins + a discovery-driven generic OIDC provider** (matches PRD §25 and is exactly the better-auth split: `socialProviders` + Generic OAuth plugin).

---

## Questions answered

### Q54 — Generic provider interface, PKCE, state/nonce storage, callback URL handling, provider set at v1

**Evidence.**

*Normative stack (verified current as of 2026-09):*

- RFC 6749 (framework), RFC 6750 (bearer), RFC 7636 (PKCE): authorization-code flow, `code_verifier`/`code_challenge` (S256), `state`. ([rfc-editor.org/rfc/rfc6749](https://www.rfc-editor.org/rfc/rfc6749), [rfc7636](https://www.rfc-editor.org/rfc/rfc7636))
- RFC 9700 (Jan 2025) supersedes RFC 6819: mandates PKCE for *all* clients, deprecates implicit + password grants, requires exact-string `redirect_uri` comparison (AS-side), requires clients to defend against mix-up attacks, requires refresh-token rotation for public clients. [rfc-editor.org/rfc/rfc9700](https://www.rfc-editor.org/rfc/rfc9700), [oauth.net summary](https://oauth.net/2/oauth-best-practice/), [WorkOS deep-dive](https://workos.com/blog/oauth-best-practices)
- OAuth 2.1: active draft `draft-ietf-oauth-v2-1-16` (Sept 2026, expires 2027-03) — not an RFC yet; WG milestone targets IESG submission Dec 2026. Re-verify status before effect-auth 1.0. A follow-up "Updates to OAuth 2.0 Security BCP" draft is also circulating (July 2026). [datatracker draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/), [oauth.net/specs](https://oauth.net/specs/), [security-topics-update](https://datatracker.ietf.org/doc/draft-ietf-oauth-security-topics-update/)
- OIDC Core 1.0 §3.1.3.7: when `nonce` is sent in the auth request, the AS MUST echo it into the `id_token`; clients validate iss/aud/exp/nonce against discovery's `issuer` and `jwks_uri`. [openid.net/connect-core](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowValidation)
- OIDC Discovery / RFC 8414: `GET /.well-known/openid-configuration` (OIDC) or `.well-known/oauth-authorization-server` (RFC 8414); the returned `issuer` MUST match the expected value exactly — this exact-match rule is the first SSRF/impersonation control. [openid discovery](https://openid.net/specs/openid-connect-discovery-1_0.html), [rfc8414](https://www.rfc-editor.org/rfc/rfc8414)
- RFC 9207: `iss` parameter on authorization responses — the standard mix-up countermeasure; validate it whenever the provider sends it. [datatracker.ietf.org/doc/rfc9207](https://datatracker.ietf.org/doc/rfc9207/)
- Deployment BCPs: RFC 10017 *OAuth 2.0 for Browser-Based Apps* (published Aug 2026, part of BCP 212) and RFC 8252 *Native Apps* — the former is why cookie/BFF is the sane default for a web-first auth library. [rfc10017 draft page](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps), [oauth WG listing](https://datatracker.ietf.org/group/oauth/), [rfc8252](https://www.rfc-editor.org/info/rfc8252/)

*How existing libraries shape the provider abstraction:*

- **Arctic** (pilcrowonpaper): per-provider clients exposing only `createAuthorizationURL`, `validateAuthorizationCode`, `refreshAccessToken`; authorization-code flow only; Fetch-based, zero deps, 50+ providers, 828K weekly npm downloads at deprecation time. Verified: the author deprecated it with the design lesson that a library should sit "one or two layers above" raw OAuth: per-provider APIs diverge too much (Apple's nonce + JWT client secret, GitHub's emails endpoint) for one uniform surface. [github.com/pilcrowonpaper/arctic](https://github.com/pilcrowonpaper/arctic), [npm](https://www.npmjs.com/package/arctic), [deprecation post](https://pilcrowonpaper.com/blog/18), [arcticjs.dev](https://arcticjs.dev/)
- **Auth.js `OAuth2Config<Profile>`**: `id`/`name`/`type: "oauth"`, optional `issuer`/`wellKnown` (RFC 8414 discovery) *or* explicit `authorization`/`token`/`userinfo` endpoint configs, `profile(profile, tokens)` mapping callback, `account(tokens)` subset callback, `client` overrides to `oauth4webapi`, and `checks: ("none"|"state"|"pkce")[]` with default `["pkce"]` (`"state"` auto-added when a redirect proxy is configured). `OIDCConfig` extends it. Verified against the API reference. [authjs.dev/reference/core/providers](https://authjs.dev/reference/core/providers)
- **better-auth social providers**: config object per provider (`clientId`, `clientSecret`, `scope`, `redirectURI`, `prompt`, `responseMode`, `disableImplicitSignUp`, `mapProfileToUser`, `getUserInfo`, `verifyIdToken`, `refreshAccessToken`, `requireEmailVerification`, multi-`clientId` arrays for aud matching). The **Generic OAuth plugin** is the generic shape: `discoveryUrl` *or* explicit `authorizationUrl`/`tokenUrl`/`userInfoUrl`, `accountSubject` resolver (immutable identity field), `tokenEndpointAuth` (`client_secret_basic|post|private_key_jwt|none|custom`), `pkce` (default **true**; disable only for providers that reject it — i.e. Apple), `responseMode`, `accessType: "offline"`, `requireIdTokenVerification`, `disableIdTokenNonceBinding` (nonce bound by default per OIDC Core §3.1.3.7), `endSessionEndpoint` (RP-initiated logout read from discovery). Verified. [better-auth.com/docs/concepts/oauth](https://better-auth.com/docs/concepts/oauth), [generic-oauth plugin](https://better-auth.com/docs/plugins/generic-oauth)
- **Keycloak / Ory Hydra** sit on the discovery side: any standards-conformant AS is just `issuer + clientId + secret + scopes` to the generic provider; Keycloak exposes per-realm `.well-known/openid-configuration`. [keycloak.org](https://www.keycloak.org/documentation), [ory.sh/hydra](https://www.ory.sh/hydra/docs/)

*Comparison of the four designs:*

| Design | Provider surface | Flow/protocol handling | Quirk handling | Lesson for effect-auth |
| --- | --- | --- | --- | --- |
| **Arctic** (deprecated) | One client class per provider (`Google`, `GitHub`, …), ~3 methods each | Raw OAuth2 code flow only; no session/linking/state ownership | Encoded in per-provider classes | Per-provider divergence is real — but model it as *data presets* over one core, not one hand-written class per provider |
| **Auth.js `OAuth2Config`** | Single config type; OIDC via `wellKnown`/`issuer` or explicit endpoint fields; `profile()`/`account()` callbacks | `checks` array — default `["pkce"]`, `"state"` optional, `"none"` possible | Thin (`conform` flags, `customFetch`) | Best generic shape to borrow; drop the `"none"` escape hatch and make nonce/id-token validation structural for OIDC |
| **better-auth social + Generic OAuth** | Built-in presets + config-driven generic (`discoveryUrl`/explicit endpoints, `accountSubject`, `tokenEndpointAuth`) | PKCE + state + nonce on by default; `pkce: false` opt-out for rejecting providers | Rich: documented per-provider email/refresh quirk table | Closest to target; effect-auth additionally moves flow state into core Verification and validates provider configs at `Auth.make()` time |
| **Keycloak / Ory Hydra (AS side)** | Client = `issuer + clientId + secret + redirect URIs` | Full OIDC discovery per realm/deployment | n/a — they *are* the provider | Compatibility target: generic-OIDC mode must work against both unmodified |

*State/nonce storage:*

- better-auth signs/persists flow state (`callbackURL`, `codeVerifier`, `errorURL`, `newUserURL`, `link`, `requestSignUp`, `expiresAt`, server-trusted context, client `additionalData`) with an explicit `storeStateStrategy`: `"cookie"` (encrypted cookie, stateless) vs `"database"` (verification table + signed correlation cookie) — defaulting to database whenever a DB or secondary storage exists, cookie only for fully stateless setups. [options reference](https://better-auth.com/docs/reference/options)
- Auth.js stores state/PKCE verifier/nonce in encrypted `HttpOnly` cookies (cookies are also what enables its `redirectProxyUrl` cross-site flow). [authjs.dev/reference/core/providers](https://authjs.dev/reference/core/providers)
- Lucia's OAuth guide (now a learning resource) teaches the same two options: signed cookie or DB row keyed by state. [v3.lucia-auth.com/guides/oauth/basics](https://v3.lucia-auth.com/guides/oauth/basics)

*Callback URL handling:* derive the `redirect_uri` from the configured base URL (`${baseUrl}/auth/oauth/:provider/callback`), never from request input; validate the post-login destination (`callbackURL`) against the trusted-origin allowlist; send the exact pre-registered URI to the AS. better-auth defaults `/api/auth/callback/${provider}` and rejects reserved query keys (`state`, `code_challenge`, `redirect_uri`, …) in `additionalParams` with a 400 so a caller cannot corrupt flow correlation. [better-auth oauth](https://better-auth.com/docs/concepts/oauth), RFC 9700 exact-match requirement.

*Proposed provider abstraction for effect-auth* (three layers, so quirks stay per-provider and the protocol core stays uniform — the Arctic lesson applied to Effect):

```ts
// 1. Declaration — static, validated at Auth.make() time (PRD §5.3)
interface OAuthProvider {
  readonly id: string                                  // route + account.providerId key
  readonly kind: "oauth2" | "oidc"
  readonly issuer?: string                             // oidc: exact-match vs discovery
  readonly discoveryUrl?: string                       // or explicit endpoints:
  readonly endpoints?: Partial<OAuthEndpoints>
  readonly clientId: string
  readonly clientSecret?: EffectAuthSecret             // optional ⇒ public client
  readonly tokenAuth?: TokenEndpointAuth               // basic | post | private_key_jwt | none
  readonly scopes: ReadonlyArray<string>
  readonly pkce: true                                  // structural `true`; quirks override
  readonly quirks?: ProviderQuirks                     // { responseMode, sha256Nonce,
                                                       //   skipPkce, emailsEndpoint, ... }
  readonly mapProfile: (raw: unknown, tokens: TokenSet) => Effect<OAuthProfile, ProviderError>
  readonly subjectOf?: (raw: unknown, tokens: TokenSet) => string  // default: `sub` ?? `id`
}
// google(), github(), apple(), genericOidc({ issuer, ... }) return OAuthProvider factories.

// 2. Service — one tag, registry content compiled from installed providers
class OAuthRegistry extends Context.Tag("auth.oauth/Registry")<OAuthRegistry, ReadonlyMap<string, OAuthProvider>>() {}
class OAuthClient extends Context.Tag("auth.oauth/Client")<OAuthClient, {
  readonly authorizeUrl: (providerId: string, input: AuthorizeInput) => Effect<URL, OAuthError>
  readonly callback:     (providerId: string, input: CallbackInput)  => Effect<OAuthIdentity, OAuthError>
  readonly refresh:      (providerId: string, rt: RefreshToken)      => Effect<TokenSet, OAuthError>
}> {}

// 3. Flow state — reuse core Verification (purpose-scoped, single-use, TTL, hashed key)
//    purpose: "oauth.flow", payload = { codeVerifier, nonce?, callbackURL, link?, expiresAt }
```

The `callback` service performs, in order: verify `state` (single-use fetch from Verification + constant-time compare) → validate RFC 9207 `iss` if present → exchange code (PKCE verifier + client auth) → if `kind === "oidc"` verify `id_token` (sig via cached JWKS, `iss` exact match, `aud`, `exp`, `nonce`) → `mapProfile` → return `{ subject, profile, tokens }` to the plugin's linking logic (Q55).

**Recommendation:**

1. Build the OAuth client in `@effect-auth/plugin-oauth` (no Arctic/jose dependency in core; use Effect `HttpClient` for transport and a small JWKS+JWS verifier, or `jose` if the crypto-inventory decision (Q89) prefers it).
2. Generic OIDC (discovery + exact issuer match + JWKS cache with TTL + nonce always) is the *default* provider kind; Google/GitHub/Apple are shipped as thin quirk-preset factories over the same interface. OAuth 2.0-only providers (GitHub) run without id-token validation.
3. PKCE S256 always (better-auth generic default; RFC 9700 mandate); state always single-use with ≤10-min TTL; `nonce` always for OIDC flows, bound into `id_token` validation. No `"none"` checks escape hatch.
4. Store flow state in the core Verification store (purpose `oauth.flow`), keeping only an opaque `HttpOnly`/`SameSite=Lax`/`Secure` correlation cookie in the browser. This is better-auth's `"database"` mode generalized; it survives serverless multi-instance by default and gets single-use/replay semantics from Q46 machinery. Provide the cookie-only mode as an opt-in for DB-less deployments.
5. `redirect_uri` is always derived from configured base URL; post-login `callbackURL` must pass the core trusted-origins validator (Q88).
6. v1 provider set = Google, GitHub, Apple, generic OIDC (+ generic OAuth2 with explicit endpoints, ~free once the interface exists). That matches PRD §25 exactly and covers Keycloak/Hydra/Okta/Entra/WorkOS users on day one.
7. Ship per-provider quirk presets as *data* (documented table), not scattered conditionals: Apple (`form_post`, nonce echo — the web flow sends the raw nonce and compares the `id_token` claim, while native SDK flows send `SHA256(rawNonce)` and compare the hash — plus no PKCE and an ES256 JWT client secret ≤6mo); GitHub (`emailsEndpoint` preset for `/user/emails`; OAuth App tokens never expire vs GitHub App 8h token + 6mo refresh); Google (`hd`, `include_granted_scopes`, Testing-mode 7-day refresh expiry ([Google docs](https://developers.google.com/google-ads/api/docs/get-started/common-errors))).

**Confidence:** high (spec stack and library designs verified against primary sources; the state-storage recommendation is a synthesis of two proven designs — product nuance is open in Q55/§Open questions).

### Q55 — OAuth account linking: auto-link on verified email? conflicting-account flow, silent account creation

**Evidence.**

- **Auth.js: auto-link is off by default** — "Automatic account linking on sign in is not secure between arbitrary providers and is disabled by default"; opt in per provider with `allowDangerousEmailAccountLinking: true`, justified only "if you trust that the provider involved has securely verified the email address." [authjs.dev/reference/core/providers](https://authjs.dev/reference/core/providers)
- **Better Auth: implicit linking is on by default** — when a provider-verified email matches an existing user, the OAuth account is linked automatically; `account.accountLinking` controls: `enabled` (default true), `disableImplicitLinking` (reject same-email sign-in with `account_not_linked` instead of linking; explicit `linkSocial` still works), `trustedProviders` (auto-link even without `email_verified` — "use with caution as it may increase the risk of account takeover"), `allowDifferentEmails`, `allowUnlinkingAll` (otherwise the last account cannot be unlinked), `updateUserInfoOnLink` (copies name/image but **never** `email`/`emailVerified`, "so linking a provider can't rebind the account's identity"). [users-accounts](https://better-auth.com/docs/concepts/users-accounts), [options](https://better-auth.com/docs/reference/options)
- **Conflicting-account UX** in better-auth = error code `account_not_linked` ("the provider email does not match any existing user / linking rules prevent automatic linking") sent to the error URL, plus the authenticated `linkSocial()` flow for deliberate linking (optionally with different email, additional scopes merged into `account.scope`, or direct id-token linking for native SDKs). [errors/account_not_linked](https://better-auth.com/docs/reference/errors/account_not_linked), [oauth docs](https://better-auth.com/docs/concepts/oauth)
- **Silent account creation**: better-auth has per-provider `disableImplicitSignUp` (sign-in requires `requestSignUp: true`) and `disableSignUp`; Auth.js historically auto-creates the user on first OAuth sign-in. Silent creation on first sign-in is the ecosystem norm.
- **Email is a bad anchor**: Apple only emits email/name on the first consent (no userinfo endpoint — "persist the email the first time you see it"); Entra ID docs forbid `email`/`preferred_username` for authorization; Facebook exposes no verification flag. Identity is `(providerId, accountId/sub)`; better-auth's `accountSubject` exists precisely because some providers use non-`sub` immutable fields. [better-auth providers-without-email table](https://better-auth.com/docs/concepts/oauth), [MS claims guidance](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation)
- **Security rationale**: auto-link by email is account-takeover-prone when any linked provider has weak email verification; the "dangerous" naming in Auth.js and better-auth's `trustedProviders` warning both document this. Email-change at the provider re-opens the risk on every sign-in (better-auth added `validateUserInfo` on `sign-in` to re-check the *fresh* provider email against domain policy). [users-accounts callbacks](https://better-auth.com/docs/concepts/users-accounts)

**Recommendation:**

1. Default **off** for auto-link (Auth.js stance). Same-email + `email_verified` + no existing account → silently create user (that's just sign-up); same-email + existing user → new typed error `AccountNotLinked` surfaced to the client as a "this email already has an account — sign in and link it" state, not a link.
2. Opt-in per provider: `linking: { auto: true }` (better-auth's implicit mode) for operators who accept the trade-off, plus `trustedProviders` and `allowDifferentEmails` equivalents. Keep PRD Q43's `(provider, providerAccountId)` uniqueness as the identity invariant.
3. Explicit link flow via the same `authorize → callback` machinery started *with* a session (state payload carries `link: { userId }` server-side — never client input, matching better-auth's `serverContext` design).
4. Unlink guards: refuse to remove the last credential/account (unless `allowUnlinkingAll`), mirroring better-auth and PRD Q43's "unlink guards."
5. `emailVerified` on the local user is derived once from the provider claim at creation; later provider email changes do **not** silently rebind — require the verification flow (ties into Q46 verification and Q48 Mailer).

**Confidence:** high on the ecosystem survey and the default-off recommendation (both major frameworks document the trade-off explicitly); medium on the exact default for apps that are OAuth-only (better-auth's default-on exists because OAuth-only apps suffer UX without it — a genuine product call, see Open questions).

### Q48 — Email/SMS delivery abstraction (as it relates to verification flows)

**Evidence.**

- PRD non-goals: effect-auth is not an "email/SMS provider" (§4); verification is core (§24: email verification, token verification, expiration, one-time usage); observability must redact tokens (§52). Plugins need a *capability*, not a vendor.
- better-auth's shape: library generates the single-use `url` + `token` (TTL from `emailVerification.expiresIn`, default 3600s, stored in verification storage), the app supplies `sendVerificationEmail({ user, url, token })`; same callback pattern for reset password, change-email confirmation (sent to the *current* email), delete-account confirmation (the recommended path for OAuth users without passwords). Docs explicitly warn: "Avoid awaiting the email sending to prevent timing attacks. On serverless platforms, use `waitUntil`" — i.e., sends are fire-and-forget on request paths. [options/emailVerification](https://better-auth.com/docs/reference/options), [users-accounts](https://better-auth.com/docs/concepts/users-accounts)
- No HTML templating lives in the library — the callback receives semantic inputs (`user`, `url`, `token`) and the app owns content. Templates are app/plugin code.
- OAuth interaction: placeholder emails for providers without email (Apple after first login, Discord, Roblox) mean "Plugins that send mail (password reset, magic link, email verification, organization invites) cannot deliver to them"; better-auth's `requireEmailVerification` per social provider is opt-in and warns it will block every sign-in on providers with untrustworthy `email_verified`. [oauth docs](https://better-auth.com/docs/concepts/oauth)

**Recommendation:**

1. `Mailer` is a `Context.Tag` capability in core, implemented by app-provided Layers; the OAuth plugin declares `R = Mailer` on the flows that can send mail (verification-gated sign-in, link notifications) and `R = never` otherwise — the Effect dependency graph *is* the "what plugins may assume" contract. Shape: `send(input: EmailMessage | VerificationEmail) : Effect<void, DeliveryError>` where `VerificationEmail` carries `user`, `url`, `token`, `purpose` — URLs/tokens are minted by core Verification (Q46), never by the plugin.
2. Fire-and-forget: core wraps sends with `Effect.forkDaemon`/`waitUntil`-style detached execution so request latency and error surface don't leak account existence (enumeration resistance, Q90); delivery failures are logged events, not auth errors.
3. No templates in core: accept per-purpose hooks (`sendVerificationEmail`) exactly like better-auth; the built-in OAuth/verification plugins only produce typed *intents*.
4. SMS: same capability shape, `Sms` tag, phase 2 (EmailOTP/2FA plugins); nothing in OAuth v1 needs it.
5. OAuth-specific rule: `requireEmailVerification` per provider requires the `Mailer` capability at compile time (plugin-dependency validation, PRD §5.1) — that turns "we silently can't deliver to placeholder emails" into a startup error.

```ts
class Mailer extends Context.Tag("auth/Mailer")<Mailer, {
  readonly send: (msg: EmailMessage | VerificationEmail) => Effect<void, DeliveryError>
}>() {}
// VerificationEmail = { user, url, token, purpose: "verify-email" | "reset-password" |
//                       "change-email" | "delete-account" | "oauth-link-notice" }
```

The OAuth plugin consumes `Mailer` only in the verification-gated branch, so `Auth.make()` fails at compile time when `requireEmailVerification` is set without a `Mailer` layer installed — exactly the PRD §5.1 "capability over implementation" rule applied to delivery.

**Confidence:** high on the callback/no-template/never-await shape (direct convergence between better-auth and Lucia-era practice, and it matches PRD's capability model); medium on exact Effect wrapping primitive (`forkDaemon` vs scoped `Effect.into` + event bus) — implementation detail for Q13/Q28 owners.

### Q88 (OAuth slice) — Threat model: SSRF, open redirect, state/nonce

**Evidence (attack class → real incident → control).**

| Threat | Documented example | Control for effect-auth |
| --- | --- | --- |
| **SSRF via provider-controlled endpoints** | Keycloak `request_uri` unauthenticated SSRF + port scan (CVE-2020-10770); Amazon Cognito fetched attacker-set discovery endpoints (`token_endpoint: http://127.0.0.1:22`) enabling blind SSRF; Open WebUI fetched attacker-controlled avatar URLs post-OAuth (CVE-2026-54008) | Treat all provider URLs as config, never request data: discovery only from a configured `discoveryUrl`, `issuer` exact-match on the fetched document (OIDC Discovery §4.3), HTTPS-only + block link-local/loopback/private IP resolution for all provider fetches (token/userinfo/JWKS/discovery), fixed redirect limit, never fetch request-hostile content like avatar URLs server-side (store the URL, let the client load it). [Holtmann SSRF writeup](https://security.lauritz-holtmann.de/post/sso-security-ssrf/), [CVE-2026-54008](https://sec.co/vulnerabilities/cve-2026-54008) |
| **Open redirect via post-login destination** | Twenty app: OAuth callback handler redirected to attacker URL while capturing codes (CVE-2026-82274); RFC 9700: "no open redirectors" for clients and ASes | `callbackURL` validated against `trustedOrigins`/relative-only allowlist *before* the redirect is issued; default destination = same-origin `/`; never echo `redirect_uri`/`next` query params unvalidated. [CVE-2026-82274](https://www.sentinelone.com/vulnerability-database/cve-2026-82274/), [WorkOS/RFC 9700 summary](https://workos.com/blog/oauth-best-practices) |
| **CSRF / code injection via `state`** | RFC 6749 §10.12 requires `state` for CSRF; reusable-state attacks documented against real SSOs; RFC 9700: PKCE *or* one-time `state` token required | `state` = random ≥128-bit, single-use (consumed from Verification store on first callback), ≤10-min TTL, bound to the browser via the correlation cookie; PKCE S256 always (also defeats authorization-code injection because the injected code fails verifier check). [rfc6749](https://www.rfc-editor.org/rfc/rfc6749#section-10.12), [Holtmann state post](https://security.lauritz-holtmann.de/post/sso-security-state/), [rfc9700](https://www.rfc-editor.org/rfc/rfc9700) |
| **Mix-up attack** (multiple ASes, client confuses endpoints → code sent to attacker AS) | RFC 9700 requires defense; RFC 9207 `iss` is the standard countermeasure | Require/validate `iss` on authorization responses when present; per-provider redirect URIs (path embeds provider id); never share one callback across providers with different ASes without `iss` validation. [rfc9207](https://datatracker.ietf.org/doc/rfc9207/) |
| **Token/ID-token validation failures** | alg confusion & missing claim checks are the recurring JWT pitfall class (RFC 8725 BCP, being updated by `draft-ietf-oauth-rfc8725bis`); PortSwigger catalogs code-substitution/leak vectors | Pin algorithms from discovery `id_token_signing_alg_values_supported` ∩ allowlist (ES256/RS256 — never `none`/HS unless configured symmetric); verify `iss` exact, `aud` (multi-client-id arrays supported), `exp`, `nonce`; fetch JWKS only from discovery `jwks_uri` (SSRF rules above) with cache + key-id fallback refresh. [rfc8725bis](https://datatracker.ietf.org/doc/draft-ietf-oauth-rfc8725bis/), [PortSwigger hidden OAuth attack vectors](https://portswigger.net/research/hidden-oauth-attack-vectors) |
| **Code/token leakage** (Referer, logs, URL history) | RFC 9700 §4.1.3 (credential leakage via referrer); PRD §52 already requires redacting authorization codes | Codes/tokens redacted in spans/events (core redaction, PRD §52); never put codes in fragment URLs; store provider tokens hashed-or-encrypted at rest (opt-in like better-auth `encryptOAuthTokens`); access tokens never returned to the browser in cookie-session mode. [rfc9700](https://www.rfc-editor.org/rfc/rfc9700), [options reference](https://better-auth.com/docs/reference/options) |
| **Browser token theft / SPA misuse** | RFC 10017 (Aug 2026, BCP 212) documents why browser-held tokens are fragile (XSS exfiltration, noisy token storage) and recommends BFF/cookie sessions for server-backed apps | Default topology is cookie-session BFF-style; provider OAuth tokens never cross to the browser; `@effect-auth/client` exposes session state, never provider tokens. [rfc10017](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps) |
| **Refresh-token lifecycle abuse** | RFC 9700 mandates rotation for public clients; Google refresh tokens expire after 7 days while the consent screen is "Testing"; GitHub OAuth App tokens never expire vs GitHub App 8h + 6mo refresh | Single-flight refresh per account (no stampede), persist every rotation, treat `invalid_grant` as terminal (`needs_reauth` on the account — never a retry loop), emit auth events on refresh failure. [rfc9700](https://www.rfc-editor.org/rfc/rfc9700), [GitHub refresh docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [Google Testing expiry](https://developers.google.com/google-ads/api/docs/get-started/common-errors) |

Tests to land with the plugin (abuse-case suite, per Q94): callback with unknown/replayed/spoofed `state` → typed rejection; callback missing `iss` from an `iss`-validating provider → rejection; discovery doc with mismatched `issuer` or private-IP endpoints → provider registration fails closed; `callbackURL=http://evil.example` → fallback to safe destination; Apple `form_post` callback with reused code → single-use rejection; nonce mismatch on `id_token` → rejection; `mapProfile` output can never set `subject` (property test).

Two cross-cutting rules: **refresh patterns** — refresh lazily on first provider-API need (not on callback), merge incrementally-granted scopes into the stored consent set on link (better-auth behavior), and classify token-endpoint 400s: `invalid_grant` is terminal, everything else transient with a bounded retry. **Enumeration/timing** — callback failures follow Q90 rules: unknown state, expired state, and nonce mismatch all redirect with the same generic `?error=oauth_callback` (operator detail goes to logs/events only, never to the URL), and the state handle lookup compares hashes in constant time.

**Recommendation:** encode the table above as the plugin's threat-model section in docs, and gate every row with a contract test in `@effect-auth/test` so third-party providers must pass the same controls.

**Confidence:** high (each control traces to an RFC requirement or a documented CVE; tests are deterministic by construction).

---

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to effect-auth |
| --- | --- | --- | --- | --- |
| RFC 6749/6750/7636 | OAuth 2.0 framework, bearer usage, PKCE | IETF | Normative | Protocol baseline the client implements |
| RFC 9700 | OAuth 2.0 Security BCP (Jan 2025) | IETF | Current BCP | Security defaults source-of-truth |
| draft-ietf-oauth-v2-1 (-16) | OAuth 2.1 consolidation | IETF | Draft (2026-09); IESG submission targeted Dec 2026 | Target semantics; re-verify status before 1.0 |
| OIDC Core/Discovery/RFC 8414/9207 | ID-token semantics, metadata, `iss` | IETF/OpenID | Stable | Generic OIDC provider design |
| RFC 10017 | OAuth 2.0 for Browser-Based Apps (BCP 212, Aug 2026) | IETF | Current BCP | Justifies cookie/BFF default; SPA guidance for Q87 |
| RFC 8252 | OAuth 2.0 for Native Apps | IETF | Stable | Reference for future mobile/loopback flows |
| jose | JWS/JWT/JWKS toolkit (panva) | MIT | Very mature, multi-runtime | Candidate for id-token verification |
| oauth4webapi | Low-level OAuth/OIDC fetch client (panva) | MIT | Mature (Auth.js depends on it) | Reference for metadata/PAR/pkce details |
| @effect/platform `HttpClient` | Effect-native HTTP client, typed failures | MIT | Stable | Transport for all provider fetches behind the SSRF guard layer |
| Arctic (deprecated) | Per-provider OAuth clients | MIT | **Deprecated by author** (npm 3.7.0, ~828K weekly downloads) | Per-provider quirk tables; not a dependency |
| @auth/core | Auth.js engine: `OAuth2Config`, cookie state, oauth4webapi | ISC | Maintained under Better Auth | Provider-interface shape to emulate |
| better-auth | Full TS auth framework + Generic OAuth plugin | MIT | Fast-moving, dominant | Primary behavioral reference (linking, state, quirks) |
| ory/hydra | Self-hosted OAuth2/OIDC AS (no login UI) | Apache-2.0 | Mature | Generic-provider compatibility target |
| Keycloak | Full IAM, per-realm OIDC discovery | Apache-2.0 | Mature | Enterprise discovery target |
| panva/jose · openid-client | Node OIDC client + certified RPs | MIT | Mature | Prior art for JWKS caching policies |

## Books, papers, blogs, talks

- *OAuth 2 in Action* — Justin Richer & Antonio Sanso (Manning): protocol mechanics from a client/AS implementer's view. [manning.com](https://www.manning.com/books/oauth-2-in-action)
- *OAuth 2.0 Simplified* — Aaron Parecki: the clearest free primer; pairs with [oauth.com](https://www.oauth.com/) as the doc-friendly reference for user-facing docs. [oauth.com](https://www.oauth.com/)
- RFC 9700 itself, plus Daniel Fett's writing (danielfett.de; ietf.org blog posts on security BCP): the editor's own explanations of mix-up, PKCE, and BCP rationale. [danielfett.de](https://danielfett.de/)
- *OAuth 2.0 for Browser-Based Apps* — RFC 10017 (Aug 2026; editors A. Parecki (Okta), D. Waite (Ping Identity), P. De Ryck per the draft title page) together with RFC 8252: the two deployment-topology BCPs an auth library author must internalize. [datatracker](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
- Lauritz Holtmann, *Real-life OIDC Security* series (login confusion, CRLF, SSRF, reusable state, redirect schemes): the concrete "how real implementations failed" corpus for Q88 tests. [security.lauritz-holtmann.de](https://security.lauritz-holtmann.de/post/sso-security-ssrf/)
- PortSwigger Research, *Hidden OAuth attack vectors*: modern client-side attack catalog (code leakage, subdomain takeover of redirect targets). [portswigger.net/research/hidden-oauth-attack-vectors](https://portswigger.net/research/hidden-oauth-attack-vectors)
- Philippe De Ryck, Pragmatic Web Security courses: developer-grade OIDC security training; his "OIDC in Action" checklists mirror the validation order in Q54. [pragmaticwebsecurity.com](https://www.pragmaticwebsecurity.com/)
- Vittorio Bertocci, *The Nuts and Bolts of OAuth 2.0* (Udemy/free video) + his Microsoft-era blog: authority on tokens, access-token audience validation. [oauth.net featured course](https://www.udemy.com/course/oauth-2-simplified/)
- Aaron Parecki, "What's New with OAuth and OpenID Connect" (talk): what actually changed vs folklore. [youtube.com/watch?v=g_aVPdwBTfw](https://www.youtube.com/watch?v=g_aVPdwBTfw)
- pilcrowonpaper, *The Auth Book* + "I am deprecating most of my open-source NPM packages": the abstraction-layer lesson that shaped Q54. [auth.pilcrowonpaper.com](https://auth.pilcrowonpaper.com), [blog/18](https://pilcrowonpaper.com/blog/18)
- Scott Brady, *Implementing Sign in with Apple in ASP.NET Core*: the canonical write-up of Apple's no-PKCE/ES256-JWT-secret/form_post stack. [scottbrady.io](https://www.scottbrady.io/openid-connect/implementing-sign-in-with-apple-in-aspnet-core)

## People & projects to follow

- **Aaron Parecki** — oauth.com editor-in-practice, OAuth 2.0 Simplified, co-editor of PKCE-era guidance. [oauth.com](https://www.oauth.com/), [aaronparecki.com](https://aaronparecki.com/)
- **Daniel Fett** — editor of RFC 9700, OAuth 2.1, DPoP; practical attack analyses. [danielfett.de](https://danielfett.de/), [ietf datatracker](https://datatracker.ietf.org/person/danielfett%40yes.com)
- **Justin Richer** — RFC 6749/6750 co-author; *OAuth 2 in Action*. [manning](https://www.manning.com/books/oauth-2-in-action)
- **Antonio Sanso** — *OAuth 2 in Action* co-author; long history of OAuth CVE research. [github.com/asanso](https://github.com/asanso)
- **Filip Skokan (panva)** — jose, openid-client, oauth4webapi; the de-facto TS OAuth/JWT reference implementation. [github.com/panva](https://github.com/panva)
- **Philippe De Ryck** — Pragmatic Web Security; developer security education. [pragmaticwebsecurity.com](https://www.pragmaticwebsecurity.com/)
- **Vittorio Bertocci** — identity architecture, tokens/agent identity. [auth0 blog archive](https://auth0.com/blog/authors/vittorio-bertocci)
- **Dominick Baier / Duende** — IdentityServer/BFF guidance; BFF pattern advocacy relevant to Q87. [duendesoftware.com](https://duendesoftware.com/), [blog.duendesoftware.com](https://blog.duendesoftware.com/)
- **Bekacru (better-auth lead)** — better-auth's OAuth/linking decisions land fastest there. [github.com/bekacru](https://github.com/bekacru)
- **pilcrowonpaper** — Lucia/Arctic author; The Auth Book. [pilcrowonpaper.com](https://pilcrowonpaper.com/)
- **Lauritz Holtmann** — OIDC implementation-security research (SSRF/state). [security.lauritz-holtmann.de](https://security.lauritz-holtmann.de/)

## Recommended defaults for effect-auth

1. **Flow**: authorization-code + PKCE S256 only. No implicit, no ROPC, no token response mode. `state` always (≥128-bit random, single-use, 10-min TTL), `nonce` always for OIDC, validate RFC 9207 `iss` when present.
2. **Provider model**: static declarative `OAuthProvider` values compiled into an `OAuthRegistry` service at `Auth.make()` (PRD §5.3); `genericOidc({ issuer })` is the default; Google/GitHub/Apple are quirk presets; one route pair `/auth/oauth/:provider` + `/auth/oauth/:provider/callback`.
3. **Flow state** lives in core Verification (`purpose: "oauth.flow"`, payload encrypted-or-hashed per Q46 policy); browser holds only an opaque `HttpOnly; Secure; SameSite=Lax` handle cookie. Cookie-only mode ships as the DB-less fallback.
4. **Identity**: `Account.providerId + subject` unique; `subject` from `sub` (or `accountSubject` preset field); email is profile data, never the anchor; multi-client-id `aud` arrays supported for cross-platform providers.
5. **Linking**: auto-link default **off**; typed `AccountNotLinked` outcome drives "sign in then link" UX; authenticated `linkSocial` shares the same flow machinery with server-side `link` state; unlink refuses to remove the last credential unless opted out; per-provider opt-in `autoLink` + `trustedProviders` for operators who want better-auth behavior.
6. **Sign-up**: silent user creation on first OAuth sign-in, with per-provider `disableImplicitSignUp` for invite-gated apps.
7. **Token storage**: provider tokens stored server-side only; encryption-at-rest opt-in; `getAccessToken`-style helper auto-refreshes (single-flight per account) and persists rotated refresh tokens (rotation required for public clients, RFC 9700).
8. **Callback security**: `redirect_uri` derived from configured base URL; post-login destination validated against trusted origins; Apple handled via `response_mode=form_post` preset with CSRF-safe cookie binding.
9. **SSRF guard**: all provider fetches go through one `HttpClient` layer that enforces https + public-IP resolution; discovery `issuer` must exact-match config; JWKS cached with TTL and kid-miss refresh.
10. **Quirks as documented presets**: Apple (no PKCE, ES256 JWT client secret ≤6mo, `form_post`, persist name/email from first consent, nonce echo required); GitHub (`/user/emails` for private addresses, token-expiry differences OAuth App vs GitHub App); Google (Testing-mode 7-day refresh expiry, `hd`, `prompt`), Entra (`oid` anchor, untrusted email). Each preset links its doc page.
11. **Redaction**: authorization codes, access/refresh/id tokens redacted by the core observability layer (PRD §52); property-test that no provider token reaches a span/event.
12. **Mailer dependency**: `requireEmailVerification` per provider requires the `Mailer` capability at compile time; sends never block or fail the auth path (Q48).
13. **Deployment topology (SPA/BFF)**: cookie-session BFF is the enforced default per RFC 10017; provider OAuth tokens are server-side-only in every mode; bearer mode (Q82) applies to effect-auth's own API tokens, not provider tokens.

## Open questions for the user

1. **Default account-linking posture** — (a) default off + explicit link flow (recommended, Auth.js stance); (b) default on for verified emails (better-auth stance, smoother OAuth-only onboarding); (c) default on but only for providers on a curated "verified-email trustworthy" list.
2. **Silent account creation** — (a) create user on first OAuth sign-in (ecosystem norm); (b) require explicit signup step (`requestSignUp`) always; (c) config default a with plugin-level opt-out.
3. **JWT/JWKS implementation** — (a) depend on `jose` inside the oauth plugin; (b) implement minimal ES256/RS256 JWS verification in `@effect-auth/crypto` (Q89 alignment); (c) wrap `jose` behind an internal `IdTokenVerifier` capability so both are swappable.
4. **Token-at-rest encryption default** — (a) plaintext with documented `databaseHooks`-style escape hatch (better-auth default); (b) encrypt-by-default using the core secret (simpler for users, couples to key rotation).
5. **Flow-state store** — (a) always core Verification (recommended); (b) cookie-first with Verification fallback; (c) make it a strategy interface like better-auth's `storeStateStrategy` from day one.

## Sources

- https://www.rfc-editor.org/rfc/rfc6749
- https://www.rfc-editor.org/rfc/rfc7636
- https://www.rfc-editor.org/rfc/rfc9700
- https://oauth.net/2/oauth-best-practice/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/
- https://oauth.net/specs/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-security-topics-update/
- https://openid.net/specs/openid-connect-core-1_0.html
- https://openid.net/specs/openid-connect-discovery-1_0.html
- https://www.rfc-editor.org/rfc/rfc8414
- https://datatracker.ietf.org/doc/rfc9207/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-rfc8725bis/
- https://github.com/pilcrowonpaper/arctic
- https://arcticjs.dev/
- https://pilcrowonpaper.com/blog/18
- https://v3.lucia-auth.com/guides/oauth/basics
- https://authjs.dev/reference/core/providers
- https://authjs.dev/guides/configuring-oauth-providers
- https://better-auth.com/blog/authjs-joins-better-auth
- https://better-auth.com/blog/better-auth-joins-vercel
- https://better-auth.com/docs/concepts/oauth
- https://better-auth.com/docs/plugins/generic-oauth
- https://better-auth.com/docs/concepts/users-accounts
- https://better-auth.com/docs/reference/options
- https://better-auth.com/docs/reference/errors/account_not_linked
- https://workos.com/blog/oauth-best-practices
- https://security.lauritz-holtmann.de/post/sso-security-ssrf/
- https://security.lauritz-holtmann.de/post/sso-security-state/
- https://portswigger.net/research/hidden-oauth-attack-vectors
- https://www.sentinelone.com/vulnerability-database/cve-2026-82274/
- https://sec.co/vulnerabilities/cve-2026-54008
- https://www.scottbrady.io/openid-connect/implementing-sign-in-with-apple-in-aspnet-core
- https://developer.apple.com/documentation/signinwithapple/verifying-a-user
- https://docs.github.com/en/rest/users/emails
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation
- https://developers.google.com/google-ads/api/docs/get-started/common-errors
- https://www.keycloak.org/documentation
- https://www.ory.sh/hydra/docs/
- https://www.manning.com/books/oauth-2-in-action
- https://www.oauth.com/
- https://www.pragmaticwebsecurity.com/
- https://duendesoftware.com/
- https://github.com/panva/oauth4webapi
- https://github.com/panva/jose
- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps
- https://www.rfc-editor.org/info/rfc8252/
- https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
- https://www.npmjs.com/package/arctic
