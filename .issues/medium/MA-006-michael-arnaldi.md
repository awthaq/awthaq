---
ID: "MA-006"
Title: "Type assertions cross trust boundaries: unvalidated JWKS cast contradicts the repo's own no-as rule"
Level: medium
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:247"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-006 — Type assertions cross trust boundaries: unvalidated JWKS cast contradicts the repo's own no-as rule

`MEDIUM` · `api` · `oauth` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **resolved**

## Summary

A JWKS document fetched over the network from a configured provider is cast to Jwt.Jwks with as unknown as and cached — no Schema.decodeUnknown at the boundary, in a codebase that otherwise uses Schema for every wire shape. A malformed or hostile JWKS (wrong key types, missing n/e) surfaces later as whatever Jwt.findKey/verifyRsById happen to do with undefined fields rather than a typed boundary error, and the cast is cached on success-path without validation. The same file's own ecosystem acknowledges the rule this violates: jwt/src/verify.ts:18 explicitly calls this line out as predating the convention and 'not the pattern to copy'. Password.ts repeats the discipline lapse internally: three rate-limit rules cast `(input as { readonly email: string }).email` (lines 397/402/408) while the file's own header (lines 132-134) states 'this repo forbids as/as unknown as/as any in library source' and ships emailFromRateLimitInput as the narrowing alternative — used by exactly one of the four rules that need it.

## Evidence

Source: `packages/oauth/src/OAuth.ts:247`

```
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as unknown as Jwt.Jwks),
      Effect.tap((jwks) => Ref.update(jwksCache, (cache) => HashMap.set(cache, provider.id, jwks))),
```

## Recommended fix

Decode JWKS with Schema (keys: array of Jwk schema with kid/alg/kty/n/e validation) at fetch time so a bad key set fails as OAuthCallbackFailed at the boundary; replace the three Password.ts casts with the existing emailFromRateLimitInput helper.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-response-decoding`. Duplicate of `ESS-005-effect-schema-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:323`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ESS-005-effect-schema-specialist` — closed by its fix (see that issue's Resolved comment).
