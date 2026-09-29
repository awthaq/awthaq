---
ID: "AGA-002"
Title: "No CORS or preflight handling exists and the safe default-deny posture is undocumented"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/AuthHttp.ts:25"
Auditor: "api-gateway-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AGA-002 — No CORS or preflight handling exists and the safe default-deny posture is undocumented

`MEDIUM` · `architecture` · `server` · reported by **API Gateway Auth Specialist** (`api-gateway-auth-specialist`)

Status: **ready-for-agent**

## Summary

A grep for cors/CORS/OPTIONS/preflight across packages/ returns zero matches — the serving stratum is a bare re-export of HttpApiBuilder.layer with no middleware, headers, or guidance. For same-origin cookie deployments this is a safe default (browsers deny cross-origin reads without ACAO, and an unmatched preflight OPTIONS request 404s, killing the actual request before it fires). But a gateway-fronted deployment serving cross-origin clients gets no support and no warning: preflight requests fail opaquely, and the moment an operator wires HttpMiddleware.cors at the app or gateway layer, they silently dismantle one leg of the accidental anti-CSRF stack (JSON-only bodies + absent CORS) that other auditors showed is load-bearing. The CSRF middleware's own Origin allowlist (Csrf.ts:119-132) then becomes the only cross-origin policy, and the two configs can drift apart with nothing forcing them to agree.

## Evidence

Source: `packages/server/src/AuthHttp.ts:25`

```
export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;
```

## Recommended fix

Document the default-deny CORS posture in spec (what it protects, what a deployment must do to open cross-origin access), and ship a blessed CORS preset that requires an explicit allowedOrigins list shared with CsrfConfig.allowedOrigins so the edge policy and the CSRF site-check cannot diverge.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Gateway deployment posture
- Full dossier: [`api-gateway-auth-specialist`](../../.reports/api-gateway-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CDS-008` — No CORS configuration or documented posture exists anywhere in the library](info/CDS-008-csrf-defense-specialist.md) `_(csrf-defense-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cors-posture`. Evidence at HEAD ec065a7: `packages/server/src/AuthHttp.ts:25`. Fix: Document the default-deny CORS posture, and ship a blessed CORS preset whose origin allowlist is the same value as CsrfConfig.allowedOrigins. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
