---
ID: "JJS-005"
Title: "Untrusted JWKS, discovery, and token-exchange JSON flows through unvalidated type casts"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-005 — Untrusted JWKS, discovery, and token-exchange JSON flows through unvalidated type casts

`MEDIUM` · `security` · `oauth` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **resolved**

## Summary

The provider JWKS response is asserted, not decoded (OAuth.ts:248); the same pattern applies to the id_token header (packages/oauth/src/Jwt.ts:63, decodeJson(...) as DecodedJwt["header"]), the token-exchange body (OAuth.ts:211), and the discovery document (OAuthProvider.ts:142). This violates the repo's own established Schema.decodeUnknownEffect convention for untrusted wire data — packages/jwt/src/verify.ts:14-21 explicitly names this file as the anti-pattern — and it lets malformed shapes reach findKey, whose kty === 'RSA' || kty === undefined filter even admits kty-less entries. WebCrypto importKey ultimately rejects unusable keys so the path fails closed, but error attribution is lost and any future logic reading asserted fields inherits the lie.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
      Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Replace the four casts with Schema-decoded structs (keys array of Record(String, Unknown), then the same typeof narrowing verify.ts uses), matching the lite verifier's precedent.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-response-decoding`. Duplicate of `ESS-003-effect-schema-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:323`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ESS-003-effect-schema-specialist` — closed by its fix (see that issue's Resolved comment).
