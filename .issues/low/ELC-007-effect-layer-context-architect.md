---
ID: "ELC-007"
Title: "Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement"
Level: low
Category: "architecture"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:123"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-007 — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement

`LOW` · `architecture` · `server` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **resolved**

## Summary

The per-request Effect.cached memoization (a genuinely good optimization: it dedupes Sessions.verify across cookie/bearer schemes, OptionalAuthentication, and qadi's Path B extractor) is hosted in module-level state keyed by request-object identity instead of the request's own fiber scope. Correctness today relies on the platform never pooling/reusing HttpServerRequest objects, and the ambient HttpServerRequest requirement is a hidden seam: qadi's SubjectExtractor must remember to Effect.provideService(HttpServerRequest, request) manually (SubjectExtractor.ts:89) or the memoization silently degrades to per-call behavior — a constraint only discoverable by reading the ticket-03 comment.

## Evidence

Source: `packages/server/src/Authentication.ts:123`

```
const sessionResolutionCache = new WeakMap<
  HttpServerRequest.HttpServerRequest,
  Ref.Ref<HashMap.HashMap<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>>>
```

## Recommended fix

Attach the cache Ref to the request's own scope (e.g. a FiberRef or Effect.scope-local resource acquired from the request) so lifetime is structural rather than GC-coupled, and have resolveSession document (or type-level require) the ambient HttpServerRequest that Path B callers must supply.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `per-request-session-cache`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:123`. Fix: Documentation only. The module-level WeakMap is Effect v4's own idiom (there is no FiberRef in v4), and the ambient HttpServerRequest requirement is already visible in resolveSession's R type. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Doc-only: resolveSession/sessionResolutionCache comments now state HttpServerRequest is a hard R requirement and that lifetime is tied to request.source as Effect's own pre-response handlers are.
