---
ID: "JJS-003"
Title: "Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation"
Level: medium
Category: "correctness"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/JwtCodec.ts:225"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-003 — Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation

`MEDIUM` · `correctness` · `jwt` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **resolved**

## Summary

sign uses the current key's own alg (Jwt.ts:230, key.alg — still EdDSA after a config switch to ES256), while verify pins config.algorithm (Jwt.ts:263). KeyRing rotation is triggered purely by createdAt age (KeyRing.ts:160 isStale on keyRotationInterval), never by an algorithm mismatch, so after an operator changes JwtConfig.algorithm every freshly minted token fails verification with 'algorithm not allowed' until up to 90 days later when the rotation interval elapses — a silent total outage of the plugin for its own tokens.

## Evidence

Source: `packages/jwt/src/JwtCodec.ts:225`

```
    if (parsed.header.alg !== params.algorithm) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "algorithm not allowed" }));
```

## Recommended fix

Have rotateIfDue (and layerFromStore) treat current.alg !== config.algorithm as stale and rotate immediately, and/or fail composition loudly at boot if the current key's alg disagrees with the configured algorithm.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-010` — JWT algorithm vocabulary is EdDSA/ES256 only](low/BAM-010-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, low)_`
- [`GC-002` — JWT claims have no schema on either side of the codec](medium/GC-002-giulio-canti.md) `_(giulio-canti, medium)_`
- [`JJS-007` — signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint](low/JJS-007-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-008` — typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented](low/JJS-008-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-009` — No negative tests for algorithm confusion or core unknown-kid fail-closed](low/JJS-009-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-key-rotation-integrity`. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:387`. Fix: Rotate immediately when the current key's alg differs from config, and verify against each key's own alg under an allowlist so grace-period keys of the old alg keep verifying. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/jwt: Algorithm is defined once in JwtCodec (JwtConfig re-exports it); JwtCodec.verify takes algorithms (allowlist) and requires header alg == the matched key's own alg, verifying with key.alg; Jwt.verify passes the distinct algs of the verifiable keys; lite verifier VerifierOptions.algorithm became algorithms; KeyRing treats current.alg != JwtConfig.algorithm as due (layerFromStore and rotateIfDue) so a config change rotates on next access. Tests: packages/jwt/test/JwtTokenClasses.test.ts 'switching JwtConfig.algorithm rotates on next access; the old key keeps verifying during grace', 'a token minted before an algorithm switch keeps verifying; new ones use the new algorithm'; JwtCodec.test.ts per-key algorithm cases.
