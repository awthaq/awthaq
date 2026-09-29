---
ID: "VB-004"
Title: "Provider JWKS response trusted via unvalidated cast"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-004 — Provider JWKS response trusted via unvalidated cast

`MEDIUM` · `security` · `oauth` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

The fetched JWKS document enters the trust chain as body as unknown as Jwt.Jwks with no schema validation — the exact raw-cast anti-pattern this codebase's own newer modules document and forbid for untrusted wire data (packages/jwt/src/JwtCodec.ts:14-21, packages/jwt/src/verify.ts:14-21, which decode the same document shape via Schema). A provider returning JSON without a keys array makes findKey throw a TypeError (jwks.keys.filter on undefined), surfacing as a defect/500 instead of the typed OAuthCallbackFailed, and any future shape drift is silently accepted.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Decode the JWKS document with a Schema (as packages/jwt/src/verify.ts already does) and map failures to OAuthCallbackFailed.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `oauth-provider-response-decoding`. Already fixed by commit e364411. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:323`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
