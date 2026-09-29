---
ID: "MW-009"
Title: "Cookie/CSRF names duplicated across strata by construction, not by convention"
Level: low
Category: "architecture"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:98"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-009 — Cookie/CSRF names duplicated across strata by construction, not by convention

`LOW` · `architecture` · `api` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **resolved**

## Summary

The comment is admirably honest: the session cookie name (and CSRF_COOKIE_NAME/CSRF_HEADER_NAME, Api.ts:106-107) exist as independent literals in @awthaq/api and @awthaq/core because of a one-directional import rule. If either side ever changes, nothing in the type system or a constant-mirror test notices — the failure mode is a browser that silently stops authenticating. The stratum rule is right; the duplication-without-enforcement is the scale risk.

## Evidence

Source: `packages/api/src/Api.ts:98`

```
* exactly (`api` cannot import `core`, so the literal is repeated here rather
 * than shared — both are `"__Host-session"` by construction, not by convention).
```

## Recommended fix

Keep the literals in the isomorphic @awthaq/api (the lower stratum) and have @awthaq/core reference them via a tiny shared constants module both may import, or add a contract test asserting the two literals are equal so drift fails CI.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`OCM-003` — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable](medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `wire-constant-single-source`. Duplicate of `CSS-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:97`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `CSS-007-cookie-security-specialist` — closed by its fix (see that issue's Resolved comment).
