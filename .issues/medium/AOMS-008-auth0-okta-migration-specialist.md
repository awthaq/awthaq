---
ID: "AOMS-008"
Title: "No bulk user import/export surface anywhere in the monorepo"
Level: medium
Category: "api"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Users.ts:56"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-008 — No bulk user import/export surface anywhere in the monorepo

`MEDIUM` · `api` · `core` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **ready-for-agent**

## Summary

The only write path is one-at-a-time create, and grep for any bulk/import/batch user API across packages returns nothing (the only 'bulk' hits are session/account deletes). A 100k-user Auth0 tenant export becomes a hand-rolled script looping Users.create + Accounts.link + verifyEmail, each needing its own collision policy; the OAuth plugin's synthetic email fallback (`providerId:subject`) shows the codebase already anticipates identity rows without real emails, but import tooling gets no help deduplicating them. Because this is a code-native runtime, a script is legitimate — but the recipe (transaction batching, EmailAlreadyExists handling, credential-hash import) is nowhere documented, and admin (the natural owner of an import command) exposes impersonation, not user administration.

## Evidence

Source: `packages/core/src/Users.ts:56`

```
  readonly create: (input: {
    readonly email: string;
    readonly name: string;
  }) => Effect.Effect<UserRecord, EmailAlreadyExists | PlatformError.PlatformError>;
```

## Recommended fix

Document an official import recipe (transactional batch of users.create + accounts.link({credentialHash}) + verifyEmail) and add a minimal admin-side list/export API so the coexistence period can reconcile the two user stores.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- [`MW-007` — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores](medium/MW-007-matias-woloski.md) `_(matias-woloski, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `user-import-idempotency`. Evidence at HEAD ec065a7: `packages/migrate-auth0/src/ImportAuth0User.ts:32`. Fix: Provide a transactional, idempotent import primitive in core and batch importers on top of it. (effort L). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
