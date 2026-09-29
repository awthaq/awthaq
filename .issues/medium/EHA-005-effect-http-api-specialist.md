---
ID: "EHA-005"
Title: "toPromiseFacade types away the shared error taxonomy at the Promise boundary"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "client"
Source: "packages/client/src/AuthClient.ts:189"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-005 — toPromiseFacade types away the shared error taxonomy at the Promise boundary

`MEDIUM` · `dx` · `client` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **ready-for-agent**

## Summary

PromiseFacade maps every client method to Promise<Effect.Success<...>>, asserting a never-rejecting promise, while the implementation runs Effect.runPromise (AuthClient.ts:222), which rejects with exactly the typed contract errors (Unauthenticated, SessionNotFound, RateLimited, ...) the whole contract stratum works to preserve. TypeScript cannot type-checked rejections, but silently declaring them impossible is worse than declaring unknown: a non-Effect consumer that trusts the signature will not handle InvalidCredentials or RateLimited at all, and the server's careful uniform-error design (identical 401s, anti-enumeration 404s) is invisible at this boundary.

## Evidence

Source: `packages/client/src/AuthClient.ts:189`

```
? (...args: Parameters<A>) => Promise<Effect.Success<ReturnType<A>>>
```

## Recommended fix

Return a discriminated result (e.g. Promise<Result<Success, SerializedError>> or {ok,value}|{ok:false,error} with the contract-derived ErrorCodes tag) from the facade, or at minimum document and type the rejection payload as the endpoint's error union so callers can switch on _tag.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-001` — CsrfProtection middleware is fully implemented but attached to zero served groups](high/CDS-001-csrf-defense-specialist.md) `_(csrf-defense-specialist, high)_`
- [`CDS-007` — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s](low/CDS-007-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`DESS-003` — toPromiseFacade silently discards the typed error channel](medium/DESS-003-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`DESS-009` — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated](info/DESS-009-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, info)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`MNA-006` — Client SDK assumes a browser cookie jar; no React Native story](medium/MNA-006-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, medium)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `client-promise-facade-errors`. Evidence at HEAD ec065a7: `packages/client/src/AuthClient.ts:188`. Fix: Keep the rejecting facade (documented) and add an error-honest `mode: "result"` variant whose methods resolve `Result<A, E>` with E the endpoint's contract error union. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
