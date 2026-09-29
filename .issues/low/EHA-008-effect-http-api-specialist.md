---
ID: "EHA-008"
Title: "Security-critical cookie name duplicated as independent literals between api and core"
Level: low
Category: "security"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:102"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-008 — Security-critical cookie name duplicated as independent literals between api and core

`LOW` · `security` · `api` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **resolved**

## Summary

The api stratum repeats the session cookie name as the literal "__Host-session" because it cannot import @awthaq/core (Api.ts:98-101 admits the two match 'by construction, not by convention'); the same duplication applies to the CSRF cookie/header names against the server implementation. If core's SESSION_COOKIE_NAME (packages/core/src/Sessions.ts:123) ever changes, the api security scheme — and therefore the middleware's credential decoding and the OpenAPI document — would silently reference a different cookie than the one Set-Cookie actually writes, breaking every browser session with no type error anywhere.

## Evidence

Source: `packages/api/src/Api.ts:102`

```
export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
```

## Recommended fix

Move the wire-constant literals into a dependency-free leaf module (or a shared const package both strata can import) and re-export from both; alternatively add a type-level test asserting core's SESSION_COOKIE_NAME equals Api's literal so drift fails typecheck.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`OCM-003` — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable](medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `wire-constant-single-source`. Duplicate of `CSS-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:97`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `CSS-007-cookie-security-specialist` — closed by its fix (see that issue's Resolved comment).
