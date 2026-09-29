---
ID: "MW-007"
Title: "Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores"
Level: medium
Category: "api"
Status: wontfix
Package: "core"
Source: "packages/core/src/Users.ts:56"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-007 — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores

`MEDIUM` · `api` · `core` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **wontfix**

## Summary

UsersShape (create/findById/findByEmail/updateProfile/verifyEmail/delete) is one all-or-nothing Context service. The Auth0 custom-database-connection model this repo's positioning invites only asks an integrator to implement the operations their store supports (e.g. login + getProfile on a read-only legacy table); here, pointing awthaq at an existing user store means stubbing create/delete/verifyEmail to throw — and UserRecord mandates createdAt/updatedAt and a pre-lowercased email, which a legacy table may not have. The seam exists (plain Context service, memory twin proves it), but its economics penalize exactly the bring-your-own-identity-source integrations that make an auth runtime adoptable.

## Evidence

Source: `packages/core/src/Users.ts:56`

```
readonly create: (input: {
    readonly email: string;
    readonly name: string;
```

## Recommended fix

Split UsersShape into read capabilities (findById/findByEmail, required) and write capabilities (create/update/delete/verifyEmail, optional with typed 'not supported' errors), or ship a Users.adapter() helper that fills write ops with typed UnsupportedOperation errors from a partial implementation.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `user-import-idempotency`. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:87`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/01-core-sessions-users.md`.

**Wontfix (2026-09-29):** Deliberately not built: a partial-adapter path would need either a new 'unsupported operation' member in the error channel of every `UsersShape` method (a breaking change for every consumer) or compile-time capability gating threaded through the layer requirements of every plugin that touches users (Password, OAuth, Passkey, Admin, SCIM, ...), for which there is no consumer today. The project's adoption path for an existing identity store is migration with bridges (`LegacyPasswordVerifiers` + `@awthaq/migrate-auth0`, `LegacySessionBridge` + `@awthaq/migrate-better-auth`, `Users.createOrGet`/import), not a live read-only legacy user table. What a user does instead: `Users` is a plain `Context.Service`, so a read-only or legacy store provides its own layer implementing `findById`/`findByEmail` (the shape `layerMemory` proves) and answers the write operations it cannot support with `Effect.die` (a wiring defect) or its own translation; revisit with a concrete live-legacy-store integration.
