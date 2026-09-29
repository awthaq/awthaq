---
ID: "AGA-006"
Title: "No trusted-header identity seam exists — correctly so for this architecture"
Level: info
Category: "architecture"
Status: needs-triage
Package: "server"
Source: "packages/server/src/Authentication.ts:283"
Auditor: "api-gateway-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AGA-006 — No trusted-header identity seam exists — correctly so for this architecture

`INFO` · `architecture` · `server` · reported by **API Gateway Auth Specialist** (`api-gateway-auth-specialist`)

Status: **needs-triage**

## Summary

The middleware's security-scheme record contains exactly cookie and bearer; no X-Auth-Subject/X-Auth-Claims-style header is read anywhere (grep for forwarded/proxy/identity headers returns nothing), and every credential — regardless of scheme — resolves through Sessions.verify into a Principal, with authorization delegated to qadi downstream. This is exactly the correct posture: a header-based identity contract without a locked-down internal network is trivially spoofable by any caller that can reach a backend service directly, and absorbing authorization into a gateway would collapse effect-auth's authentication/qadi separation. The observation for the dashboard: the library neither implements nor documents the gateway-forwarding topology (signed internal context, mTLS-bound headers), so teams wanting it must build it themselves — its absence is a strength today and a documented gap for tomorrow.

## Evidence

Source: `packages/server/src/Authentication.ts:283`

```
{ readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
```

## Recommended fix

Keep the seam closed. If gateway forwarding is ever added, require a signed, audience-scoped internal token (or mTLS channel binding) rather than raw headers, and keep qadi as the sole authorization point on both sides of the hop.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Gateway deployment posture
- Full dossier: [`api-gateway-auth-specialist`](../../.reports/api-gateway-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `none`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:299`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/06-server-api.md`.
