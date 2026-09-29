---
ID: "JJS-002"
Title: "Lite-verifier JWKS cache never expires: keys removed from the JWKS stay trusted indefinitely"
Level: medium
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/verify.ts:92"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-002 — Lite-verifier JWKS cache never expires: keys removed from the JWKS stay trusted indefinitely

`MEDIUM` · `security` · `jwt` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **resolved**

## Summary

makeVerifier caches the fetched key set in a Ref with no expiry; the only invalidation is the one-shot unknown-kid refetch (correctly implemented and tested). A key that the issuer retires past its grace period and drops from the JWKS — or revokes via rotateNow after a compromise — remains in every long-lived consumer's cache until that consumer sees a new kid or restarts. With the 15-minute default TTL the blast radius is small, but signJWT accepts an arbitrary ttl override, so any longer-lived token keeps validating downstream against a key the issuer no longer publishes. Concurrent cold-start verifications also each trigger a fetch (no memoization), which is harmless but sloppy.

## Evidence

Source: `packages/jwt/src/verify.ts:92`

```
    const currentKeys = Ref.get(cache).pipe(
      Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => fetchKeys })),
```

## Recommended fix

Timestamp the cached key set and refetch when it is older than a configurable maxAge (default on the order of hours); optionally also refetch once when verification fails for a key-related reason, not just on unknown kid.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ECF-002` — Unknown-kid JWKS refetch runs once per request with no single-flight, TTL, or negative caching](high/ECF-002-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, high)_`
- [`KRS-010` — Lite verifier's JWKS cache never expires keys and the served JWKS sets no caching guidance](low/KRS-010-key-rotation-specialist.md) `_(key-rotation-specialist, low)_`
- [`MAPS-002` — No token introspection endpoint - downstream revocation checking requires importing the session store](high/MAPS-002-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-lite-verifier-jwks-cache`. Duplicate of `ECF-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/verify.ts:92`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
