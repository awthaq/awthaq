---
ID: "AP-002"
Title: "Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:101"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-002 — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable

`MEDIUM` · `correctness` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

When the id_token header carries a kid that is not in the (cached) JWKS, findKey silently returns candidates[0] instead of failing. OAuth.ts:256-260 refetches the JWKS only when Jwt.findKey fails, so the documented "one refetch on a kid cache miss" rotation behavior never triggers on an actual kid miss — it only fires when the JWKS contains no RSA keys at all. Consequence: after a provider rotates keys (new kid published), verification proceeds against the stale first key, the signature check fails, and every login errors with OAuthCallbackFailed until process restart. Verifying with the wrong key is not an auth bypass (the signature must still validate), but it defeats the module's own stated rotation strategy and breaks OIDC key-rotation interop, which Jwt.ts:10-14 admits is otherwise unimplemented.

## Evidence

Source: `packages/oauth/src/Jwt.ts:101`

```
kid === undefined
      ? candidates[0]
      : (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

Make kid authoritative: fail with JwtVerificationError when kid is defined and no entry matches (that failure is what drives the existing refetch), keep candidates[0] only for tokens without a kid. Add a JWKS cache TTL and a refetch-on-signature-failure retry.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-005` — Upstream id_token verification is RS256-only](medium/AOMS-005-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`ERAS-007` — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)](info/ERAS-007-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- [`JJS-001` — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart](high/JJS-001-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit fd8e5e9. Evidence at HEAD ec065a7: `packages/oauth/src/Jwt.ts:148`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
