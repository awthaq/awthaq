---
ID: "AP-003"
Title: "id_token aud accepted only as an exact string; array-form audiences rejected"
Level: medium
Category: "compliance"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:272"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-003 — id_token aud accepted only as an exact string; array-form audiences rejected

`MEDIUM` · `compliance` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

OIDC Core 3.1.3.7 permits aud to be an array of strings (required to contain the client_id, with azp mandatory and equal to client_id when more than one audience is present). The strict !== string comparison rejects any provider that emits aud as an array — the correct, spec-legal encoding whenever multiple audiences are granted — so sign-in fails against such providers even though the token is perfectly valid. There is also no azp check for the multi-audience case.

## Evidence

Source: `packages/oauth/src/OAuth.ts:272`

```
claims["iss"] !== expectedIssuer ||
      claims["aud"] !== provider.clientId ||
      exp === undefined ||
```

## Recommended fix

Normalize aud to an array, verify it contains provider.clientId, and when it has more than one element require claims.azp === provider.clientId (OIDC Core 3.1.3.7 points 3 and 8).

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- [`ACS-004` — JWKS response cast unvalidated before becoming key material](medium/ACS-004-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-oidc-claims-integrity`. Duplicate of `OIT-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:356`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `OIT-003-oidc-id-token-specialist` — closed by its fix (see that issue's Resolved comment).
