# P02 — OAuth / OIDC flow hardening

Phase 1 · 35 open issues to fix (3 high, 21 medium, 10 low, 1 info) · 36 closed by validation · ~64h summed per-issue estimate (upper bound) · 4 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `oauth-oidc-claims-integrity` — OIDC id_token and userinfo claim validation

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~11h · depends on workstreams: `oauth-provider-response-decoding`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [OIT-001](../slices/03-oauth-flow.md) | high | security | CONFIRMED | M | ESS-003 | For oidc providers, fail when userinfo.sub differs from the verified id_token sub, and let the signed id_token win for identity-bearing claims (sub, email, email_verified). userinfo only enriches the profile. |
| [MA-002](../slices/03-oauth-flow.md) | medium | correctness | CONFIRMED | S | — | Read time once per verification from the Effect Clock and use it for exp/iat/nbf and the JWKS cache age. |
| [OIT-003](../slices/03-oauth-flow.md) | medium | compliance | CONFIRMED | S | — | Accept aud as a string or an array containing clientId. Require azp === clientId when aud has more than one value, and whenever azp is present. |
| [OIT-004](../slices/03-oauth-flow.md) | medium | correctness | CONFIRMED | S | MA-002 | Add a configurable clock-skew leeway and validate iat/nbf. |
| [OIT-006](../slices/03-oauth-flow.md) | low | security | CONFIRMED | S | — | Make the nonce mandatory for oidc verification, and schema-decode the flow payload instead of the cast-based guard. |
| [OIT-008](../slices/03-oauth-flow.md) | low | dx | CONFIRMED | S | — | Keep the wire error opaque, and carry a discriminated internal reason for logs and spans. |
| [OIT-009](../slices/03-oauth-flow.md) | low | testing | PARTIAL | S | OIT-001, OIT-003 | Add the remaining negative scenarios. Most arrive as the red-first tests of OIT-001 and OIT-003, and alg confusion is added standalone. |
| [OIT-007](../slices/03-oauth-flow.md) | info | compliance | CONFIRMED | S | — | Document the at_hash/auth_time/max_age deferral next to the existing RS256 deferral, and pin response_type=code structurally. |

Closed by validation in this workstream: AP-004 (DUPLICATE → OIT-001), APS-008 (DUPLICATE → OIT-001), AOMS-004 (DUPLICATE → OIT-003), AP-003 (DUPLICATE → OIT-003), JJS-006 (DUPLICATE → OIT-003), JR-008 (DUPLICATE → OIT-003), OAP-006 (DUPLICATE → OIT-003), VB-006 (DUPLICATE → OIT-003), SFS-005 (WONTFIX-CANDIDATE)

## `oauth-provider-boot-validation` — Validate OAuth provider configuration at boot

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~3h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESS-002](../slices/04-oauth-provider-jwt.md) | high | correctness | CONFIRMED | S | — | Decode the discovery document with a Schema at boot; a shape error dies with a message naming provider and field. |
| [OAP-005](../slices/04-oauth-provider-jwt.md) | medium | security | CONFIRMED | S | — | Gate `quirks.skipPkce` to confidential clients at boot and log whenever it is used. |
| [JR-009](../slices/04-oauth-provider-jwt.md) | low | dx | CONFIRMED | S | — | Die at boot when an `oidc` provider's scopes omit `openid`. |

Closed by validation in this workstream: TTE-003 (DUPLICATE → ESS-002-effect-schema-specialist), AH-003-anders-hejlsberg (DUPLICATE → ESS-002-effect-schema-specialist), AP-007 (DUPLICATE → OAP-005)

## `oauth-outbound-resilience` — Deadlines, retries and a 503 channel for provider calls

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~10h · depends on workstreams: `oauth-provider-response-decoding`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ECF-001](../slices/03-oauth-flow.md) | high | correctness | CONFIRMED | M | — | Give every outbound provider call a policy deadline, configurable per call class, and map a timeout into the typed failure channel. |
| [EEM-004](../slices/03-oauth-flow.md) | medium | api | CONFIRMED | S | ECF-001 | Add ProviderUnavailable (503) for transport, timeout and 5xx failures of the token/JWKS/userinfo endpoints. Keep OAuthCallbackFailed (400) for protocol rejections. |
| [ERS-003](../slices/03-oauth-flow.md) | medium | architecture | CONFIRMED | S | ECF-001 | Retry only idempotent GETs (JWKS, discovery, userinfo) with jittered exponential backoff inside the deadline. Never retry the single-use code exchange. |
| [NAM-004](../slices/03-oauth-flow.md) | medium | correctness | CONFIRMED ⚖️ decision | M | ERS-003 | Split 'misconfigured' (boot die) from 'unreachable' (retry, then optionally lazy), and share one provider registry. |

## `oauth-callback-http-hardening` — Callback/authorize HTTP-level hardening

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~8h · depends on workstreams: `shared-constant-time-compare`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSS-004](../slices/03-oauth-flow.md) | medium | testing | PARTIAL | S | — | Add a shared Set-Cookie attribute assertion helper and apply it to every OAuth-emitted cookie. |
| [PDR-004](../slices/03-oauth-flow.md) | medium | security | CONFIRMED | M | — | Set `Referrer-Policy: no-referrer` on the OAuth authorize and callback responses, and ship an opt-in security-headers middleware plus a deployment checklist. |
| [TSS-003](../slices/03-oauth-flow.md) | medium | security | CONFIRMED | S | — | Compare cookieState and state in constant time over fixed-length digests, using a shared helper. |
| [CSS-006](../slices/03-oauth-flow.md) | low | security | CONFIRMED | S | — | Expire __Host-oauth-state on every callback response: success, link, and typed failure. |
| [OAP-008](../slices/03-oauth-flow.md) | low | security | CONFIRMED | S | — | Register and enforce a looser per-IP rule on authorize. |

Closed by validation in this workstream: RBS-008 (ALREADY-FIXED)

## `oauth-account-linking-policy` — Account-linking trust decisions and AccountExists accuracy

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~5h · depends on workstreams: `oauth-oidc-claims-integrity`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AOMS-007](../slices/03-oauth-flow.md) | medium | correctness | CONFIRMED | S | TMS-007 | When a trusted provider asserts email_verified at first (JIT) creation, mark the new local user verified inside the same transaction. |
| [FAMS-006](../slices/03-oauth-flow.md) | medium | correctness | PARTIAL | S | — | Document the exact federated-identity import recipe now. Defer the dry-run tool to the CLI import work. |
| [NAM-005](../slices/03-oauth-flow.md) | medium | security | PARTIAL | S | — | Document the Auth.js to awthaq linking mapping. |
| [TMS-007](../slices/03-oauth-flow.md) | medium | security | PARTIAL | S | — | Auto-link only into a local account whose email is already verified. Otherwise answer AccountExists, as the explicit path does. |
| [NAM-006](../slices/03-oauth-flow.md) | low | correctness | CONFIRMED ⚖️ decision | S | — | Report the actually-linked providers (or nothing), never a hardcoded 'password'. |

Closed by validation in this workstream: EEM-007 (DUPLICATE → NAM-006), BAM-011 (WONTFIX-CANDIDATE)

## `oauth-provider-response-decoding` — Schema-decode every provider response in packages/oauth

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ACS-004](../slices/03-oauth-flow.md) | medium | security | PARTIAL | S | — | Tighten key selection. Decode RSA JWKs structurally and stop admitting kty-less entries. |
| [ESS-003-effect-schema-specialist](../slices/03-oauth-flow.md) | medium | correctness | CONFIRMED | S | — | Decode token-endpoint and userinfo responses with Schema at the boundary, shared by OAuth.ts and OAuthTokenAccess.ts, and delete the casts. |

Closed by validation in this workstream: JJS-005 (DUPLICATE → ESS-003-effect-schema-specialist), OAP-004 (DUPLICATE → ESS-003-effect-schema-specialist), OIT-005 (DUPLICATE → ESS-003-effect-schema-specialist), JR-010 (DUPLICATE → ESS-002), AP-008 (DUPLICATE → ESS-002), MA-006 (DUPLICATE → ESS-005-effect-schema-specialist), AH-002 (ALREADY-FIXED), KRS-005 (ALREADY-FIXED), VB-004 (ALREADY-FIXED), AOMS-010 (ALREADY-FIXED), OAP-007 (ALREADY-FIXED)

## `oauth-provider-presets` — OAuth vendor presets and friendlier provider config

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~13h · depends on workstreams: `oauth-provider-boot-validation`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [IC-003](../slices/04-oauth-provider-jwt.md) | medium | dx | CONFIRMED ⚖️ decision | L | ESS-002-effect-schema-specialist, OAP-005 | Ship data-only vendor presets built on `oidc`/`oauth2` (zero new mechanism) in an `@awthaq/oauth/presets` subpath, plus an Auth.js provider-id → preset mapping table. |
| [BO-009](../slices/04-oauth-provider-jwt.md) | low | dx | PARTIAL | S | — | Accept `string / Config.Config<string>` for non-secret provider fields (issuer, discoveryUrl, clientId); keep clientSecret Config.Redacted-only per BEH-EA-126; presets tracked by IC-003. |

Closed by validation in this workstream: NAM-003 (DUPLICATE → IC-003), MW-010 (DUPLICATE → IC-003)

## `oauth-callback-error-contract` — RFC 6749 §4.1.2.1 error responses at the callback

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~1h · depends on workstreams: `oauth-oidc-claims-integrity`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AP-005](../slices/03-oauth-flow.md) | medium | compliance | CONFIRMED ⚖️ decision | S | — | Model RFC 6749 §4.1.2.1 error responses in the callback contract and fold them into the handler's own validated failure path. |

Closed by validation in this workstream: JR-003 (DUPLICATE → AP-005), OAP-003 (DUPLICATE → AP-005)

## `oauth-token-endpoint-client-auth` — client_secret_basic support and discovery-driven auth method

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~4h · depends on workstreams: `oauth-provider-response-decoding`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AP-006](../slices/03-oauth-flow.md) | medium | api | CONFIRMED | M | ESS-002 | Support client_secret_basic (the RFC 6749 §2.3.1 default) and client_secret_post, selected from config or discovery, validated at boot. |

## `persistence-colocation-invariant` — Document the users/accounts transaction-domain invariant

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DRS-006](../slices/03-oauth-flow.md) | medium | correctness | PARTIAL | S | — | Write the colocation invariant into the spec. No runtime assertion (that would be speculative infra). |

## `provider-token-storage` — Remaining provider-token persistence gap (id_token)

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BAM-008](../slices/03-oauth-flow.md) | medium | api | PARTIAL | M | — | Persist the provider's id_token (encrypted at rest, like access/refresh tokens) as part of ProviderTokenSet so better-auth account imports have a destination and a future RP-initiated logout can send id_token_hint. |

Closed by validation in this workstream: NAM-008 (ALREADY-FIXED), RRS-007 (ALREADY-FIXED)

## `oauth-config-safety` — Required baseUrl and operational docs

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AGA-005](../slices/03-oauth-flow.md) | low | correctness | CONFIRMED | S | PDR-005 | Document that baseUrl must be the public scheme+host. The boot validation arrives with PDR-005. |
| [PDR-005](../slices/03-oauth-flow.md) | low | security | PARTIAL | S | — | Make baseUrl required (JwtConfig's precedent) and validate it at boot. |

