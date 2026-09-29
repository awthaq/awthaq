---
ID: "GC-002"
Title: "JWT claims have no schema on either side of the codec"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/JwtCodec.ts:133"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-002 — JWT claims have no schema on either side of the codec

`MEDIUM` · `architecture` · `jwt` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **ready-for-agent**

## Summary

`sign` accepts `claims: Record<string, unknown>` and encodes it with raw JSON.stringify, while the decode side validates only `PayloadSchema = Schema.Record(Schema.String, Schema.Unknown)` (JwtCodec.ts:53) and then re-derives the claim contract by hand-rolled `typeof` checks in `verify` (iss/aud equality at 242, `typeof exp !== "number"` at 246, sub check at 253). The two halves of the codec are not projections of one declaration, so the claims contract exists nowhere as data: sign-time assembly and verify-time validation can drift silently, and the hand checks are subtly non-conformant (RFC 7519 §4.1.3 allows `aud` as an array, which this verify rejects). This is the one place in the codebase where a codec should have been the source of truth and instead is a bag of dynamic values.

## Evidence

Source: `packages/jwt/src/JwtCodec.ts:133`

```
  readonly claims: Record<string, unknown>;
```

## Recommended fix

Define a Claims Schema (iss/aud/exp/sub, aud as string-or-array) and use it for both encode-side assembly in `sign` and decode-side validation in `parse`, leaving only genuinely temporal checks (exp vs now) as explicit code.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BAM-010` — JWT algorithm vocabulary is EdDSA/ES256 only](low/BAM-010-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, low)_`
- [`JJS-003` — Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation](medium/JJS-003-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`JJS-007` — signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint](low/JJS-007-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-008` — typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented](low/JJS-008-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`
- [`JJS-009` — No negative tests for algorithm confusion or core unknown-kid fail-closed](low/JJS-009-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-claims-codec-hardening`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtCodec.ts:53`. Fix: One `RegisteredClaims` Schema used by both `JwtCodec.sign` (encode) and `parse` (decode); `verify` keeps only relational/temporal checks; `aud` accepts string or array. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.
