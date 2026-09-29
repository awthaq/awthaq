---
ID: "CTA-006"
Title: "Token rotation reaches native clients only as a response header no client captures"
Level: medium
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:202"
Auditor: "cli-tool-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CTA-006 — Token rotation reaches native clients only as a response header no client captures

`MEDIUM` · `correctness` · `server` · reported by **CLI Tool Auth Specialist** (`cli-tool-auth-specialist`)

Status: **resolved**

## Summary

For long-lived CLI sessions, the only refresh mechanism is the throttled idle refresh in packages/core/src/Sessions.ts (at most one write per touchEvery, rotating the secret on the same write) plus this set-auth-token delivery header. That contract is lossy by construction for a CLI: if a command fails to read the header and persist the new secret, the stored credential is stale after the next rotation (Sessions.ts:161 verifies immediately, no grace window), locking the user out. The @awthaq/client SessionStore (packages/client/src/AuthClient.ts:149-151) overwrites only on explicit sign-in/sign-out/refresh and implements no capture-on-every-response behavior, and the 7-day idle default (Sessions.ts:73) means a weekly-used CLI hits idle expiry with no specified re-auth UX.

## Evidence

Source: `packages/server/src/Authentication.ts:202`

```
`bearer` gets a `set-auth-token` response header, upstream's
 * own mechanism and the only way a bearer client (presenting the raw
 * secret directly, not through a plugin like `@awthaq/jwt`) can learn its
```

## Recommended fix

Specify bearer-client rotation capture as a client-side contract (persist set-auth-token on every response that carries it, via the same transformResponse hook the keychain intention uses), and define the re-auth prompt UX for idle-expired CLI sessions, including a machine-readable signal (exit code or typed error) so scripts can distinguish 're-authenticate' from other failures.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 32/100), domain: CLI Authentication
- Full dossier: [`cli-tool-auth-specialist`](../../.reports/cli-tool-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-rotation-delivery`. Duplicate of `MNA-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:233`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MNA-005-mobile-native-auth-specialist` — closed by its fix (see that issue's Resolved comment).
