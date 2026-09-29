---
ID: "AP-006"
Title: "Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored"
Level: medium
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:206"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-006 — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored

`MEDIUM` · `api` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

exchangeCode authenticates exclusively by placing client_id/client_secret in the request body (client_secret_post). RFC 6749 2.3.1 permits that only when the authorization server supports it; confidential clients default to HTTP Basic (client_secret_basic), and a meaningful set of enterprise IdPs advertise token_endpoint_auth_methods_supported: ["client_secret_basic"] only. The discovery document parser (OAuthProvider.ts:100-106) does not even read token_endpoint_auth_methods_supported, so such providers fail at token exchange at runtime rather than at the fail-closed boot check the plugin otherwise prides itself on. Nothing surfaces the mismatch to the deployer.

## Evidence

Source: `packages/oauth/src/OAuth.ts:206`

```
if (Option.isSome(provider.clientSecret)) {
      form["client_secret"] = Redacted.value(provider.clientSecret.value);
    }
```

## Recommended fix

Read token_endpoint_auth_methods_supported during resolve; default to basic when advertised, support posting the credentials via an Authorization: Basic header in exchangeCode, and die at boot with a clear message when the configured/advertised method is unsupported.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- [`ACS-004` — JWKS response cast unvalidated before becoming key material](medium/ACS-004-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-token-endpoint-client-auth`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:244`. Fix: Support client_secret_basic (the RFC 6749 §2.3.1 default) and client_secret_post, selected from config or discovery, validated at boot. (effort M). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New TokenEndpoint.ts (formUrlEncode + clientAuthentication) used by both OAuth.exchangeCode and OAuthTokenAccess.refresh; OAuthProviderConfig.tokenEndpointAuthMethod ('client_secret_basic' | 'client_secret_post' | 'none'), ResolvedProvider.tokenEndpointAuthMethod, discovery schema reads token_endpoint_auth_methods_supported. resolve picks: explicit config, else none without a secret, else basic (advertised or list absent), else post, else dies at boot; also dies for explicit method not advertised, secret method without secret, none with secret. Basic = Authorization: Basic base64(formUrlEncode(id):formUrlEncode(secret)) with no client_secret in the body (RFC 6749 2.3.1). Behaviour change: explicit-endpoint confidential providers now default to basic (was post); providers that need the secret in the body (e.g. Apple) set tokenEndpointAuthMethod: 'client_secret_post' -- IC-003's presets should do so. Tests (OAuth.test.ts 'token endpoint client authentication' + OAuthTokenAccess refresh): basic-only, post-only, default basic, explicit overrides discovery, reserved-char encoding, boot failures, public client; red before (no such config / always post). BEH-EA-126 amended. Gates: tsc -b, tsconfig.test.json, vitest 899 pass, test:bdd 106, spec:verify:strict, oxlint.
