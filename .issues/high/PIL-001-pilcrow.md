---
ID: "PIL-001"
Title: "Finished CSRF middleware is attached to zero endpoints"
Level: high
Category: "security"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:29"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-001 — Finished CSRF middleware is attached to zero endpoints

`HIGH` · `security` · `client` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **resolved**

## Summary

The server ships a complete, spec-mandated CSRF implementation (Sec-Fetch-Site primary, Origin fallback, signed double-submit __Host-csrf cookie, BEH-EA-073-080), a typed 403 error, and even the client-side CsrfClientLive layer that echoes the cookie into x-csrf-token — but no HttpApiGroup anywhere declares the middleware, so every state-changing endpoint (signOut, revoke, revokeOthers, revokeAll, changePassword, passkey authenticate, revoke-all) runs with no CSRF check on the serving path. Only SameSite=Strict and the __Host- prefix remain, which is one layer of the three-layer design the spec itself says compose ('backs, not replaces'). SameSite=Strict does not defend against same-site (subdomain) origins, where the session cookie is still sent and Sec-Fetch-Site reads same-site.

## Evidence

Source: `packages/client/src/AuthClient.ts:29`

```
No plugin's `HttpApiGroup` in this repository currently
declares `.middleware(Api.CsrfProtection)` at all — `Password`/`OAuth`/the
core `session` group all use `Authentication`/`OptionalAuthentication` only
```

## Recommended fix

Attach Api.CsrfProtection to the session, account, password, passkey, and any other cookie-authenticated mutating groups (an .addMiddleware at the AuthCoreApi level, or per-group .middleware(Api.CsrfProtection)); add one contract test asserting every endpoint carrying cookie Authentication also carries CsrfProtection so the wiring can never regress to zero again.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session fundamentals
- Full dossier: [`pilcrow`](../../.reports/pilcrow/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — same underlying gap as PDR-002/CDS-001/APS-001; `packages/client/src/AuthClient.ts:27-31` matches the evidence, and a repo-wide grep confirms no `HttpApiGroup` anywhere calls `.middleware(Api.CsrfProtection)`, only declarations and the two `Csrf.ts`/`AuthClient.ts` implementations. Fix (attach the middleware to cookie-authenticated mutating groups) is mechanical. Status → ready-for-agent.

**Resolved (2026-09-19):** `Api.CsrfProtection` attached to every mutating production `HttpApiGroup` (core `SessionGroup`/`AccountGroup`, `AdminGroup`, `OrganizationGroup`, `PasskeyGroup`/`PasskeyAuthenticateGroup`/`PasskeyCredentialsGroup`, `PasswordGroup`), declared last in each chain so it runs outermost/first (rejects a forgery before `Authentication` does any credential work). `OAuthGroup`/`JwtApi`/`SubjectApi` deliberately left alone — GET-only, CSRF exempt by construction (BEH-EA-077). This made `Api.CsrfProtection` a real compile-time requirement on every plugin's own `.layer` (not just its HTTP-serving path), so `CsrfProtectionLive` was also wired into 4 BDD world files and 13 unit/wire-level test files across admin/jwt/organization/passkey/password/server, each verified with both a real `tsc` typecheck and an actual `vitest run` (not just types) — several caught real runtime consequences, e.g. `packages/server/test/AuthHttp.test.ts`'s unauthenticated-401 test needed a valid CSRF pair too, since CSRF now runs before Authentication and would otherwise return 403 first. Full monorepo `pnpm run typecheck` and every real test suite (excluding pre-existing empty ones) pass. Status → resolved.
