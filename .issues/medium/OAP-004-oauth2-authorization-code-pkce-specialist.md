---
ID: "OAP-004"
Title: "JWKS/token/userinfo responses consumed via unchecked casts; malformed JWKS crashes callback as a defect"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-004 — JWKS/token/userinfo responses consumed via unchecked casts; malformed JWKS crashes callback as a defect

`MEDIUM` · `security` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **resolved**

## Summary

The fetched discovery/JWKS/userinfo/token JSON bodies are blind casts: the JWKS body here, the token response at OAuth.ts:211, and userinfo at OAuth.ts:607. The sharp edge is Jwt.findKey (Jwt.ts:97), which eagerly evaluates jwks.keys.filter(...) when invoked inside verifyIdToken's Effect.gen; a JWKS document whose JSON is an object without a keys array (or an array/string) throws a TypeError, which propagates as a defect - an unhandled 500-class crash of the callback - instead of the typed OAuthCallbackFailed every other malformed-input path returns. A provider glitch, captive portal, or hostile jwksUri endpoint thereby converts a validation failure into an availability event. The newer packages/jwt/src/verify.ts explicitly models JWKs as Records with typeof narrowing and its header names this file as the anti-pattern to avoid.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Decode the JWKS with Schema (keys: array of structs with kid/kty/n/e) and map decode failure to OAuthCallbackFailed; make findKey accept Record<string, unknown> and fail with JwtVerificationError when keys is absent; wrap the token/userinfo bodies the same way.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-response-decoding`. Duplicate of `ESS-003-effect-schema-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:323`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ESS-003-effect-schema-specialist` — closed by its fix (see that issue's Resolved comment).
