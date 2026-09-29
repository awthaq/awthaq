---
ID: "VB-003"
Title: "OAuth id_token key selection falls back to the first JWKS key on kid mismatch"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:101"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-003 — OAuth id_token key selection falls back to the first JWKS key on kid mismatch

`MEDIUM` · `security` · `oauth` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

findKey treats an absent kid and a kid that matches no JWKS entry identically: both fall back to candidates[0], so the token's kid is never authoritative for key identity. Signature verification still gates acceptance, so this is not a forgery path, but a token signed under a provider's first key while claiming any other kid verifies, and RFC 8725 section 5.5.2 discipline (reject, or try-all-then-fail) that the repo's own research file demands is not met. During provider rotations with multiple published keys, kid stops being a meaningful rotation signal.

## Evidence

Source: `packages/oauth/src/Jwt.ts:101`

```
: (candidates.find((key) => key.kid === kid) ?? candidates[0]);
```

## Recommended fix

Fail on a kid that matches no candidate; only fall back to a single-key heuristic when the token carries no kid at all, and consider trying all keys before failing when kid is absent.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-005` — Upstream id_token verification is RS256-only](medium/AOMS-005-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`ERAS-007` — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)](info/ERAS-007-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit fd8e5e9. Evidence at HEAD ec065a7: `packages/oauth/src/Jwt.ts:148`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
