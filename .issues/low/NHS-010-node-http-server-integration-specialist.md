---
ID: "NHS-010"
Title: "Auth strategy order is encoded as security-record key order in two synced places"
Level: low
Category: "api"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:111"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-010 — Auth strategy order is encoded as security-record key order in two synced places

`LOW` · `api` · `api` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

Cookie-before-bearer is behavioral, not metadata: it lives in the key order of the security record in Api.ts's declaration and again in the { cookie, bearer } record AuthenticationLive/OptionalAuthenticationLive return (Authentication.ts:290, 357). A test does pin the behavior (Authentication.test.ts:141 exercises an invalid bearer not blocking a valid cookie), but the invariant itself is represented by object key order in two places that must stay in sync; a key-normalizing codemod or a refactor to alphabetical ordering changes the credential strategy chain with no compiler complaint.

## Evidence

Source: `packages/api/src/Api.ts:111`

```
 * BEH-EA-028/065/072: cookie is tried before bearer because it is declared
 * first — the record's own key order is the entire strategy chain.
```

## Recommended fix

Keep the behavior test, but make the order explicit and structural — e.g. an ordered tuple/scheme list on the middleware declaration that both the contract and the Live layers derive from — so reordering is a deliberate diff, not a key-order accident.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`OCM-003` — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable](medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `optional-auth-contract`. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:110`. Fix: Remove the one real positional coupling (OptionalAuthentication's fallback hard-wired to the last-declared `bearer` key) and pin the order with a wired test. Ordering stays the security record's declaration order, as BEH-EA-072 requires. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Covered by EHA-006's restructure (the anonymous fallback lives in the first handler and no longer depends on bearer being declared last); comments in Api.ts/Authentication.ts now say only the declaration's key order matters (Effect looks Live handlers up by key). Test: server Authentication.test.ts pins Object.keys(security) of both middlewares to [cookie, bearer]; the @skip BDD scenario for the ordering was not wired (unit test used instead, per the dossier's alternative). Spec BEH-EA-072 note.
