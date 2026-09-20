---
ID: "BAM-006"
Title: "Global role assignments are memory-only; better-auth's user.role column has no durable home"
Level: high
Category: "architecture"
Status: resolved
Package: "roles"
Source: "packages/roles/src/Roles.ts:16"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-006 — Global role assignments are memory-only; better-auth's user.role column has no durable home

`HIGH` · `architecture` · `roles` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

The roles plugin resolves UserPrincipals through qadi's role DAG but persists nothing: there is no role_assignments table (the header names its design as separate later work). better-auth stores user.role as a column that survives restarts and migrates as data. Under effect-auth, every global role assignment evaporates on process restart and there is nowhere to import 5,000 users' roles into — RBAC data is unrecoverable at cutover, not merely inconvenient.

## Evidence

Source: `packages/roles/src/Roles.ts:16`

```
// SQL persistence for role assignments is deferred: only `layerMemory`
```

## Recommended fix

Add a role_assignments table (userId, role, uniqueness design already flagged in the header) with the codebase's standard layerMemory/layerSql pair, and give the import command a mapping from better-auth's comma-joined user.role values into it.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MTI-007` — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models](medium/MTI-007-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- [`PCS-003` — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke](medium/PCS-003-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`RRM-003` — Assigned role names absent from the catalog are silently dropped](medium/RRM-003-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-004` — Duplicate catalog role names silently collapse, last wins](low/RRM-004-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`RRM-005` — Roles.assign/revoke emit no audit events and take no authorization gate](medium/RRM-005-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-006` — Three disjoint role/permission models with no bridge between them](medium/RRM-006-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, medium)_`
- [`RRM-010` — Empty default catalog silently disables the roles plugin](low/RRM-010-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, low)_`
- [`TS-008` — Role assignments are never validated against the policy catalog; drift is silent](low/TS-008-torin-sandall.md) `_(torin-sandall, low)_`
- … 3 more findings touch `packages/roles/src/Roles.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/roles/src/Roles.ts:16` matches verbatim ("SQL persistence for role assignments is deferred: only `layerMemory`"), and the file's own header (lines 15-18) confirms only `layerMemory` exists, no `layerSql`. Adding a `role_assignments` table plus a `layerSql` follows the codebase's own established memory/SQL pair pattern (e.g. `CoreMigrations.ts`). Status → ready-for-agent.

**Resolved (2026-09-20):** Added `role_assignments` (`userId`, `role`, `createdAt`, `UNIQUE(userId, role)` — the same idempotency `layerMemory`'s own `assign` contract already documents, now enforced at the database layer too) and `Roles.Roles.layerSql`, mirroring `@awthaq/jwt`'s own `RevocationStore.layerSql` (`INSERT ... ON CONFLICT ... DO NOTHING`, plugin-owned-table pattern, unquoted `pg` columns matching this table's own unquoted queries) — the same real migration pattern `BAM-002` just established for admin/organization/passkey. `Roles`'s existing `static readonly layer` (in-memory) is unchanged and remains the default; `layerSql` is purely additive, built by factoring the `SubjectResolver`-override `Effect.gen` body (previously inlined once, only inside `layer`) into a shared `subjectResolverMake` const both variants now compose over — no duplicated logic between the two.

TDD: new `packages/roles/test/RolesSql.test.ts` proves `assign`/`revoke`/`listRoleNames` round-trip through a real SQLite database migrated via `Migrations.run(Roles.Roles.migrations)` (not a hand-rolled fixture), and specifically proves the one property the existing in-memory `Roles.test.ts` suite cannot: assigning an already-held role name is a no-op at the *database* layer, not just the in-memory one. `packages/roles/test/AuthComposition.test.ts`'s own manifest-shape assertion updated (`tables: []` → `tables: ["role_assignments"]`) to match this plugin's now-real table ownership. Mutation-verified: removing the migration's `ON CONFLICT ... DO NOTHING` clause broke the idempotency test for exactly the expected reason (a real SQLite `UniqueViolation`, not a silently-passing assertion), confirmed, then reverted. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (736 passed, up from 732); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures).

**Out of scope**: this finding's own recommended fix also asks for "the import command['s]... mapping from better-auth's comma-joined `user.role` values into it" — left untouched, deliberately, as part of the same ground-up `packages/cli` build (`BAM-001`/`BE-003`, already deferred this session as too large for a single pass) that command would live inside; the persistence layer this ticket adds is exactly what that future import command will need to write into.
