---
ID: "JR-007"
Title: "No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere"
Level: low
Category: "compliance"
Status: ready-for-agent
Package: "api"
Source: "packages/api/src/Api.ts:63"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-007 — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere

`LOW` · `compliance` · `api` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **ready-for-agent**

## Summary

Every authentication failure is a plain typed JSON 401; a grep for WWW-Authenticate/invalid_token/insufficient_scope across packages/ finds nothing. RFC 6750 §3 requires a Bearer challenge with error codes (invalid_request/invalid_token/insufficient_scope) when a bearer credential is presented and rejected, and RFC 7235 requires WWW-Authenticate with 401 generally. For the first-party typed-error protocol this is a defensible deviation (the contract documents statuses), and scope enforcement genuinely has no server-side surface yet — scope exists only as an inert claim on signJWT tokens (test: signJWT({ sub: 'service-a', scope: 'read:things' })). The gap becomes real the moment a downstream resource server built on verify.ts must signal token problems to generic HTTP clients.

## Evidence

Source: `packages/api/src/Api.ts:63`

```
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { httpApiStatus: 401 },
```

## Recommended fix

When a bearer credential was presented but failed, add a WWW-Authenticate: Bearer error="invalid_token" response header to the 401; if scope enforcement is ever added, map shortfalls to insufficient_scope. Keep the typed JSON body for first-party clients.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`OCM-003` — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable](medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `optional-auth-contract`. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:62`. Fix: Emit RFC 6750/7235 challenges on 401s from Authentication while keeping the typed JSON body. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
