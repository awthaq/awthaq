---
ID: "ECF-005"
Title: "Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper"
Level: low
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:166"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-005 — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper

`LOW` · `correctness` · `server` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

resolveSession reads the cache, and on a miss constructs a fresh Effect.cached wrapper and inserts it in a second Ref.update. Two concurrent callers with the same credential in the same request window can each build their own wrapper (and perRequestCache can likewise mint two Refs for one request), and Effect.cached coalesces only within one wrapper — so both would run Sessions.verify. Today the two bridges call sequentially per request, so the ticket-03 guarantee (a second call must not re-verify against an already-rotated secret) holds by sequencing, not by the cache; the store-level CAS keeps even the racy outcome safe. A fragile-but-currently-benign contract.

## Evidence

Source: `packages/server/src/Authentication.ts:166`

```
const existing = HashMap.get(yield* Ref.get(cache), raw);
    if (Option.isSome(existing)) {
      return yield* existing.value;
    }
```

## Recommended fix

Make get-or-create atomic: a single Ref.modify over the per-request map that inserts a memoized (single-flight) effect and returns it, so the first caller creates and every concurrent caller awaits the same wrapper regardless of interleaving.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `per-request-session-cache`. Duplicate of `TS-003-tim-smart` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:166`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
