---
ID: "EEM-003"
Title: "Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated"
Level: medium
Category: "api"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:175"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-003 — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated

`MEDIUM` · `api` · `server` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **resolved**

## Summary

Sessions.verify fails with SessionNotFound | SessionExpired | PlatformError.PlatformError (core/src/Sessions.ts:188). Uniformly answering invalid/expired credentials with 401 is intentional and correct; folding PlatformError (database down) into the same 401 is not — an infrastructure failure masquerades as an authentication outcome, so clients retry login against a dead backend and dashboards cannot distinguish an attack from an outage. The repo's own standard for the qadi path demands the opposite (BEH-EA-160: 'a resolver outage to 502... awthaq MUST NOT reinterpret'; feature REQ: 'A resolver outage is never collapsed into a 403 denial'), so the Authentication middleware is held to a weaker bar than the sibling bridge.

## Evidence

Source: `packages/server/src/Authentication.ts:175`

```
: sessions
            .verify(Redacted.make(raw))
            .pipe(Effect.mapError(() => new Api.Unauthenticated())),
```

## Recommended fix

catchTag('PlatformError', Effect.die) before the mapError (or fail a dedicated 503-class contract error) so only SessionNotFound|SessionExpired collapse into Unauthenticated, matching the qadi bridge's own outage posture.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-20):** Fixed together with the identical, higher-severity [`NHS-002`](../high/NHS-002-node-http-server-integration-specialist.md) (same source file, same evidence line, same recommended fix). `resolveSession` (`packages/server/src/Authentication.ts`) now runs `Effect.catchTag("PlatformError", Effect.die)` before `Effect.mapError(() => new Api.Unauthenticated())` — exactly this finding's own recommended fix, verbatim. See `NHS-002`'s resolution comment for full detail, including the qadi `SubjectExtractor.ts` propagation this also closes.
