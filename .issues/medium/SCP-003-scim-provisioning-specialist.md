---
ID: "SCP-003"
Title: "Users.create has no create-or-get: IdP timeout retries surface as EmailAlreadyExists instead of idempotent success"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:59"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-003 — Users.create has no create-or-get: IdP timeout retries surface as EmailAlreadyExists instead of idempotent success

`MEDIUM` · `correctness` · `core` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

SCIM create must be idempotent against IdP retries after timeout (the persona's own hiring-rubric item). Users.create fails with EmailAlreadyExists on any duplicate email and offers no upsert; a plugin can only improvise findByEmail-then-create, which is a check-then-act race across concurrent directory syncs. The SQL layer's UNIQUE index on lower(email) (packages/core/src/Users.ts:206-210) makes the race data-safe but maps the violation to a domain error rather than to the existing row, so the plugin cannot converge retries to 200 OK with the surviving resource.

## Evidence

Source: `packages/core/src/Users.ts:59`

```
  }) => Effect.Effect<UserRecord, EmailAlreadyExists | PlatformError.PlatformError>;
```

## Recommended fix

Add Users.createOrGet (insert, and on unique violation return the existing record) or an idempotency-key-parameterized create as the spec's research already recommends borrowing for create-if-absent flows; SCIM createUser then maps directory retries to the same underlying user deterministically.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `user-import-idempotency`. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:290`. Fix: Add Users.createOrGet: insert, and on unique violation return the existing record deterministically (both layers). (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Closed by commit 4b63d9e. Users.createOrGet(input) -> {user, created}: the memory layer decides insert-or-holder in one Ref.modify; the SQL layer uses INSERT ... ON CONFLICT DO NOTHING RETURNING * (UsersRepository.insertIfAbsent) then looks the holder up — not catch-the-violation, because a Postgres unique violation would abort an enclosing transaction (the import runs one per user). Conflict target per identity kind; Anonymous never conflicts. Tests (core Users.test.ts, both layers, sqlite + real Postgres): idempotent return with created=false for email and phone, Anonymous always fresh, 8 concurrent createOrGet -> one user and exactly one created=true; sql contract 'insertIfAbsent returns None on conflict and does not poison the transaction'.
