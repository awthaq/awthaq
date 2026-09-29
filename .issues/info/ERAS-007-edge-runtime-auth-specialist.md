---
ID: "ERAS-007"
Title: "The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)"
Level: info
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:16"
Auditor: "edge-runtime-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERAS-007 — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)

`INFO` · `api` · `oauth` · reported by **Edge Runtime Auth Specialist** (`edge-runtime-auth-specialist`)

Status: **resolved**

## Summary

Every runtime node: import in packages/ lives in test files; the only one in shipped src is oauth's type-only webcrypto import, which is fully erased at compile time and therefore edge-safe (the actual verification goes through platform crypto.subtle per the file's own header, Jwt.ts:8-11). It is still the one place a Node namespace leaks into the isomorphic surface's types, so consumers generating edge bundles with strict type resolution will pull node types for @awthaq/oauth even though nothing runtime-side needs them.

## Evidence

Source: `packages/oauth/src/Jwt.ts:16`

```
import type { webcrypto } from "node:crypto";
```

## Recommended fix

Replace the node:crypto webcrypto type with the DOM/WebCrypto CryptoKey/Crypto types (or lib.dom's SubtleCrypto-derived types) so the oauth package's type surface is runtime-neutral too.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Edge Runtime Compat
- Full dossier: [`edge-runtime-auth-specialist`](../../.reports/edge-runtime-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-005` — Upstream id_token verification is RS256-only](medium/AOMS-005-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- [`JJS-001` — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart](high/JJS-001-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit e364411. Evidence at HEAD ec065a7: `packages/oauth/src/Jwt.ts:16`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
