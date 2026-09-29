---
ID: "MNA-006"
Title: "Client SDK assumes a browser cookie jar; no React Native story"
Level: medium
Category: "dx"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:77"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-006 — Client SDK assumes a browser cookie jar; no React Native story

`MEDIUM` · `dx` · `client` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **resolved**

## Summary

readCookie (feeding CsrfClientLive) degrades gracefully to undefined off-browser, but the whole cookie-mode model presumes document.cookie plus a fetch cookie jar - React Native's fetch persists no cookies across requests, so cookie mode is unviable there regardless. The package ships no storage-adapter seam (SessionStore exists but is an in-memory service for session list state, not a token store) and no RN guidance; combined with MNA-001 there is no working sign-in path for RN at all. The react package (Providers.tsx, AuthClientAtom.ts) is browser/SSR-shaped with the same gap.

## Evidence

Source: `packages/client/src/AuthClient.ts:77`

```
  const doc = Reflect.get(globalThis, "document");
  if (typeof doc !== "object" || doc === null) return undefined;
```

## Recommended fix

Document the React Native recipe explicitly (bearer mode + Keychain/Keystore adapter + transformClient), and expose a token-storage interface the generated client consults instead of ambient cookie state.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-001` — CsrfProtection middleware is fully implemented but attached to zero served groups](high/CDS-001-csrf-defense-specialist.md) `_(csrf-defense-specialist, high)_`
- [`CDS-007` — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s](low/CDS-007-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`DESS-003` — toPromiseFacade silently discards the typed error channel](medium/DESS-003-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`DESS-009` — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated](info/DESS-009-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, info)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `client-native-bearer-mode`. Evidence at HEAD ec065a7: `packages/client/src/AuthClient.ts:76`. Fix: Ship a client-side bearer mode: a pluggable token-store service, a transformClient that attaches it, and the request header that opts into ticket 17's body token delivery; document the React Native recipe. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Client bearer mode finished on top of P13's BearerTokenStore/bearerTransformClient (MNA-005): the transform now sends X-Awthaq-Token-Delivery: bearer (Api.TOKEN_DELIVERY_HEADER) on every request, which is what makes session-minting responses return the token in the body (MNA-001); new AuthClient.captureSessionToken(effect) stores the body token of a sign-in/passkey-verify/OAuth exchange in the ambient BearerTokenStore and returns the response unchanged (no token or empty token stores nothing; failures pass through). README: 'Getting the first token' + React Native / Expo recipe (Keychain/Keystore-backed TokenStore is the app's; CSRF bootstrap note; OAuth native flow). The dossier's 'pluggable token-store service' already existed as BearerTokenStore (kept, not renamed to TokenStore). Tests (packages/client/test/AuthClient.test.ts, 4 new): header on every request with/without a stored token; captureSessionToken stores then next request is authenticated; nothing stored without a token; failed sign-in untouched. Gates: typecheck 0, client tests 69 passed, package:smoke (README snippet import check), check:readmes.
