---
ID: "CDS-007"
Title: "CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s"
Level: low
Category: "dx"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:99"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-007 — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s

`LOW` · `dx` · `client` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

On a first visit (or any moment document.cookie cannot see __Host-csrf), the client sends x-csrf-token: "" instead of omitting the header. Server-side, the middleware responds by minting a fresh cookie (Csrf.ts:153-160 — note it sets the cookie even on the request it is about to reject) and then fails the unsafe request with the bare CsrfRejected 403 (Csrf.ts:174-181). A retry after the 403 therefore succeeds, but nothing in the error or the client tells the developer that a bootstrap round trip is required. This is dormant today only because no contract carries the middleware (CDS-001); it becomes the first thing every consumer hits the moment attachment lands.

## Evidence

Source: `packages/client/src/AuthClient.ts:99`

```
readCookie(Api.CSRF_COOKIE_NAME) ?? "",
```

## Recommended fix

Omit the header when readCookie returns undefined (a missing header should read as no-token-yet, not invalid-token), and document the bootstrap flow — which response sets the cookie and why the first unsafe call may 403 — directly on CsrfClientLive.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-001` — CsrfProtection middleware is fully implemented but attached to zero served groups](high/CDS-001-csrf-defense-specialist.md) `_(csrf-defense-specialist, high)_`
- [`DESS-003` — toPromiseFacade silently discards the typed error channel](medium/DESS-003-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`DESS-009` — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated](info/DESS-009-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, info)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`MNA-006` — Client SDK assumes a browser cookie jar; no React Native story](medium/MNA-006-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, medium)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `csrf-client-bootstrap`. Evidence at HEAD ec065a7: `packages/client/src/AuthClient.ts:93`. Fix: Make CsrfClientLive self-bootstrapping: omit the header when no cookie is readable, and on a CsrfRejected response retry exactly once after the 403's Set-Cookie has landed; document the flow. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** AuthClient.csrfClientLayer({readCookie, bootstrapRetry}) (CsrfClientLive = csrfClientLayer()): omits x-csrf-token when no/empty cookie; on a 403 whose body _tag is CsrfRejected, retries exactly once if a cookie not carried by the rejected request is now readable. Stale 'no group declares CsrfProtection' comments removed (AuthClient.ts header, index.ts, AuthClient.test.ts); BEH-EA-170 implementation note + traceability row. Tests: Csrf.test.ts (7 runtime scenarios via scripted HttpClient) + react ReactClient cold-start test. Red reasoning: old layer sent an empty header and never retried.
