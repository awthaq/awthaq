---
ID: "JJS-007"
Title: "signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint"
Level: low
Category: "api"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/JwtCodec.ts:253"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-007 — signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint

`LOW` · `api` · `jwt` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **resolved**

## Summary

Ticket 14 bills signJWT as arbitrary-payload signing 'not tied to any Principal' (Jwt.ts:72-76), yet verify — shared by verifyJWT — unconditionally requires a present, non-empty sub. signJWT({ machine: 'etl-job' }) mints a token its own verifyJWT rejects with 'missing sub'; all the tests dodge this by always passing sub. Either the general-purpose path is not actually general-purpose, or the sub requirement belongs to the principal-scoped layer, not the codec.

## Evidence

Source: `packages/jwt/src/JwtCodec.ts:253`

```
    if (typeof payload["sub"] !== "string" || payload["sub"].length === 0) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "missing sub" }));
```

## Recommended fix

Move the sub requirement out of JwtCodec.verify into the principal-scoped verify (Jwt.ts), or document sub as a hard precondition of signJWT and validate it at mint time so the failure surfaces at signing, not at an unknowable downstream verify.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-010` — JWT algorithm vocabulary is EdDSA/ES256 only](low/BAM-010-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, low)_`
- [`GC-002` — JWT claims have no schema on either side of the codec](medium/GC-002-giulio-canti.md) `_(giulio-canti, medium)_`
- [`JJS-003` — Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation](medium/JJS-003-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`JJS-008` — typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented](low/JJS-008-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-009` — No negative tests for algorithm confusion or core unknown-kid fail-closed](low/JJS-009-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-claims-codec-hardening`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtCodec.ts:253`. Fix: Move the `sub` requirement out of `JwtCodec.verify` into the principal-scoped verifiers; give `verifyJWT` its own implementation. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** JwtCodec.verify gained requireSubject (default true; sub check moved out of the codec's unconditional path); Jwt.verify passes true, verifyJWT is a distinct implementation with false; verify.ts VerifierOptions.requireSubject. Tests: packages/jwt/test/JwtTokenClasses.test.ts 'signJWT({ machine }) verifies via verifyJWT', 'Jwt.verify still rejects a principal token without sub'; JwtCodec.test.ts requireSubject false case.
