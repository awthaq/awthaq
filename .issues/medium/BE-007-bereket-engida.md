---
ID: "BE-007"
Title: "User profile is a closed shape — no user-field extension point for apps or plugins"
Level: medium
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:62"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-007 — User profile is a closed shape — no user-field extension point for apps or plugins

`MEDIUM` · `api` · `core` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

UserRecord is a fixed six-field shape and updateProfile accepts `name` only. The emailVerified supplier-authority design is genuinely good (better-auth has to fight this), and the plugin-table namespacing answers plugin-data isolation well — Passkey stores webauthnUserId in its own passkey_credential table, so core never learns passkeys exist. But nothing answers the most common application need better-auth's user.additionalFields serves: 'my user has a displayName/avatar/locale/preference'. Every real app hits this wall on day one, and today the only workaround is a hand-rolled side table keyed by user id with no framework support or client inference.

## Evidence

Source: `packages/core/src/Users.ts:62`

```
  readonly updateProfile: (
    id: UserId,
    input: { readonly name: string },
```

## Recommended fix

Add an opt-in user-attributes extension: either a JSON attributes column with a typed accessor, or a documented, contract-level pattern for user-keyed plugin profile tables that the client can infer; keep emailVerified's one-way authority untouched.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- [`MW-007` — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores](medium/MW-007-matias-woloski.md) `_(matias-woloski, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `users-profile-surface`. Duplicate of `SAM-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/AuthPlugin.ts:126`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
