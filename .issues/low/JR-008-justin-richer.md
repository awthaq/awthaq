---
ID: "JR-008"
Title: "aud claim validated by strict string equality in both verifiers; array audiences rejected, azp never checked"
Level: low
Category: "compliance"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:272"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-008 — aud claim validated by strict string equality in both verifiers; array audiences rejected, azp never checked

`LOW` · `compliance` · `oauth` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

RFC 7519 §4.1.3 allows aud to be an array of case-sensitive strings, and OIDC Core §3.1.3.7 step 4 requires only that the client_id be IN the aud list (with azp required when aud is multi-valued). Both verifiers (OAuth.ts:272 and packages/jwt/src/JwtCodec.ts:242 `payload["aud"] !== params.audience`) reject any array outright. This is fail-closed and harmless for single-audience IdPs and first-party minted tokens (aud is always the config string), but a legitimate multi-audience id_token from an enterprise IdP fails verification with the undifferentiated callback error — an interop failure that is hard to diagnose.

## Evidence

Source: `packages/oauth/src/OAuth.ts:272`

```
claims["iss"] !== expectedIssuer ||
      claims["aud"] !== provider.clientId ||
      exp === undefined ||
```

## Recommended fix

Accept string-or-array aud, requiring membership of the expected audience; when an array with multiple values is accepted for OIDC, verify azp equals the client id per OIDC Core.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
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
