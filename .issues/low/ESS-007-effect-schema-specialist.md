---
ID: "ESS-007"
Title: "kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule"
Level: low
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:101"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-007 — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule

`LOW` · `correctness` · `oauth` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **resolved**

## Summary

The doc comment scopes the fallback to 'its lone RSA key, absent one' (kid missing), but the code also falls back to candidates[0] when a kid is present and unmatched. This contradicts JwtCodec.ts's stated rule that a token is matched by kid and 'the token's own declared alg is never trusted alone'; a token claiming an unknown kid is verified against whatever key happens to be first. Signature verification still gates acceptance, so practical impact is limited to multi-key providers with rotation, but the implementation does not do what its comment and sibling module promise.

## Evidence

Source: `packages/oauth/src/Jwt.ts:101`

```
: (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

Fall back only when kid is undefined; on an unmatched kid, fail with JwtVerificationError (the refetch-on-miss path in OAuth.ts:256-261 already covers rotation).

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
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- [`JJS-001` — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart](high/JJS-001-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit fd8e5e9. Evidence at HEAD ec065a7: `packages/oauth/src/Jwt.ts:148`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
