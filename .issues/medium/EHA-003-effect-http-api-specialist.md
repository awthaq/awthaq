---
ID: "EHA-003"
Title: "CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code"
Level: medium
Category: "security"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:29"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-003 — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code

`MEDIUM` · `security` · `client` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **resolved**

## Summary

The framework's own CSRF behavior (BEH-EA-073..080) is fully implemented — signed double-submit cookie, Sec-Fetch-Site/Origin site check, UNSAFE_METHODS gate — and both server (CsrfProtectionLive) and client (CsrfClientLive) sides are tested, yet every group declaration in the repository attaches only Authentication/OptionalAuthentication (session, account, admin, organization, passkey x3, oauth, password, jwt x2). Every cookie-session-authenticated mutating endpoint — POST /session/sign-out, POST /session/revoke, PATCH/DELETE /user, POST /password/change — ships without the double-submit check unless an application author remembers to attach it per group. The session cookie's SameSite=strict (packages/core/src/Sessions.ts:127) blocks classic cross-site carries in modern browsers, but same-site subdomain attackers and non-browser edge cases have only the site check as defense-in-depth, and the client's BEH-EA-171 `{csrf:false}` variant has nothing to toggle. A security middleware that exists, works, and is wired nowhere is a compliance gap against the framework's own spec.

## Evidence

Source: `packages/client/src/AuthClient.ts:29`

```
// declares `.middleware(Api.CsrfProtection)` at all — `Password`/`OAuth`/the
```

## Recommended fix

Attach .middleware(Api.CsrfProtection) to every group carrying cookie-session-authenticated mutating endpoints (session, account, password, passkey, organization, admin), or provide a composition-level default in AuthHttp/Auth.make that installs CsrfProtection on all unsafe-method endpoints unless opted out.

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
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`MNA-006` — Client SDK assumes a browser cookie jar; no React Native story](medium/MNA-006-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, medium)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `csrf-client-bootstrap`. Already fixed by commit 409334e. Evidence at HEAD ec065a7: `packages/api/src/Account.ts:35`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
