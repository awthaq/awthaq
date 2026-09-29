---
ID: "PCS-006"
Title: "Per-request session memoization extends a verify outcome across the request's lifetime"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Authentication.ts:170"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-006 — Per-request session memoization extends a verify outcome across the request's lifetime

`LOW` · `correctness` · `server` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **ready-for-agent**

## Summary

resolveSession memoizes the full Exit of Sessions.verify per raw credential for as long as the request object lives (WeakMap keyed on HttpServerRequest). This is correct and necessary — Sessions.verify rotates the session secret on throttled touch, so a second verify with the pre-rotation credential would spuriously fail (Authentication.ts:102-106) — and the scope discipline is exemplary. The residual property worth documenting: a session revoked mid-request keeps resolving as authenticated until that request ends, so a long-running request (large upload, SSE) can act on a revoked session for an unbounded wall-clock window. That is an accepted per-request staleness class, but it is nowhere stated as a security property at the call site.

## Evidence

Source: `packages/server/src/Authentication.ts:170`

```
const memoized = yield* Effect.cached(
  raw === ""
```

## Recommended fix

Document the mid-request revocation window in resolveSession's doc comment as a deliberate staleness budget (bounded by request lifetime), and consider having Sessions.revoke of the current session invalidate the request's cache entry if long-lived requests become a supported pattern.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: decision caching
- Full dossier: [`permission-caching-specialist`](../../.reports/permission-caching-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `per-request-session-cache`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:184`. Fix: Document the bounded mid-request revocation window as a deliberate staleness budget. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
