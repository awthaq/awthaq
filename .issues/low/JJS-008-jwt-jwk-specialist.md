---
ID: "JJS-008"
Title: "typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented"
Level: low
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/JwtCodec.ts:136"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-008 — typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented

`LOW` · `security` · `jwt` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **resolved**

## Summary

Minting sets typ: 'JWT' but the verifier's HeaderSchema (lines 48-51) does not even capture typ, let alone check it, and nbf is likewise unvalidated. The research the spec cites (research/04-sessions-tokens.md Q60, quoted in spec/models/08-jwt-bearer.md:80) explicitly calls for 'strict alg/typ/iss/aud verification per RFC 8725'; alg/iss/aud landed, typ did not. Impact is minimal today because the codebase mints the only tokens it verifies, but the lite verifier is meant for third parties mixing these tokens into other typ-scoped ecosystems.

## Evidence

Source: `packages/jwt/src/JwtCodec.ts:136`

```
    const header = { alg: params.alg, kid: params.kid, typ: "JWT" };
```

## Recommended fix

Add typ to HeaderSchema and reject non-'JWT' (or accept an optional expectedTyp in VerifierOptions), and honor nbf/iat consistency while there.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-010` — JWT algorithm vocabulary is EdDSA/ES256 only](low/BAM-010-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, low)_`
- [`GC-002` — JWT claims have no schema on either side of the codec](medium/GC-002-giulio-canti.md) `_(giulio-canti, medium)_`
- [`JJS-003` — Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation](medium/JJS-003-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`JJS-007` — signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint](low/JJS-007-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-009` — No negative tests for algorithm confusion or core unknown-kid fail-closed](low/JJS-009-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-claims-codec-hardening`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtCodec.ts:48`. Fix: Decode and enforce `typ` (RFC 8725 §3.11) and honour `nbf`/`iat` in `JwtCodec.verify` and the lite verifier. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** JwtCodec HeaderSchema decodes typ; verify takes expectedTyp (string or list, case-insensitive per RFC 7515 4.1.9) and rejects nbf/iat in the future beyond clockSkew; lite verifier VerifierOptions gains expectedTyp (default at+jwt) and clockSkew. Tests in packages/jwt/test/JwtCodec.test.ts: typ mismatch, case-insensitive typ, nbf future (then valid after TestClock), iat far future with/without clockSkew (all red before: typ/nbf/iat were never checked).
