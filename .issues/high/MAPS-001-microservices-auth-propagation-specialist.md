---
ID: "MAPS-001"
Title: "Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens"
Level: high
Category: "architecture"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:288"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-001 — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens

`HIGH` · `architecture` · `server` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

Both edge schemes funnel into resolveSession -> Sessions.verify, which parses the credential as an opaque id.secret pair (packages/core/src/Sessions.ts:263 splits on the first '.'). A minted JWT therefore always fails at the edge: its header segment is treated as a session id and lookup fails as Unauthenticated. The result is a one-way trust topology - the edge can mint propagation tokens for downstream services, but any downstream service (or mesh sidecar) presenting that verified identity back to the awthaq API gets a 401. There is exactly one credential that works everywhere: the raw long-lived session token, which is precisely the propagation anti-pattern (30-day absolute TTL secret fanned out to every hop) this architecture should prevent.

## Evidence

Source: `packages/server/src/Authentication.ts:288`

```
const bearer: typeof handle = (httpEffect, { credential }) =>
      authenticate("bearer", httpEffect, credential);
```

## Recommended fix

Either (a) add a plugin-registered security scheme so Authentication tries session token first and a configured Jwt verifier second (mapping verified claims to a Principal without a store hit), or (b) document explicitly that awthaq is a terminal authenticator and downstream services must never forward identity back - and enforce it by binding the minted token to a downstream-only audience.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `Authentication.ts:288-289` matches the evidence verbatim; both `cookie` and `bearer` handlers funnel into the same `authenticate`/`resolveSession` path, and `Sessions.ts`'s `verify` (~line 260) splits the credential on its first `.` as an opaque `id.secret` pair, so a JWT would fail lookup. No JWT-based `HttpApiSecurity` scheme is registered anywhere (`grep HttpApiSecurity packages/jwt/src/*.ts` is empty), confirming there's no second bearer verification path. Fixing this (adding a JWT-verifying security scheme or formally declaring awthaq a terminal authenticator) is a genuine architecture/trust-boundary decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Stateless JWT-as-bearer session strategy](../../.scratch/resolve-ready-for-human-findings/issues/33-stateless-jwt-session-strategy.md) — adds an optional `Authentication.BearerCredentialResolver` extension point (same pattern as `PostAuthResponseHook`) that `@awthaq/jwt` wires only when a new `JwtConfig.acceptAsBearer` flag is enabled, routing bearer credentials shaped like a JWT (3 dot-separated segments) to a stateless `jwt.verify` check instead of `Sessions.verify`, with audience scoping (`signJWT({ audience })`) letting downstream-only propagation tokens be minted that are rejected by construction if presented back as bearer. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bearer-credential-extensibility`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:299`. Fix: Implement decision 33 (stateless JWT-as-bearer): an optional `BearerCredentialResolver` seam in Authentication, opted into by @awthaq/jwt via JwtConfig.acceptAsBearer, with audience scoping for downstream-only tokens. (effort L). Full dossier: `.plan/slices/06-server-api.md`.

**Resolved (2026-09-29):** Bearer-credential seam in @awthaq/server/src/Authentication.ts, implemented as the ADR-EA-012 registry (Decision (2026-09-29): adopted recommended option (a) of MAPS-004 per plan; user may revisit): CredentialResolvers service + CredentialResolversLive, Authentication.contribute(carrier, {id, order?, claims, resolve}), resolveClaimed; bearer handler offers the credential to contributions first (first claiming contribution wins; a claimed failure is Unauthenticated, later contributions not tried), unclaimed bearer falls back to Sessions.verify; claimed principals skip rotation but still run PostAuthResponseHook (scheme bearer|apiKey). Registry read per request via Effect.serviceOption so AuthenticationLive R is unchanged. resolvePrincipal (qadi Path B) uses the same path; qadi extractor also reads x-api-key. Tests: packages/server/test/CredentialResolvers.test.ts (13), packages/jwt/test/BearerReentry.test.ts, packages/qadi/test/SubjectExtractor.test.ts. BEH-EA-065/066/072 amended (rev 1.2). Gates green.
