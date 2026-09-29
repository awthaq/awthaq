---
ID: "BE-009"
Title: "Session cookie name duplicated as literals across the api/core stratum boundary"
Level: low
Category: "dx"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:99"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-009 — Session cookie name duplicated as literals across the api/core stratum boundary

`LOW` · `dx` · `api` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

The duplication is honest about the stratum constraint (api must stay isomorphic, core must not leak downward), but two independently maintained literals — this one and Sessions.SESSION_COOKIE_NAME in packages/core/src/Sessions.ts:123 — can drift silently, and a drifted cookie name breaks authentication in a way types cannot catch across the boundary. better-auth centralizes its cookie naming; effect-auth should make the lockstep mechanical rather than aspirational.

## Evidence

Source: `packages/api/src/Api.ts:99`

```
 * exactly (`api` cannot import `core`, so the literal is repeated here rather
 * than shared — both are `"__Host-session"` by construction, not by convention).
```

## Recommended fix

Add a tiny zero-dependency shared-constants module both strata import, or a CI assertion that greps the two literals for equality; the plugin manifest already demonstrates cross-package declarative metadata is feasible here.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`OCM-003` — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable](medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `wire-constant-single-source`. Duplicate of `CSS-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:97`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
