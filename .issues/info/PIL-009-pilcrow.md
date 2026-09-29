---
ID: "PIL-009"
Title: "Bearer rotation has no catch-up path for clients that miss the header"
Level: info
Category: "api"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:223"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-009 — Bearer rotation has no catch-up path for clients that miss the header

`INFO` · `api` · `server` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **resolved**

## Summary

For bearer-authenticated callers, rotation is delivered only via the non-standard set-auth-token response header, and the old secret stops verifying in the same atomic write — no grace window. A non-browser client that proxies, buffers, or drops unknown headers (or a response lost mid-flight) is permanently logged out at the next touch boundary, once per hour of activity. This is a documented, deliberate tradeoff rather than an oversight, and it is the honest cost of rotation-without-grace; flagging it so the operational consequence is a known decision, not a surprise incident report.

## Evidence

Source: `packages/server/src/Authentication.ts:223`

```
: Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
```

## Recommended fix

Document set-auth-token as a mandatory-to-preserve header for bearer clients in the integration docs, or add the single-request grace window from PIL-005's recommendation, which fixes both the bearer and Path-B variants of this failure mode.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-rotation-delivery`. Duplicate of `MNA-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:233`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MNA-005-mobile-native-auth-specialist` — closed by its fix (see that issue's Resolved comment).
