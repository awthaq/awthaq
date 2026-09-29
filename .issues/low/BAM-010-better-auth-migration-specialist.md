---
ID: "BAM-010"
Title: "JWT algorithm vocabulary is EdDSA/ES256 only"
Level: low
Category: "api"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/JwtCodec.ts:36"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-010 — JWT algorithm vocabulary is EdDSA/ES256 only

`LOW` · `api` · `jwt` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

better-auth's jose-based jwt plugin provisions keys per configurable algorithm; effect-auth's codec signs and verifies only EdDSA and ES256 (WebCrypto Ed25519/P-256). Existing better-auth-issued tokens under any other algorithm cannot verify against a migrated KeyRing, forcing re-issuance of every outstanding JWT at cutover. Verification hygiene is otherwise strong (kid matching with alg cross-check, the token's declared alg never trusted alone), and the SigningKeyRecords.create shape can import foreign key material for supported algs.

## Evidence

Source: `packages/jwt/src/JwtCodec.ts:36`

```
export type Algorithm = "EdDSA" | "ES256";
```

## Recommended fix

If RS256-class deployments matter for migration, widen the Algorithm union and WebCrypto parameter map, or state algorithm scope in the migration docs so teams plan a token re-issuance window.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`GC-002` — JWT claims have no schema on either side of the codec](medium/GC-002-giulio-canti.md) `_(giulio-canti, medium)_`
- [`JJS-003` — Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation](medium/JJS-003-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`JJS-007` — signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint](low/JJS-007-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-008` — typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented](low/JJS-008-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-009` — No negative tests for algorithm confusion or core unknown-kid fail-closed](low/JJS-009-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jose-algorithm-coverage`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtCodec.ts:36`. Fix: Widen the jwt plugin to the common asymmetric JOSE set (EdDSA, ES256, ES384, RS256, PS256) via one algorithm table; still no HS*. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Algorithm vocabulary widened to EdDSA, ES256, ES384, RS256, PS256 through one AlgorithmSpec table in JwtCodec (import/sign/generate params, kty); JwtCodec.generateKeyJwks replaces KeyRing's inline keygen (JwtConfig.rsaModulusLength, default 2048); SigningKeyRecords derives its alg literals from the same schema; verify.ts toVerificationKeys uses the isAlgorithm guard; HS* stays unrepresentable. KeyRing.importKey imports a foreign public key as a verification-only (already-rotated) key, rejecting a wrong kty or private material (InvalidKeyImport). Tests: JwtCodec.test.ts round-trip for all five algorithms and cross-alg confusion, KeyRing.test.ts 'imports a foreign RS256 key and verifies a token signed by it, without disturbing the current key', 'importKey refuses ...', 'mints a key for every supported algorithm'. Deviation: importKey takes only the public half (verification-only), since a migrator needs old tokens to verify, not to keep signing with a foreign key.
