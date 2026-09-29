---
ID: "CDS-008"
Title: "No CORS configuration or documented posture exists anywhere in the library"
Level: info
Category: "architecture"
Status: resolved
Package: "server"
Source: "packages/server/src/AuthHttp.ts:25"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-008 — No CORS configuration or documented posture exists anywhere in the library

`INFO` · `architecture` · `server` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

A grep for cors/Cors/CORS across packages/** returns zero matches; the serving stratum is a bare re-export of HttpApiBuilder.layer with no middleware, headers, or guidance. For a cookie-authenticated API this is currently a safe default (browsers deny cross-origin reads without ACAO), and it silently contributes layer (2) of the accidental anti-CSRF stack described in CDS-003. But the absence is undocumented: the moment a deployment adds effect's own HttpMiddleware.cors to serve a legitimate cross-site consumer (STACK.md:78 notes it is available and complete), that accidental layer is gone and no artifact of this library reminds anyone that CsrfProtection was supposed to be the replacement.

## Evidence

Source: `packages/server/src/AuthHttp.ts:25`

```
export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;
```

## Recommended fix

Document the intended CORS posture in spec (default-deny, and what a deployment must provide when it opens cross-origin access), and ship a blessed CORS preset that requires/encourages CsrfProtection attachment so the two capabilities are adopted together.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-002` — No CORS or preflight handling exists and the safe default-deny posture is undocumented](medium/AGA-002-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cors-posture`. Duplicate of `AGA-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/AuthHttp.ts:25`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
