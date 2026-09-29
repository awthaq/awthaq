---
ID: "OCM-003"
Title: "M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable"
Level: medium
Category: "architecture"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:27"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-003 — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable

`MEDIUM` · `architecture` · `api` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **resolved**

## Summary

ApiKeyPrincipal and ServicePrincipal carry only a PrincipalRef. qadi's SubjectResolver.ts documents (lines 26-39) that BEH-EA-140/141 (scopes become permissions) are therefore not implemented, and the default resolver deliberately refuses to invent a scopes field with no producer. The fail-closed consequence is correct — every permission check against an ApiKey/Service subject denies — but it means that even once a credential exists, a plugin must also grow the union and override the resolver before any machine authorization works.

## Evidence

Source: `packages/api/src/Api.ts:27`

```
export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
  ref: PrincipalRef,
}) {}
```

## Recommended fix

When the api-key plugin lands, add a scopes array to both M2M principal variants and ship a plugin-side SubjectResolver override that maps scopes to AuthSubject.permissions (id 'apikey:<keyId>'), keeping the spec's division: the plugin mints scoped principals, qadi's resolver slot turns scopes into permissions.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: M2M authentication
- Full dossier: [`oauth2-client-credentials-m2m-specialist`](../../.reports/oauth2-client-credentials-m2m-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `m2m-identity`. Duplicate of `MAPS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:27`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
