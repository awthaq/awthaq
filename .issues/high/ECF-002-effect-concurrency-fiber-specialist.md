---
ID: "ECF-002"
Title: "Unknown-kid JWKS refetch runs once per request with no single-flight, TTL, or negative caching"
Level: high
Category: "security"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/verify.ts:109"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-002 — Unknown-kid JWKS refetch runs once per request with no single-flight, TTL, or negative caching

`HIGH` · `security` · `jwt` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **ready-for-agent**

## Summary

verify() refetches the JWKS document on every 'unknown kid' error. An attacker who sends garbage kid values at a public endpoint gets one outbound fetch per request out of the server (amplification + latency + upstream JWKS-host pain), and N concurrent first verifications each run fetchKeys because the cache is filled by check-then-Ref.set (verify.ts:92-94) with no in-flight coalescing. There is also no TTL, so keys persist forever until an unknown kid happens to trigger a refresh. verifyIdToken in the OAuth plugin has the identical one-refetch pattern (OAuth.ts:256-261) over the same non-atomic cache fill (OAuth.ts:253-254).

## Evidence

Source: `packages/jwt/src/verify.ts:109`

```
Effect.catchIf(
            (error) => error.reason === "unknown kid",
            () => Effect.flatMap(fetchKeys, (refetched) => verifyAgainst(token, refetched)),
```

## Recommended fix

Build the key source on Effect.cached with cachedInvalidateWithTTL (or a Deferred-based single-flight): concurrent misses share one fetch; add a modest TTL; and memoize negative results (unknown kid) for a short window (seconds) so garbage kids cannot drive fetch rate. Cache one in-flight fetch per verifier, not per call.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`JJS-002` — Lite-verifier JWKS cache never expires: keys removed from the JWKS stay trusted indefinitely](medium/JJS-002-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`KRS-010` — Lite verifier's JWKS cache never expires keys and the served JWKS sets no caching guidance](low/KRS-010-key-rotation-specialist.md) `_(key-rotation-specialist, low)_`
- [`MAPS-002` — No token introspection endpoint - downstream revocation checking requires importing the session store](high/MAPS-002-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/jwt/src/verify.ts:109` exactly; `fetchKeys` (verify.ts:83-90) has no TTL and the cache fill at verify.ts:92-94 is check-then-set with no in-flight coalescing, so concurrent unknown-kid misses each trigger their own fetch. Fix (`Effect.cached`/single-flight + TTL) is a mechanical, well-scoped change. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-lite-verifier-jwks-cache`. Evidence at HEAD ec065a7: `packages/jwt/src/verify.ts:83`. Fix: Single-flight, TTL'd JWKS caches with a rate-limited unknown-kid refetch in both the lite verifier and OAuth's id_token verifier; publish Cache-Control on /jwt/jwks. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`.
