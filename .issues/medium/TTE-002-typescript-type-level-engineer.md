---
ID: "TTE-002"
Title: "Decoded JWT header/payload claimed by assertion after JSON.parse"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:63"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-002 — Decoded JWT header/payload claimed by assertion after JSON.parse

`MEDIUM` · `correctness` · `oauth` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

`decodeJson` honestly returns `unknown`, but both fields are then asserted: any JSON value — a number, `null`, an array — becomes a typed `{ alg?: string; kid?: string }` header and a `Record<string, unknown>` payload without a single check. `null` even survives property access as `undefined` fields, silently steering the `alg !== "RS256"` guard at OAuth.ts:242 into the rejection path with a misleading reason. (The `parts as [string, string, string]` tuple cast on line 61 is different: it is guarded by a length check and is sound.)

## Evidence

Source: `packages/oauth/src/Jwt.ts:63`

```
header: decodeJson(headerSegment) as DecodedJwt['header'],
payload: decodeJson(payloadSegment) as Record<string, unknown>,
```

## Recommended fix

Runtime-verify the header is a non-null object whose `alg`/`kid`, when present, are strings (a 5-line guard, or a Schema), and keep the payload `unknown` — it is only consumed through checked claim access anyway; the assertions buy typing that was never validated.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit e3059f2. Evidence at HEAD ec065a7: `packages/oauth/src/Jwt.ts:100`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
