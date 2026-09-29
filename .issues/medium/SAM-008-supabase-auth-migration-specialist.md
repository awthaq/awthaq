---
ID: "SAM-008"
Title: "Import path is three sequential single-row calls per user with an emailVerified lockout hazard"
Level: medium
Category: "dx"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:50"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-008 — Import path is three sequential single-row calls per user with an emailVerified lockout hazard

`MEDIUM` · `dx` · `core` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **resolved**

## Summary

There is no bulk or upsert import surface: a migration must, per user, call Users.create (fails EmailAlreadyExists rather than upserting against UNIQUE lower(email)), Users.verifyEmail (Supabase-confirmed users would otherwise be locked out), and Accounts.link with the carried-over credentialHash — three sequential calls with no batching, no transaction boundary spanning user+identity, and no ON CONFLICT semantics for re-runnable imports. The failure mode of a missed verifyEmail is nasty: signIn gates on it only after a successful password check (packages/password/src/Password.ts:548-550), so every affected user sees EmailNotVerified despite supplying a correct password. For a six-figure auth.users export this is also a throughput problem.

## Evidence

Source: `packages/core/src/Users.ts:50`

```
 * `create` always starts it `false` (supplier-authority default), and
 * `verifyEmail` is the only transition, one-directional and idempotent.
```

## Recommended fix

Add an explicit import helper (batch upsert on lower(email), upsert on (providerId, subject, issuer), accepting pre-verified emails and pre-hashed credentials as first-class inputs), and make it re-runnable so partial imports resume safely.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `user-import-idempotency`. Duplicate of `AOMS-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/migrate-auth0/src/ImportAuth0User.ts:32`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `AOMS-008-auth0-okta-migration-specialist` — closed by its fix (see that issue's Resolved comment).
