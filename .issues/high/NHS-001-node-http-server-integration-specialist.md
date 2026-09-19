---
ID: "NHS-001"
Title: "CSRF middleware is implemented but attached to no production endpoint"
Level: high
Category: "security"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:29"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-001 — CSRF middleware is implemented but attached to no production endpoint

`HIGH` · `security` · `client` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

packages/server/src/Csrf.ts ships a complete CsrfProtectionLive (Sec-Fetch-Site check, Origin fallback, signed double-submit __Host-csrf cookie, constant-time compare) and Behavior 10 specifies it, but the only group that declares the middleware is a synthetic fixture in packages/server/test/Csrf.test.ts:24-26. Every mutating production endpoint — POST /password/sign-in, /password/confirm-reset, /session/revoke, DELETE /user — runs with no CSRF check, relying solely on the __Host-/SameSite=strict cookie attributes; login-CSRF and revocation-CSRF remain viable against browsers or embedders that weaken SameSite enforcement, and the protection layer is dead code in every shipped composition.

## Evidence

Source: `packages/client/src/AuthClient.ts:29`

```
No plugin's `HttpApiGroup` in this repository currently
declares `.middleware(Api.CsrfProtection)` at all — `Password`/`OAuth`/the
core `session` group all use `Authentication`/`OptionalAuthentication`
```

## Recommended fix

Declare .middleware(Api.CsrfProtection) on the unsafe-method, cookie-authenticated groups (password, session, account) or install it as a composition default in Auth.make; add a wire test asserting a cross-site POST without the x-csrf-token echo fails 403 through the real router.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — evidence quote matches packages/client/src/AuthClient.ts:29 area verbatim. Grepped every `.middleware(` call in packages/*/src: Admin, Session, Account, Jwt, OAuth, Organization, Passkey, Password, Subject groups attach Authentication/OptionalAuthentication/AuthorizedSubject — none attach `Api.CsrfProtection`. `CsrfProtection` itself appears only in packages/api/src/Api.ts (declaration), index.ts (export), client/src/AuthClient.ts + index.ts (comment + CsrfClientLive), and server/src/Csrf.ts (implementation) — never attached to a served group, confirming dead code in every shipped composition. Fix is mechanical (add `.middleware(Api.CsrfProtection)` to the unsafe-method groups). Status → ready-for-agent.

**Resolved (2026-09-19):** `Api.CsrfProtection` attached to every mutating production `HttpApiGroup` (core `SessionGroup`/`AccountGroup`, `AdminGroup`, `OrganizationGroup`, `PasskeyGroup`/`PasskeyAuthenticateGroup`/`PasskeyCredentialsGroup`, `PasswordGroup`), declared last in each chain so it runs outermost/first (rejects a forgery before `Authentication` does any credential work). `OAuthGroup`/`JwtApi`/`SubjectApi` deliberately left alone — GET-only, CSRF exempt by construction (BEH-EA-077). This made `Api.CsrfProtection` a real compile-time requirement on every plugin's own `.layer` (not just its HTTP-serving path), so `CsrfProtectionLive` was also wired into 4 BDD world files and 13 unit/wire-level test files across admin/jwt/organization/passkey/password/server, each verified with both a real `tsc` typecheck and an actual `vitest run` (not just types) — several caught real runtime consequences, e.g. `packages/server/test/AuthHttp.test.ts`'s unauthenticated-401 test needed a valid CSRF pair too, since CSRF now runs before Authentication and would otherwise return 403 first. Full monorepo `pnpm run typecheck` and every real test suite (excluding pre-existing empty ones) pass. Status → resolved.
