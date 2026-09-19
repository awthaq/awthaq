---
ID: "TMS-001"
Title: "CSRF middleware implemented and tested but attached to no real endpoint — INV-EA-011 holds vacuously"
Level: high
Category: "security"
Status: resolved
Package: "client"
Source: "packages/client/src/AuthClient.ts:29"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-001 — CSRF middleware implemented and tested but attached to no real endpoint — INV-EA-011 holds vacuously

`HIGH` · `security` · `client` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

CsrfProtectionLive (packages/server/src/Csrf.ts) fully implements the Sec-Fetch-Site/Origin/double-submit design, and CsrfClientLive exists, but no real contract group ever declares .middleware(Api.CsrfProtection) — it appears only in synthetic test groups. Every public mutating POST (sign-in, sign-up, confirm-reset, verify-email, session revoke) therefore ships with zero server-side CSRF enforcement. SameSite=strict on the __Host- session cookie blocks classic authenticated CSRF, but login CSRF (cross-site form POSTing attacker credentials to /password/sign-in sets an attacker-known session in the victim's browser) and signup/request-reset CSRF are wide open. The documented invariant INV-EA-011 ('CSRF required by the client type') is trivially true because the middleware is never declared, not because it is enforced.

## Evidence

Source: `packages/client/src/AuthClient.ts:29`

```
// against yet.** No plugin's `HttpApiGroup` in this repository currently
// declares `.middleware(Api.CsrfProtection)` at all — `Password`/`OAuth`/the
// core `session` group all use `Authentication`/`OptionalAuthentication`
```

## Recommended fix

Attach Api.CsrfProtection to the unsafe-method endpoints of the password, session, admin, and oauth groups (and any app-level groups), then the existing CsrfClientLive wiring becomes load-bearing and INV-EA-011 stops being vacuous.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — grep of every `*Api.ts` for `.middleware(Api.` shows only `Api.Authentication`/`Api.OptionalAuthentication` attached anywhere (`AdminApi.ts:111`, `PasswordApi.ts:216`, `PasskeyApi.ts:225/263`, `OrganizationApi.ts:710`, etc.); `Api.CsrfProtection` is never attached to a real group. `packages/client/src/AuthClient.ts:27-29` matches the evidence quote verbatim. `CsrfProtectionLive`/`CsrfClientLive` already exist fully built, so attaching the middleware to the unsafe-method groups is a mechanical change following the exact pattern already used for `Api.Authentication`. Status → ready-for-agent.

**Resolved (2026-09-19):** `Api.CsrfProtection` attached to every mutating production `HttpApiGroup` (core `SessionGroup`/`AccountGroup`, `AdminGroup`, `OrganizationGroup`, `PasskeyGroup`/`PasskeyAuthenticateGroup`/`PasskeyCredentialsGroup`, `PasswordGroup`), declared last in each chain so it runs outermost/first (rejects a forgery before `Authentication` does any credential work). `OAuthGroup`/`JwtApi`/`SubjectApi` deliberately left alone — GET-only, CSRF exempt by construction (BEH-EA-077). This made `Api.CsrfProtection` a real compile-time requirement on every plugin's own `.layer` (not just its HTTP-serving path), so `CsrfProtectionLive` was also wired into 4 BDD world files and 13 unit/wire-level test files across admin/jwt/organization/passkey/password/server, each verified with both a real `tsc` typecheck and an actual `vitest run` (not just types) — several caught real runtime consequences, e.g. `packages/server/test/AuthHttp.test.ts`'s unauthenticated-401 test needed a valid CSRF pair too, since CSRF now runs before Authentication and would otherwise return 403 first. Full monorepo `pnpm run typecheck` and every real test suite (excluding pre-existing empty ones) pass. Status → resolved.
