---
ID: "KRS-010"
Title: "Lite verifier's JWKS cache never expires keys and the served JWKS sets no caching guidance"
Level: low
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/verify.ts:93"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-010 — Lite verifier's JWKS cache never expires keys and the served JWKS sets no caching guidance

`LOW` · `security` · `jwt` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

makeVerifier fetches the JWKS document once and refetches only when a token names an unknown kid — there is no TTL or periodic refresh, so a key removed from the JWKS document (rotation retirement, or revocation after compromise) remains trusted by the consumer indefinitely. Symmetrically, the server's /jwt/jwks endpoint returns the document with no cache-control/max-age headers, giving downstream caches nothing to size their refresh intervals against. The combination unbounds how long retirement propagates, which is exactly the window a rotation runbook needs to bound.

## Evidence

Source: `packages/jwt/src/verify.ts:93`

```
const currentKeys = Ref.get(cache).pipe(
  Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => fetchKeys })),
);
```

## Recommended fix

Add a configurable cache TTL (sized relative to keyGracePeriod) to makeVerifier and a Cache-Control: max-age header on the JWKS endpoint, so consumers converge on retirement within a bounded window.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ECF-002` — Unknown-kid JWKS refetch runs once per request with no single-flight, TTL, or negative caching](high/ECF-002-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, high)_`
- [`JJS-002` — Lite-verifier JWKS cache never expires: keys removed from the JWKS stay trusted indefinitely](medium/JJS-002-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`MAPS-002` — No token introspection endpoint - downstream revocation checking requires importing the session store](high/MAPS-002-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-lite-verifier-jwks-cache`. Duplicate of `ECF-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/verify.ts:92`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.

**Resolved (2026-09-29):** Fixed by the packages/jwt half of ECF-002: verifier cache TTL (verify.ts) plus Cache-Control: public, max-age=<JwtConfig.jwksMaxAge> on GET /jwt/jwks (Jwt.ts JwtHandlers); tests verifyCache.test.ts and AuthHttp.test.ts 'GET /jwt/jwks carries Cache-Control max-age'.
