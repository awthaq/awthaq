---
ID: "TS-003"
Title: "Per-request verify cache uses an unguarded module-level WeakMap get-or-create, so concurrent first access can orphan memoized verifications (and re-trigger secret rotation)"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Authentication.ts:129"
Auditor: "tim-smart"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-003 — Per-request verify cache uses an unguarded module-level WeakMap get-or-create, so concurrent first access can orphan memoized verifications (and re-trigger secret rotation)

`MEDIUM` · `correctness` · `server` · reported by **Effect Platform & Infrastructure Maintainer** (`tim-smart`)

Status: **ready-for-agent**

## Summary

The WeakMap itself is a defensible Effect-v4 idiom (no FiberRef; request identity is stable; GC reclaims it) and the surrounding rationale is well documented (lines 96-122). But get-then-create is not atomic: two fibers interleaving at the gen yield points both observe None, both create their own Ref, and the second `set` silently replaces the first. The losing fiber's `Effect.cached` outcome (already stored in its orphaned Ref) becomes invisible to later lookups, so a subsequent `resolveSession` in the same request re-runs `Sessions.verify` — which, under ticket 01's throttled-touch rotation, can rotate the session secret a second time or fail SessionNotFound, defeating the exact bug the cache exists to prevent (ticket 03).

## Evidence

Source: `packages/server/src/Authentication.ts:129`

```
onNone: () =>
        Ref.make(HashMap.empty<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>()).pipe(
          Effect.tap((ref) => Effect.sync(() => sessionResolutionCache.set(request, ref))),
```

## Recommended fix

Make cache creation single-winner: register the Ref synchronously before any yield (compute `Ref.unsafeMake` + `WeakMap.set` inside one `Effect.sync`, returning a pre-existing ref if present), or attach the cache in a router-level middleware that provides a per-request service once, so both bridges read the same Ref by construction.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: platform & SQL integration
- Full dossier: [`tim-smart`](../../.reports/tim-smart/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `per-request-session-cache`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:129`. Fix: Make per-request memoization single-flight by construction and key it on `request.source`, as Effect's own per-request state is keyed. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
