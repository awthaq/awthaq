---
ID: "MAPS-008"
Title: "Bearer rotation delivers the raw long-lived session secret via a response header"
Level: low
Category: "security"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Authentication.ts:223"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-008 — Bearer rotation delivers the raw long-lived session secret via a response header

`LOW` · `security` · `server` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **ready-for-agent**

## Summary

When a bearer-authenticated request triggers the throttled secret rotation, the fresh full session token (30-day absolute TTL) is returned in a set-auth-token header. This is a deliberate upstream mechanism and the only way a bearer client can learn its token rotated, but response headers are the credential class most likely to be captured by intermediate proxies, API gateways, and access logs - exactly the infrastructure a service-mesh deployment inserts on every hop. My persona's red-flag anti-pattern is 'passing the user's original long-lived token through infrastructure that does not need it'; this does that on every rotation.

## Evidence

Source: `packages/server/src/Authentication.ts:223`

```
: Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
```

## Recommended fix

Document the header-logging hazard prominently, and consider bounding the exposure (e.g. deliver rotation only to a dedicated refresh endpoint, or switch bearer clients to short-lived derived credentials so rotation of the parent secret is not client-visible at all).

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-rotation-delivery`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:233`. Fix: Reduce the exposure of the rotated long-lived secret in transit and in logs. Header delivery itself stays, as ticket 01 decided. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
