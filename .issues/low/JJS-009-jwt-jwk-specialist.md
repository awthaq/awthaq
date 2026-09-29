---
ID: "JJS-009"
Title: "No negative tests for algorithm confusion or core unknown-kid fail-closed"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/JwtCodec.ts:229"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-009 — No negative tests for algorithm confusion or core unknown-kid fail-closed

`LOW` · `testing` · `jwt` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **ready-for-agent**

## Summary

The suite covers tampering, expiry, issuer/audience, rotation windows, remote signing, and the lite verifier's unknown-kid refetch (verify.test.ts:163), but the two behaviors this persona considers the red lines — a token whose header declares alg:none or a cross-alg value, and a kid that matches no key — are never exercised against JwtCodec.verify or jwt.verify. A future refactor that loosens the alg comparison (e.g. optional-chaining or case-insensitive compare) or adds a findKey-style fallback would pass the entire suite. The pins exist in code (lines 225-231); nothing locks them in.

## Evidence

Source: `packages/jwt/src/JwtCodec.ts:229`

```
    if (key === undefined) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "unknown kid" }));
    }
```

## Recommended fix

Add three tests: header alg 'none'/missing/'HS256' fails with JwtInvalidError; unknown kid fails closed (no first-key fallback); and a token signed under a retired key fails after its JWKS entry disappears once the lite verifier's cache is refreshed.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-010` — JWT algorithm vocabulary is EdDSA/ES256 only](low/BAM-010-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, low)_`
- [`GC-002` — JWT claims have no schema on either side of the codec](medium/GC-002-giulio-canti.md) `_(giulio-canti, medium)_`
- [`JJS-003` — Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation](medium/JJS-003-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`JJS-007` — signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint](low/JJS-007-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-008` — typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented](low/JJS-008-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-claims-codec-hardening`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtCodec.ts:225`. Fix: Add pinning tests for algorithm confusion and unknown-kid fail-closed. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.
