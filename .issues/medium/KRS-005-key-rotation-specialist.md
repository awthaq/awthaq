---
ID: "KRS-005"
Title: "Provider JWKS response type-cast without any schema validation"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-005 — Provider JWKS response type-cast without any schema validation

`MEDIUM` · `security` · `oauth` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

The JWKS document fetched from an external provider over HTTP is cast wholesale to Jwt.Jwks with no shape validation; kty/kid/n/e are then read off unvalidated JSON to import verification keys. The repo's own newer convention (packages/jwt/src/verify.ts decodes JWKS via Schema.decodeUnknownEffect precisely because this data is untrusted wire input, and its header explicitly calls out this file as the anti-pattern) is not applied here. A malformed or hostile JWKS response becomes whatever shape the caster asserts rather than a clean typed failure.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Decode the JWKS response with a Schema (as verify.ts's JwksDocumentSchema does) and fail the callback with OAuthCallbackFailed on shape mismatch instead of casting.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

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
