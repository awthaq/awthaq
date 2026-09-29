---
ID: "AVS-007"
Title: "Token minting declared as GET with an action-verb id, breaking the POST-for-actions convention"
Level: low
Category: "api"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/JwtApi.ts:45"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-007 — Token minting declared as GET with an action-verb id, breaking the POST-for-actions convention

`LOW` · `api` · `jwt` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

Every other state-changing or action-shaped endpoint in the monorepo is a POST (signOut, revoke, impersonate, invite, setActive — 24 of them by direct count); `mint` is the sole GET. Even if minting is a pure derivation, the id is an action verb and the operation issues fresh credentials, which pulls against GET's cacheability and log-visibility semantics and against the codebase's own otherwise-uniform verb discipline. Inconsistency here is cheap to fix now and expensive after clients generate `get` accessors for it.

## Evidence

Source: `packages/jwt/src/JwtApi.ts:45`

```
HttpApiEndpoint.get("mint", "/jwt/token", {
  success: TokenResponse,
})
```

## Recommended fix

Either keep GET and rename the id/shape to a read (`getToken`, `currentToken`), or move to `POST /jwt/token` matching every other action endpoint. Decide before first publish; the contract type change is free now.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-005` — jwt package states a middleware convention that password's own contract violates](medium/AVS-005-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `plugin-api-surface-conventions`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtApi.ts:64`. Fix: Make token minting `POST /jwt/token`. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** JwtApi.ts: mint is now HttpApiEndpoint.post('/jwt/token') (no payload). Tests (red first: 5 failing with the endpoint flipped back): POST requires auth, GET /jwt/token is 404, POST mints a token verifiable against /jwt/jwks, introspect flows now mint via POST. Docs: jwt README, Jwt.ts/JwtConfig.ts/verify.ts comments, spec/models/08-jwt-bearer.md. Decision: CsrfProtection deliberately NOT attached to the jwt.token group (mint signs a token and changes no state, response is unreadable cross-origin with no default CORS; introspect was already an unprotected POST) — the test-file comment records that; revisit with the wayfinder-24 CSRF attachment if the jwt group is ever given it. Bearer requests are CSRF-exempt anyway.
