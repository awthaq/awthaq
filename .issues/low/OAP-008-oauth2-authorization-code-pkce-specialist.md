---
ID: "OAP-008"
Title: "authorize endpoint is unthrottled while callback is rate-limited: unauthenticated Verification-row and crypto amplification"
Level: low
Category: "security"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:434"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-008 — authorize endpoint is unthrottled while callback is rate-limited: unauthenticated Verification-row and crypto amplification

`LOW` · `security` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **ready-for-agent**

## Summary

Only the callback endpoint gets a RateLimits rule (OAuth.ts:433-441, wired into the same registry the callback handler consumes at OAuth.ts:507-518); the authorize error list (OAuthApi.ts:91) has no Api.RateLimited and the handler calls no limiter. Each authorize invocation generates PKCE material, a UUIDv7, two Encryption envelopes, and persists a Verification flow row with a 10-minute TTL - so an unauthenticated flood both consumes CPU and fills the shared Verification store at zero cost of completing any flow. The infra for IP-keyed limiting already exists one endpoint away, making this an inconsistency rather than a missing capability.

## Evidence

Source: `packages/oauth/src/OAuth.ts:434`

```
        rateLimitsRegistry.register(OAuth, {
          group: "oauth",
          endpoint: "callback",
```

## Recommended fix

Register a second, looser rule for endpoint 'authorize' (e.g. 30/min per IP) and consume it at the top of the authorize handler, mapping RateLimited to Api.RateLimited in the contract's error list.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: OAuth2 OIDC flows
- Full dossier: [`oauth2-authorization-code-pkce-specialist`](../../.reports/oauth2-authorization-code-pkce-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-callback-http-hardening`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:537`. Fix: Register and enforce a looser per-IP rule on authorize. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
