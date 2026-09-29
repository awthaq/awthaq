---
ID: "PDR-002"
Title: "CsrfProtection is fully implemented and tested but attached to zero groups — CSRF layer is dormant"
Level: high
Category: "security"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:28"
Auditor: "philippe-de-ryck"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PDR-002 — CsrfProtection is fully implemented and tested but attached to zero groups — CSRF layer is dormant

`HIGH` · `security` · `client` · reported by **Philippe De Ryck — Web Application Security Trainer** (`philippe-de-ryck`)

Status: **resolved**

## Summary

The repo ships a correct, modern CSRF control (Csrf.ts: Sec-Fetch-Site primary, Origin fallback, signed double-submit __Host-csrf with constant-time compares, unsafe-methods-only) plus a type-enforced client half (requiredForClient: true, CsrfClientLive), and spec 10-csrf.md states it as a series of MUST requirements — yet no real HttpApiGroup declares the middleware (grep of .middleware( confirms: only Authentication/OptionalAuthentication on all real groups; CsrfProtection appears solely in synthetic tests). Because the middleware never runs, securitySetCookie never mints the __Host-csrf cookie, so the protocol is not merely unenforced, it is unreachable. Every cookie-authenticated state-changing endpoint — POST /change-password, POST /session/revoke-all, DELETE /user, organization mutations, admin impersonation, passkey delete — is protected against CSRF solely by the session cookie's SameSite=Strict. SameSite=Strict is a strong primary control in mainstream browsers, but the designed second layer (origin check + double-submit) exists precisely to back it, and webviews/non-browser agents with inconsistent SameSite handling get no protection at all. The codebase's own client package documents the gap in a comment, confirming it is known but unshipped.

## Evidence

Source: `packages/client/src/AuthClient.ts:28`

```
// against yet.** No plugin's `HttpApiGroup` in this repository currently
// declares `.middleware(Api.CsrfProtection)` at all — `Password`/`OAuth`/the
// core `session` group all use `Authentication`/`OptionalAuthentication`
```

## Recommended fix

Attach Api.CsrfProtection to every group that exposes POST/PUT/PATCH/DELETE endpoints (core session, password, organization, admin, passkey, api-key when it lands), provide Csrf.CsrfProtectionLive with a production secret in server composition, and add a composition-level invariant test asserting any group with an unsafe-method endpoint carries the middleware — the same discipline BEH-EA-076 already applies to the client side.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Web attack surface
- Full dossier: [`philippe-de-ryck`](../../.reports/philippe-de-ryck/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/client/src/AuthClient.ts:27-31` matches the evidence, and a repo-wide grep for `CsrfProtection` outside `node_modules`/tests finds only the declaration in `packages/api/src/Api.ts`, its `CsrfProtectionLive` implementation in `packages/server/src/Csrf.ts`, and the client-side `CsrfClientLive` — no `HttpApiGroup` anywhere calls `.middleware(Api.CsrfProtection)`. Fix (attach the middleware to mutating groups, following the existing `Authentication` wiring pattern) is mechanical. Status → ready-for-agent.

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `csrf-client-bootstrap`. Already fixed by commit 409334e. Evidence at HEAD ec065a7: `packages/api/src/Session.ts:59`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
