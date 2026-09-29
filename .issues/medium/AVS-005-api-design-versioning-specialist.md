---
ID: "AVS-005"
Title: "jwt package states a middleware convention that password's own contract violates"
Level: medium
Category: "api"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/JwtApi.ts:16"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-005 — jwt package states a middleware convention that password's own contract violates

`MEDIUM` · `api` · `jwt` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

JwtApi.ts's header declares the established pattern for a plugin mixing public and authenticated endpoints: a second dotted-sub-id group carrying group-level `.middleware(Api.Authentication)`, "never a per-endpoint middleware inside one shared group". PasswordApi.ts does exactly the forbidden thing — `changePassword` carries a per-endpoint `.middleware(Api.Authentication)` (packages/password/src/PasswordApi.ts:216) inside the shared `password` group that also contains public signUp/signIn. Either the jwt comment overstates the convention or password predates it; a third-party plugin author reading jwt's header will build differently from the shipped password plugin, and the inconsistency is invisible to the type system.

## Evidence

Source: `packages/jwt/src/JwtApi.ts:16`

```
// second, dotted-sub-id group carrying its own `.middleware(Api.Authentication)`
// (see `PasskeyApi.ts`'s `passkey`/`passkey.authenticate` split), never a
// per-endpoint middleware inside one shared group.
```

## Recommended fix

Pick one rule and enforce it: give password a `password.credentials`-style dotted sub-group for the authenticated endpoint (matching passkey), or soften jwt's header to describe both sanctioned shapes. Convention docs that contradict shipped code are worse than no docs for third-party plugin authors.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-007` — Token minting declared as GET with an action-verb id, breaking the POST-for-actions convention](low/AVS-007-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `plugin-api-surface-conventions`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtApi.ts:12`. Fix: Make password follow the stated convention: move its two authenticated endpoints into a dotted `password.account` sub-group with group-level Authentication; keep paths. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Already fixed at current HEAD by EHA-007 (password-api-contract-hygiene): PasswordApi.ts defines PasswordAccountGroup = HttpApiGroup.make('password.account') holding changePassword/reauthenticate with group-level Authentication + CsrfProtection (paths unchanged) and Password.ts serves it via a password.account handler group; proof: packages/password/test/AuthHttp.test.ts 'EHA-007: every password.account endpoint requires Authentication; no endpoint in the public group does' and 'change-password without a session is rejected' (401). JwtApi.ts header comment now cites the password/password.account example too. No code change beyond that.
