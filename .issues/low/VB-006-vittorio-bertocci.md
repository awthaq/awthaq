---
ID: "VB-006"
Title: "id_token validation omits azp, at_hash, and iat/nbf bounds; array-form aud unsupported"
Level: low
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:272"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-006 — id_token validation omits azp, at_hash, and iat/nbf bounds; array-form aud unsupported

`LOW` · `security` · `oauth` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

The minimal RS256 verifier checks signature, iss, aud, exp, and nonce (always enforced for oidc flows) but never azp, never binds the access token via at_hash, and puts no iat/nbf bounds on acceptance. Strict single-string aud equality also means providers that lawfully emit aud as an array are unconditionally rejected — a fail-closed interop gap rather than a vulnerability. The scope is honestly documented in packages/oauth/src/Jwt.ts:5-14 as the minimal-internal-verifier answer to research Q54, but the omissions should be recorded in the plugin surface, not just its header comment.

## Evidence

Source: `packages/oauth/src/OAuth.ts:272`

```
claims["aud"] !== provider.clientId ||
      exp === undefined ||
      Date.now() >= exp * 1000 ||
```

## Recommended fix

Handle array-form aud by membership check (with azp required when aud has multiple values); add iat sanity bounds; consider at_hash when an access token is retained.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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
