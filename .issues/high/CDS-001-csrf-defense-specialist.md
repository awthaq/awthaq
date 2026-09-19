---
ID: "CDS-001"
Title: "CsrfProtection middleware is fully implemented but attached to zero served groups"
Level: high
Category: "security"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:29"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-001 — CsrfProtection middleware is fully implemented but attached to zero served groups

`HIGH` · `security` · `client` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

Every state-changing endpoint — POST /session/sign-out, /session/revoke, /session/revoke-others, /session/revoke-all (packages/api/src/Session.ts:45-58), POST /change-password (packages/password/src/PasswordApi.ts:212-216), DELETE /user (packages/api/src/Account.ts:34-35), and every organization/admin write — carries Authentication middleware only. My grep over packages/** for `.middleware(` confirms every production attachment is Authentication/OptionalAuthentication/AuthorizedSubject; the only CsrfProtection attachments live in two synthetic test groups (packages/server/test/Csrf.test.ts:52, packages/client/test/Csrf.test.ts:25). The sole live defense on cookie-authenticated mutations is therefore the browser's SameSite=Strict enforcement of __Host-session — which fails for clients without SameSite support, and which does nothing against a same-site attacker page (Strict cookies are sent on same-site requests). This is precisely the red flag the hiring rubric rejects: SameSite-only protection for auth-mutating endpoints, despite a finished 188-line defense waiting in packages/server/src/Csrf.ts.

## Evidence

Source: `packages/client/src/AuthClient.ts:29`

```
// declares `.middleware(Api.CsrfProtection)` at all — `Password`/`OAuth`/the
// core `session` group all use `Authentication`/`OptionalAuthentication`
// only
```

## Recommended fix

Attach .middleware(Api.CsrfProtection) at group level beside Authentication on every cookie-authenticated mutating group (core session/account, password, passkey, jwt, admin, organization), provide CsrfProtectionLive + CsrfConfig in the serving examples, and add a contract test that fails whenever a group declares Authentication but no CsrfProtection while any endpoint is a mutating cookie-carried operation.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-007` — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s](low/CDS-007-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`DESS-003` — toPromiseFacade silently discards the typed error channel](medium/DESS-003-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`DESS-009` — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated](info/DESS-009-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, info)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`MNA-006` — Client SDK assumes a browser cookie jar; no React Native story](medium/MNA-006-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, medium)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `grep -rn "\.middleware(" packages/*/src` shows every real API group (`packages/admin/src/AdminApi.ts:111`, `packages/api/src/Account.ts:35`, `packages/api/src/Session.ts:59`, `packages/jwt/src/JwtApi.ts:49`, `packages/organization/src/OrganizationApi.ts:710`, `packages/passkey/src/PasskeyApi.ts:225,263`, `packages/password/src/PasswordApi.ts:216`) attaches only `Api.Authentication`/`Api.OptionalAuthentication`; `CsrfProtection` appears only in `packages/server/src/Csrf.ts` (the implementation), `packages/api/src/Api.ts` (the declaration), and the two test files cited. Attaching the existing middleware at group level is mechanical. Status → ready-for-agent.

**Resolved (2026-09-19):** `Api.CsrfProtection` attached to every mutating production `HttpApiGroup` (core `SessionGroup`/`AccountGroup`, `AdminGroup`, `OrganizationGroup`, `PasskeyGroup`/`PasskeyAuthenticateGroup`/`PasskeyCredentialsGroup`, `PasswordGroup`), declared last in each chain so it runs outermost/first (rejects a forgery before `Authentication` does any credential work). `OAuthGroup`/`JwtApi`/`SubjectApi` deliberately left alone — GET-only, CSRF exempt by construction (BEH-EA-077). This made `Api.CsrfProtection` a real compile-time requirement on every plugin's own `.layer` (not just its HTTP-serving path), so `CsrfProtectionLive` was also wired into 4 BDD world files and 13 unit/wire-level test files across admin/jwt/organization/passkey/password/server, each verified with both a real `tsc` typecheck and an actual `vitest run` (not just types) — several caught real runtime consequences, e.g. `packages/server/test/AuthHttp.test.ts`'s unauthenticated-401 test needed a valid CSRF pair too, since CSRF now runs before Authentication and would otherwise return 403 first. Full monorepo `pnpm run typecheck` and every real test suite (excluding pre-existing empty ones) pass. Status → resolved.
