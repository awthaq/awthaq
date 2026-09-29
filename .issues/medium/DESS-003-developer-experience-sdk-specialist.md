---
ID: "DESS-003"
Title: "toPromiseFacade silently discards the typed error channel"
Level: medium
Category: "dx"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:218"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-003 — toPromiseFacade silently discards the typed error channel

`MEDIUM` · `dx` · `client` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **resolved**

## Summary

PromiseFacade<A> types every client method as (...args) => Promise<Effect.Success<...>> (AuthClient.ts:188-192): the carefully-derived discriminated error union (the same one ErrorCodes publishes for i18n) becomes an untyped promise rejection for non-Effect consumers, who are exactly the audience this facade targets. A React consumer catching the rejection gets no _tag discrimination at the type level and no hint that Unauthenticated vs RateLimited (which carries retryAfterMillis) must be handled differently — the typed error surface the package advertises evaporates at the opt-in boundary.

## Evidence

Source: `packages/client/src/AuthClient.ts:218`

```
    return (...args: ReadonlyArray<unknown>) => Effect.runPromise(value(...args));
```

## Recommended fix

Offer an error-honest facade variant backed by Effect.runPromiseExit — e.g. Promise<Result<Success, E>> or a narrowed discriminated union — or at minimum document on toPromiseFacade that E collapses to unknown rejections and point Effect-averse consumers at ErrorCodes for a hand-rolled switch.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-001` — CsrfProtection middleware is fully implemented but attached to zero served groups](high/CDS-001-csrf-defense-specialist.md) `_(csrf-defense-specialist, high)_`
- [`CDS-007` — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s](low/CDS-007-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`DESS-009` — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated](info/DESS-009-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, info)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`MNA-006` — Client SDK assumes a browser cookie jar; no React Native story](medium/MNA-006-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, medium)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `client-promise-facade-errors`. Duplicate of `EHA-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/client/src/AuthClient.ts:218`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
