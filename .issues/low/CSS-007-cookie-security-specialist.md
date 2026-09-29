---
ID: "CSS-007"
Title: "Session cookie name exists as two independent literals — aligned 'by construction, not by convention'"
Level: low
Category: "api"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:102"
Auditor: "cookie-security-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSS-007 — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'

`LOW` · `api` · `api` · reported by **Cookie Security Specialist** (`cookie-security-specialist`)

Status: **resolved**

## Summary

The auth scheme's expected cookie name (Api.ts:102) and the name every write site uses (Sessions.SESSION_COOKIE_NAME, core Sessions.ts:123) are separate literals because api cannot import core. Nothing fails if one changes: the Authentication cookie scheme would look for a cookie no endpoint ever sets, and sessions would authenticate only via bearer — a silent, total break of cookie auth that only the duplicated comment guards against. Wire tests compound the risk by hardcoding the literal '__Host-session=' in several suites instead of importing either constant.

## Evidence

Source: `packages/api/src/Api.ts:102`

```
 * shared — both are `"__Host-session"` by construction, not by convention).
 */
export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
```

## Recommended fix

Add one compile-time equality check in a package that imports both (server or test): a type-level assertion or a runtime expectEqual(Sessions.SESSION_COOKIE_NAME, Api.SessionCookie.key) in an existing suite, so a rename fails CI instead of silently severing cookie auth.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 58/100), domain: Cookie & Set-Cookie security
- Full dossier: [`cookie-security-specialist`](../../.reports/cookie-security-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `wire-constant-single-source`. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:97`. Fix: Make the session cookie name (and the rotation header name) one constant owned by the contract stratum, with core deriving from it. core (stratum 4) may depend on api (stratum 1). (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Api.SESSION_COOKIE_NAME and Api.ROTATED_TOKEN_HEADER are now the single definitions in packages/api/src/Api.ts (SessionCookie is keyed on the constant); core's Sessions.SESSION_COOKIE_NAME derives from Api.SESSION_COOKIE_NAME (new @awthaq/api dependency in packages/core/package.json; tsconfig reference already existed). Test: core/test/Sessions.test.ts BEH-EA-055 now asserts core === Api.SessionCookie.key (red until core imported api). Test-file literals left as intentional wire pins. Gates: typecheck, tests, bdd, spec:verify:strict, oxlint clean.
