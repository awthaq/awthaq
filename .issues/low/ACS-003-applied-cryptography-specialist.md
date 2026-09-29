---
ID: "ACS-003"
Title: "OIDC key selection falls back to the first RSA key on kid mismatch"
Level: low
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:99"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-003 — OIDC key selection falls back to the first RSA key on kid mismatch

`LOW` · `security` · `oauth` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

When a token's kid is absent or matches no JWKS entry, findKey silently tries the first RSA key instead of failing. Signature verification still gates acceptance (a token not signed by key 0 fails), so this is not a forgery path, but it weakens key-pinning discipline (RFC 8725 section 2.2) and produces confusing failure modes during provider key rotation with multiple published keys: a token signed by a genuinely rotated key is attempted against a stale key and only fails at signature check rather than triggering the intended refetch-once-then-fail semantics the caller implements.

## Evidence

Source: `packages/oauth/src/Jwt.ts:99`

```
    kid === undefined
      ? candidates[0]
      : (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

Fail with no-matching-key when kid is present but unrecognized (the caller already refetches JWKS once on miss); keep the lone-key fallback only for kid-undefined tokens.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
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
