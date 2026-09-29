---
ID: "DESS-009"
Title: "CsrfClientLive's empty-string header fallback will produce opaque 403s when activated"
Level: info
Category: "dx"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:99"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-009 — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated

`INFO` · `dx` · `client` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **resolved**

## Summary

When the CSRF cookie is absent (first visit, or a httpOnly-set csrf cookie document.cookie cannot read), CsrfClientLive sends header x-csrf-token: '' rather than omitting it, and the consumer's first mutating request fails with the contract's bare CsrfRejected 403 (packages/api/src/Api.ts:70-74) — no hint that the cookie was missing or that a bootstrap endpoint must set it first. Today this is dormant (no group in the repo declares CsrfProtection middleware — AuthClient.ts:27-35), which is why this is info, but the moment a plugin adopts CSRF this becomes the #1 support question. A readCookie docs note does document browser-only behavior, which helps.

## Evidence

Source: `packages/client/src/AuthClient.ts:99`

```
        readCookie(Api.CSRF_COOKIE_NAME) ?? "",
```

## Recommended fix

When wiring the first CsrfProtection-carrying contract: omit the header when the cookie is absent (a missing header should read as 'no token yet', not 'invalid token'), and document the bootstrap flow (which endpoint sets __Host-csrf) directly on CsrfClientLive.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-001` — CsrfProtection middleware is fully implemented but attached to zero served groups](high/CDS-001-csrf-defense-specialist.md) `_(csrf-defense-specialist, high)_`
- [`CDS-007` — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s](low/CDS-007-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`DESS-003` — toPromiseFacade silently discards the typed error channel](medium/DESS-003-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`MNA-006` — Client SDK assumes a browser cookie jar; no React Native story](medium/MNA-006-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, medium)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `csrf-client-bootstrap`. Duplicate of `CDS-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/client/src/AuthClient.ts:99`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
