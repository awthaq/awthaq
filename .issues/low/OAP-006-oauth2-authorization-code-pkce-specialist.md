---
ID: "OAP-006"
Title: "id_token aud compared as exact string; array-form aud (OIDC-legal) always fails validation"
Level: low
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:272"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-006 — id_token aud compared as exact string; array-form aud (OIDC-legal) always fails validation

`LOW` · `correctness` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **resolved**

## Summary

OIDC Core section 3.1.3.7 allows aud to be a JSON array (required whenever the token has multiple audiences, e.g. Entra ID or Auth0 with third-party audiences). The strict !== comparison rejects any array-form aud, so such providers fail closed with OAuthCallbackFailed despite a valid token, and there is no azp check path for the multi-audience case. Fail-closed, so no security exposure, but a silent compatibility cliff for exactly the enterprise IdPs the discovery/exact-issuer-match machinery targets.

## Evidence

Source: `packages/oauth/src/OAuth.ts:272`

```
      claims["iss"] !== expectedIssuer ||
      claims["aud"] !== provider.clientId ||
```

## Recommended fix

Normalize aud to an array, require it to contain clientId, and when it has more than one entry also require claims.azp === clientId per OIDC Core sections 3.1.3.7 and 3.2.2.11.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-oidc-claims-integrity`. Duplicate of `OIT-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:356`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `OIT-003-oidc-id-token-specialist` — closed by its fix (see that issue's Resolved comment).
