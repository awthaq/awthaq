---
ID: "PIL-005"
Title: "Path-B-only routes discard secret rotation, forcing hourly re-logins"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Authentication.ts:186"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-005 — Path-B-only routes discard secret rotation, forcing hourly re-logins

`MEDIUM` · `dx` · `server` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **ready-for-agent**

## Summary

Sessions.verify rotates the secret at most once per touchEvery (1h default) and the old secret stops verifying immediately — no grace window. deliverRotation only runs inside AuthenticationLive/OptionalAuthenticationLive. SubjectExtractorLive (qadi Path B) is explicitly designed to run 'independent of Authentication's middleware pipeline', calls resolvePrincipal, and drops the rotated token. An app wired with only RequirePermission + SubjectExtractorLive for cookie-browser traffic therefore rotates every hour and never delivers the new cookie: every active user is force-logged-out on their next request. When both middlewares are wired the per-request memoization correctly hands the cached rotated token to Authentication's delivery step — the memoization fixes ordering, but only for that wiring.

## Evidence

Source: `packages/server/src/Authentication.ts:186`

```
* BEH-EA-153 requires exactly that reuse. Discards `rotated`: a caller with
* no response to deliver a rotated token through has nowhere to put it.
```

## Recommended fix

Either deliver rotation from Path B via the existing PostAuthResponseHook seam, or make rotation opt-in per caller (a verify option like rotate: boolean, true only from response-owning middleware), or shorten the blast radius by keeping the previous secret hash accepted for one request after rotation (single-use grace) — any of the three removes the silent-logout failure mode.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session fundamentals
- Full dossier: [`pilcrow`](../../.reports/pilcrow/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-rotation-delivery`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:202`. Fix: Deliver rotated secrets from inside the memoized verify via `HttpEffect.appendPreResponseHandler`, so every path delivers: Path A, Path B, and responses whose handler failed with a typed error. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
