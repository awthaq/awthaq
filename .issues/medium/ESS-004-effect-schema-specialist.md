---
ID: "ESS-004"
Title: "oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:63"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-004 — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect

`MEDIUM` · `correctness` · `oauth` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **resolved**

## Summary

Unlike @awthaq/jwt's JwtCodec (which the repo's own header comment names as the correct pattern), this verifier JSON.parses untrusted token segments and casts them. A token whose header segment is base64url("null") decodes to null; the cast lies, and the subsequent `decoded.header.alg` access in OAuth.ts:242 throws a TypeError outside any try — a defect (unhandled 500) rather than the typed JwtVerificationError/OAuthCallbackFailed channel, violating the parse-error-vs-defect distinction the persona rubric tests for. Reachable only from a misbehaving or malicious configured provider, but the whole point of the boundary is to make malformed provider payloads typed.

## Evidence

Source: `packages/oauth/src/Jwt.ts:63`

```
header: decodeJson(headerSegment) as DecodedJwt["header"],
payload: decodeJson(payloadSegment) as Record<string, unknown>,
```

## Recommended fix

Reuse the Schema.fromJsonString(HeaderSchema/PayloadSchema) decoding from packages/jwt/src/JwtCodec.ts (or extract it) so a primitive header fails decode and maps to OAuthCallbackFailed.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-005` — Upstream id_token verification is RS256-only](medium/AOMS-005-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`ERAS-007` — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)](info/ERAS-007-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- [`JJS-001` — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart](high/JJS-001-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-20):** Duplicate of [`AH-001`](../high/AH-001-anders-hejlsberg.md) (same file, same evidence line, same root cause) — `packages/oauth/src/Jwt.ts`'s `decode` now schema-validates both the header (`JwtHeaderSchema`) and payload (`JwtPayloadSchema`) instead of casting `decodeJson`'s `unknown` result, failing with the typed `JwtVerificationError` for a `null`/array/otherwise-malformed segment rather than letting it reach a caller's plain property access as an unhandled defect. See `AH-001`'s own resolution comment for full detail. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.
