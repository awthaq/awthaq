---
ID: "OIT-003"
Title: "azp never validated and array-valued aud rejected outright"
Level: medium
Category: "compliance"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:272"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-003 — azp never validated and array-valued aud rejected outright

`MEDIUM` · `compliance` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **ready-for-agent**

## Summary

The aud check is strict string equality against clientId. OIDC Core 3.1.3.7 requires that when aud is an array with more than one value (common at providers that serve multiple audiences), the client check that azp equals client_id; when azp is present at all, the client SHOULD verify it matches. This code does neither: azp is never read anywhere in the package (grep for azp/at_hash/auth_time returns zero matches), so a token whose azp names a different relying party is accepted as long as aud equals our clientId, and conversely single-audience arrays (['client-id']) are rejected, breaking interop with providers that always emit arrays.

## Evidence

Source: `packages/oauth/src/OAuth.ts:272`

```
claims["aud"] !== provider.clientId ||
```

## Recommended fix

Normalize aud: if it is a string, compare directly; if an array, require it to contain clientId. Then enforce azp === clientId whenever azp is present or whenever the aud array holds more than one value, failing with OAuthCallbackFailed otherwise.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: OIDC id_token validation
- Full dossier: [`oidc-id-token-specialist`](../../.reports/oidc-id-token-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 7 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:356`. Fix: Accept aud as a string or an array containing clientId. Require azp === clientId when aud has more than one value, and whenever azp is present. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
