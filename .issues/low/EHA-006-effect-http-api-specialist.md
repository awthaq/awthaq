---
ID: "EHA-006"
Title: "OptionalAuthentication advertises a 401 that its implementation can never produce"
Level: low
Category: "api"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:133"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-006 — OptionalAuthentication advertises a 401 that its implementation can never produce

`LOW` · `api` · `api` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **resolved**

## Summary

OptionalAuthentication declares error: Unauthenticated (Api.ts:138) purely because the per-scheme handler shape requires every entry in one security record to share one declared error type, and its server implementation always recovers to anonymousPrincipal (Authentication.ts:347-351) so the failure can never reach a caller. The generated OpenAPI/docs served via AuthHttp.docs therefore document a 401 response for OptionalAuthentication groups (e.g. GET /subject, oauth endpoints) that is unproduceable, misleading client generators and API consumers — the code comments acknowledge the trade-off but the wire contract still lies.

## Evidence

Source: `packages/api/src/Api.ts:133`

```
export class OptionalAuthentication extends HttpApiMiddleware.Service<
```

## Recommended fix

Give OptionalAuthentication a dedicated internal error type distinct from the public Unauthenticated (e.g. a phantom SchemeExhausted never surfaced), or annotate it out of the generated OpenAPI so docs match the actual behavior.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`OCM-003` — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable](medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `optional-auth-contract`. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:133`. Fix: Give OptionalAuthentication no error type, so the OpenAPI document stops advertising an impossible 401. The cookie handler resolves cookie, then bearer, then anonymous itself. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** api/Api.ts: OptionalAuthentication declares no error type (doc comment rewritten); server Authentication.ts OptionalAuthenticationLive: the cookie handler resolves cookie, then decodes the bearer via HttpApiBuilder.securityDecode(Api.BearerToken) and tries it, then defaults to anonymousPrincipal (E never); bearer kept for the record. Rotation delivery/PostAuthResponseHook stay on success paths. Tests (server/test/Authentication.test.ts): OpenAPI lists 401 for the Authentication endpoint and none for the OptionalAuthentication one (was red: 401 advertised); cookie->bearer->anonymous order incl. garbage cookie + valid bearer; existing BEH-EA-068 tests unchanged. Spec BEH-EA-068 paragraph.
