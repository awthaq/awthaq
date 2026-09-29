---
ID: "VB-008"
Title: "Bearer scheme consumes raw session secrets; minted JWTs have no in-repo consumer"
Level: info
Category: "api"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:118"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-008 — Bearer scheme consumes raw session secrets; minted JWTs have no in-repo consumer

`INFO` · `api` · `api` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

Both Authentication schemes funnel the presented credential into Sessions.verify (packages/server/src/Authentication.ts:252; qadi's SubjectExtractor.ts:78 repeats it for Path B), so the bearer channel carries opaque session secrets and a client that echoes the mirrored x-jwt-token back as Authorization: Bearer fails Unauthenticated — the token is export-only, consumed by downstream services via the standalone lite verifier. This is a coherent, documented strategy (stateless verification where the session store is unreachable), but it is stated nowhere user-facing, the api-key plugin is an empty placeholder (packages/api-key/src/index.ts) so no scoped machine credential exists at all, and ApiKey/Service principals have no scopes field to authorize with (packages/qadi/src/SubjectResolver.ts:26-39, fail-closed deny).

## Evidence

Source: `packages/api/src/Api.ts:118`

```
security: { cookie: SessionCookie, bearer: BearerToken },
```

## Recommended fix

Document explicitly that this server never accepts its own minted JWTs on any scheme; when M7 lands, give api keys real scopes that qadi can resolve rather than identity-only subjects.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bearer-credential-extensibility`. Duplicate of `MAPS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:110`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
