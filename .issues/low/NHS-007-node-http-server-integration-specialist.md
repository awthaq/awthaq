---
ID: "NHS-007"
Title: "Rotation delivery can defect an otherwise-successful authenticated response"
Level: low
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:222"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-007 — Rotation delivery can defect an otherwise-successful authenticated response

`LOW` · `correctness` · `server` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

When Sessions.verify rotates a throttled touch, the cookie scheme delivers the new secret via HttpServerResponse.setCookie(...).pipe(Effect.orDie): any failure serializing the header (a defect condition, but one triggered after a fully successful authentication) turns the request into a 500 even though the session was validated and the handler already produced a response. For bearer clients rotation instead rides a custom set-auth-token response header (line 223) that no RFC governs and intermediaries/CDNs commonly strip, silently losing the rotation for exactly the clients that have no cookie jar to fall back on.

## Evidence

Source: `packages/server/src/Authentication.ts:222`

```
        Sessions.SESSION_COOKIE_ATTRIBUTES,
      ).pipe(Effect.orDie)
```

## Recommended fix

Treat rotation-delivery failure as non-fatal (log and continue with the undecorated response) rather than orDie, and document the set-auth-token header as a contract with guidance for proxy configurations that strip unknown headers.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-rotation-delivery`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:233`. Fix: Folded into PIL-005: rotation delivery moves into a pre-response handler that recovers encoding failures (log and continue) instead of orDie. Header-stripping guidance ships with MNA-005's docs. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Folded into PIL-005: delivery is a pre-response handler that recovers CookiesError via logWarning and returns the undecorated response instead of orDie.
