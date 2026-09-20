---
ID: "AOMS-002"
Title: "UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:28"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-002 — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target

`HIGH` · `architecture` · `core` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

The record ends at {id, email, emailVerified, name, createdAt, updatedAt} and updateProfile accepts {name} alone (Users.ts:62-65), so an imported tenant's subscription tier, department, external ids, or Auth0 app_metadata have nowhere to land. Organization records carry exactly this capability (OrganizationRecord.metadata is a free-form string, packages/organization/src/OrganizationRecords.ts:28) — the asymmetry makes user import structurally lossy. This also caps the JWT definePayload hook: a claims-enrichment function receives only an Api.Principal (sub/sid/act), so even app-level custom claims an Auth0 Action would add cannot be sourced from stored user attributes. Every plugin that later wants per-user attributes will otherwise invent its own table, fragmenting the migration model.

## Evidence

Source: `packages/core/src/Users.ts:28`

```
  readonly emailVerified: boolean;
  readonly name: string;
  readonly createdAt: DateTime.Utc;
```

## Recommended fix

Add a JSON metadata column to UserRecord (and the SQL model) with a dedicated update path, mirroring OrganizationRecord.metadata; document the Auth0 user_metadata (user-writable) vs app_metadata (admin-writable) split as an application concern on top of it.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
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

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/Users.ts:28-36` shows `UserRecord` has no metadata field, and `updateProfile` accepts only `{ name }` (lines 62-65); `packages/organization/src/OrganizationRecords.ts:28` confirms `OrganizationRecord.metadata: Option.Option<string>` already exists as a direct pattern to mirror. Adding a JSON metadata column plus an update path is a well-scoped, mechanical change. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented exactly the recommended fix, mirroring `OrganizationRecord.metadata`'s own shape (a free-form, opaque string this service never parses — an application is free to JSON-encode whatever it wants into it):

- `packages/core/src/Users.ts`: `UserRecord` gains `readonly metadata: Option.Option<string>`. `UsersShape.create`'s input gains optional `metadata?: string`; `updateProfile`'s input gains `metadata?: string | null` — `undefined` leaves it untouched, `null` clears it, a string overwrites it (independently of `name`, which stays required, unchanged). Both `layerMemory` and `layerSql` implement the identical semantics; the same shared contract-test suite (`packages/core/test/Users.test.ts`) already runs against both `Layer`s.
- `packages/sql/src/Models.ts`: `User` gains a `metadata: Schema.NullOr(Schema.String)` field with a `withConstructorDefault(null)` (matching `emailVerified`'s own default just above it) — chosen over `Account.passwordHash`'s always-explicit precedent specifically so every pre-existing `User.insert`/`.update` call site across the monorepo (found via a full `pnpm run typecheck` pass — 16 pre-existing call sites in `packages/sql/test/Repositories*.test.ts`) keeps compiling unchanged; only `Users.ts`'s own `create`/`updateProfile` needed a code change beyond the field declaration.
- `packages/sql/src/CoreMigrations.ts`: migration 14, `add_users_metadata_column` — a plain nullable `TEXT` column, both dialects.
- `packages/core/test/Users.test.ts`: its own hand-rolled `CREATE TABLE users` (used only by this test file's `layerSql` suite, not routed through `CoreMigrations`) needed the same column added — caught by a full `pnpm run test` pass surfacing `table users has no column named metadata` before this fix, not by inspection.
- **Out of scope, deliberately**: this finding's own evidence names the JWT `definePayload` claims-enrichment hook as a downstream beneficiary ("a claims-enrichment function receives only an `Api.Principal`") but the finding's own recommended fix stops at "Add a JSON metadata column... with a dedicated update path" — wiring `metadata` into `definePayload`'s available inputs is a `@awthaq/jwt`-side change with its own blast radius and is left for a future finding if one names it directly, matching this session's standing discipline against scope creep beyond what a finding's own recommended fix asks for.

TDD: one new contract test in the existing shared suite (`packages/core/test/Users.test.ts`, runs against both `layerMemory` and `layerSql` — 12 tests total, up from 10) covering: default `None` on plain `create`, round-tripping a set value, `updateProfile` leaving it untouched when omitted, overwriting it with a new value, and clearing it with `null`. Verified genuinely load-bearing via a real mutation: changed `layerSql.updateProfile`'s "leave untouched when `undefined`" branch to always overwrite with `input.metadata ?? null`, rebuilt `packages/sql/lib` via `tsc -b` (required — cross-package consumption resolves through built output), and confirmed the new test failed for exactly the expected reason (the rename-only case lost its previously-set metadata); reverted, rebuilt, confirmed all 12 passing again. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (714 passed, 7 skipped, up from 712); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures noted in prior resolutions).
