---
ID: "FAMS-008"
Title: "Client SDK session model has no Firebase-style token surface or proactive refresh"
Level: low
Category: "dx"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:168"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-008 — Client SDK session model has no Firebase-style token surface or proactive refresh

`LOW` · `dx` · `client` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

Firebase's client SDK persists tokens in IndexedDB, auto-refreshes hourly, and exposes onAuthStateChanged/getIdToken. effect-auth's browser model is a server-set opaque session cookie plus reactive atoms: sessionAtom resolves null for anonymous callers (packages/react/src/AuthClientAtom.ts:45-80), and SessionStore is a plain in-memory Ref with SSR hydrate-first semantics — per-tab, no persistence, no refresh loop. Expiry is only discovered when a request 401s and the atom flips to null. This is a defensible design (the cookie is the persistence, sessions rotate server-side per touch), but clients migrating from Firebase patterns that call getToken() for APIs or render optimistic UI off auth-state callbacks need rework.

## Evidence

Source: `packages/client/src/AuthClient.ts:168`

```
Effect.gen(function* () {
  const state = yield* Ref.make(Option.none<Session>());
```

## Recommended fix

Document the session model mapping for Firebase migrants (cookie replaces IndexedDB tokens; atom subscriptions replace onAuthStateChanged; server rotation replaces client refresh) and consider a scheduled revalidation or 401-triggered atom invalidation so idle tabs learn about expiry before their next action.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-001` — CsrfProtection middleware is fully implemented but attached to zero served groups](high/CDS-001-csrf-defense-specialist.md) `_(csrf-defense-specialist, high)_`
- [`CDS-007` — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s](low/CDS-007-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`DESS-003` — toPromiseFacade silently discards the typed error channel](medium/DESS-003-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`DESS-009` — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated](info/DESS-009-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, info)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`MNA-006` — Client SDK assumes a browser cookie jar; no React Native story](medium/MNA-006-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, medium)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `react-client-atoms-factory`. Evidence at HEAD ec065a7: `packages/client/src/AuthClient.ts:165`. Fix: Add opt-out window-focus revalidation of the session/subject queries and document the session model for Firebase/token-SDK migrants. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Providers revalidateOnFocus (default on, opt-out): window focus / visibilitychange refreshes the session query (sessionAtom's refresh delegates to the raw query), so an idle tab learns about expiry; test 'window focus revalidates the session' + opt-out test. Deviation from the dossier: only the session query is refreshed, and subjectAtom's gate ignores sessionAtom.waiting, so guarded controls do not blink to pending on every focus (a session that turned out gone settles to signed-out and closes them). Session-model sections in both READMEs.
