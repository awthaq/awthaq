---
ID: "NHS-006"
Title: "Per-request session cache relies on framework-internal request object identity"
Level: low
Category: "architecture"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:123"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-006 — Per-request session cache relies on framework-internal request object identity

`LOW` · `architecture` · `server` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

The module-level WeakMap memoizes session resolution per request, keyed on the ambient HttpServerRequest object. The module's own comment (lines 108-121) admits this exists because Effect v4 has no FiberRef, and that correctness depends on the router providing one stable, per-request object that is 'mutated in place rather than replaced' — behavior confirmed only by reading effect's own HttpRouter/HttpApiBuilder sources, not enforced by types. Any host or middleware that re-wraps or replaces the request service mid-request silently forks or, worse, if a host ever pooled request objects, shares credential outcomes across requests. It is a clever, garbage-collector-friendly workaround whose safety is an undocumented cross-package invariant.

## Evidence

Source: `packages/server/src/Authentication.ts:123`

```
const sessionResolutionCache = new WeakMap<
  HttpServerRequest.HttpServerRequest,
  Ref.Ref<HashMap.HashMap<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>>
```

## Recommended fix

Provide the cache through a tiny first middleware that scopes an empty Ref to the request's own Effect scope (or a Context.Reference re-provided per request), so per-request-ness is structural rather than resting on object identity.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `per-request-session-cache`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:123`. Fix: Key the per-request cache on `request.source`, not the HttpServerRequest wrapper, so re-wrapping (HttpRouter prefix mounts) cannot fork it. Fix the doc comment's false 'mutated in place, never replaced' invariant. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Covered by the TS-003 rewrite: cache keyed on request.source; doc comment rewritten (cites Effect's requestPreResponseHandlers WeakMap and HttpRouter's sliceRequestUrl re-wrap). Test 'a re-wrapped request (request.modify) shares the original's verification' was red (timed out) before.
