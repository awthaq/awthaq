---
ID: "MNA-005"
Title: "Bearer rotation rides an unread set-auth-token header; native sessions silently expire within an hour"
Level: medium
Category: "api"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Authentication.ts:223"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-005 — Bearer rotation rides an unread set-auth-token header; native sessions silently expire within an hour

`MEDIUM` · `api` · `server` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **ready-for-agent**

## Summary

Core sessions rotate their secret on touch with touchEvery: Duration.hours(1) (packages/core/src/Sessions.ts:74). Bearer-authenticated clients learn of the rotation only through the set-auth-token response header set here - and no package in the repo reads it: @awthaq/client has no transformResponse for it, and the header name appears nowhere outside this server module. A native client following the docs' Keychain recipe will keep presenting the stale token and start receiving 401s within an hour of active use, with no error distinguishing rotation from revocation.

## Evidence

Source: `packages/server/src/Authentication.ts:223`

```
      ).pipe(Effect.orDie)
    : Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
```

## Recommended fix

Ship a first-class client helper (transformResponse layer) that persists the set-auth-token value back to storage, and name/document the header in the client package's public surface.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-rotation-delivery`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:233`. Fix: Ship a first-class bearer-client contract: a shared header constant, a client-side token store, and a transform that attaches the bearer and captures rotations on every response. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
