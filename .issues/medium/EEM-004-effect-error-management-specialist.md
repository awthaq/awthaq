---
ID: "EEM-004"
Title: "OAuth provider transport failures collapse into the same 400 OAuthCallbackFailed as caller errors"
Level: medium
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:219"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-004 — OAuth provider transport failures collapse into the same 400 OAuthCallbackFailed as caller errors

`MEDIUM` · `api` · `oauth` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **resolved**

## Summary

The token-exchange HTTP call (line 219), JWKS fetch (line 250), and userinfo fetch (line 608) each catch every failure into OAuthCallbackFailed (400). This is the persona's canonical mis-case: 'provider unreachable' is a retryable upstream condition that deserves a 503-class typed error, while a bad code/state/nonce is a non-retryable caller condition deserving 400. As typed, clients cannot distinguish 'restart the flow' from 'try again in a moment', and monitoring cannot separate provider incidents from attack traffic. The field-less OAuthCallbackFailed is excellent anti-leak design — the gap is granularity, not secrecy.

## Evidence

Source: `packages/oauth/src/OAuth.ts:219`

```
}).pipe(Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())));
```

## Recommended fix

Add a ProviderUnavailable Schema.TaggedError (httpApiStatus 503, empty payload) for transport-level failures of the token/JWKS/userinfo endpoints, keeping OAuthCallbackFailed (400) for protocol-level rejections only.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-outbound-resilience`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:269`. Fix: Add ProviderUnavailable (503) for transport, timeout and 5xx failures of the token/JWKS/userinfo endpoints. Keep OAuthCallbackFailed (400) for protocol rejections. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New OAuthApi.ProviderUnavailable (503, field-less) on authorize+callback; ProviderHttp.decodeBody sorts status (5xx/429 -> ProviderServerError, other non-2xx -> ProviderRejectedError) and ProviderHttp.toCallbackFailure maps transport/timeout/5xx to 503 and protocol/decode failures to 400. Also fixes a latent hole: a userinfo 401 JSON body is no longer accepted as a claim set. Tests: AuthHttp.test.ts 'token endpoint answering 503 yields HTTP 503' (red: was 400) and 'invalid_grant still 400'; OAuth.test.ts 503/400/userinfo-401/JWKS-503 domain tests. BEH-EA-122 amended. OAuthTokenAccess keeps a single OAuthRefreshFailed (the optional OAuthProviderUnavailable split was not done). Gates as ECF-001.
