---
ID: "OIT-004"
Title: "Expiry check has zero clock-skew leeway and iat/nbf are never validated"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:274"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-004 — Expiry check has zero clock-skew leeway and iat/nbf are never validated

`MEDIUM` · `correctness` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **ready-for-agent**

## Summary

exp is compared against Date.now() with no tolerance, while OIDC Core 2 explicitly discusses granting a small leeway (a few minutes) to absorb clock skew between the relying party and the issuer. Even tens of seconds of drift between the app server and the provider intermittently rejects fresh, valid tokens at exactly the busiest code path (login). Additionally iat and nbf are never checked (zero grep matches): OIDC Core lists iat validation among the SHOULDs, and without it a long-past-dated but unexpired token (or a provider that backdates iat) is accepted uncritically.

## Evidence

Source: `packages/oauth/src/OAuth.ts:274`

```
Date.now() >= exp * 1000 ||
```

## Recommended fix

Introduce a leeway constant (60s is a common choice) applied to both exp (and nbf if checked), and validate iat is a number not more than the leeway in the future. Optionally cap token age (now - iat) for defense in depth.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:356`. Fix: Add a configurable clock-skew leeway and validate iat/nbf. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
