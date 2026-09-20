---
ID: "BAM-002"
Title: "All 11 plugin-owned tables have SQL layers but zero DDL"
Level: high
Category: "architecture"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:190"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-002 — All 11 plugin-owned tables have SQL layers but zero DDL

`HIGH` · `architecture` · `admin` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

Organization declares 7 tables, passkey 2, jwt 1, admin 1; each has a layerSql issuing real INSERT/SELECT/UPDATE against them (e.g. organization_org, passkey_credential, jwt_signing_key). Yet no plugin package contains any CREATE TABLE and none passes the `migrations` option that AuthPlugin.Service accepts (packages/core/src/AuthPlugin.ts:127); CoreMigrations.ts covers only the 5 core tables. A fresh SQL deployment cannot boot these plugins' SQL layers, and a better-auth schema migration has no DDL target to load plugin data into — the schema-extension story better-auth plugins get declaratively simply does not close on the persistence side.

## Evidence

Source: `packages/admin/src/Admin.ts:190`

```
tables: ["admin_impersonation"],
```

## Recommended fix

Have each plugin ship its own dialect-branched migrations via the existing AuthPlugin migrations mechanism (Auth.make already aggregates and dependency-orders them), mirroring CoreMigrations' pg/sqlite pattern, and add a test asserting every declared table has a migration.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-006` — Impersonation cookie overwrite strands the admin's own live session with no handback](medium/APS-006-auth-pentest-specialist.md) `_(auth-pentest-specialist, medium)_`
- [`BAM-005` — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface](high/BAM-005-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-012` — Impersonation semantics differ from better-auth's cookie-swap model](info/BAM-012-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, info)_`
- [`CSS-003` — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie](medium/CSS-003-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`IDS-001` — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account](high/IDS-001-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, high)_`
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-007` — Both stop paths refuse to revoke when the audit row is missing or already ended](low/IDS-007-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/admin/src/Admin.ts:190` matches (`tables: ["admin_impersonation"]`) with no `migrations` option passed; a grep for `migrations:` across all package `src/` finds it declared only in core's `AuthPlugin.ts`/`Auth.ts` machinery, never populated by any plugin. `organization` (7 tables), `passkey` (2), `jwt` (1) are likewise DDL-less, and `CREATE TABLE` only exists in `packages/sql/src/CoreMigrations.ts` for the 5 core tables. Fix mirrors CoreMigrations' existing pg/sqlite pattern per plugin — mechanical. Status → ready-for-agent.

**Resolved (2026-09-20):** `@awthaq/jwt` (2 of the finding's tables) already shipped real `migrations` by the time this finding was picked up — `packages/jwt/src/Jwt.ts`'s own `jwtMigrations`, added during an earlier ticket (RRS-003/token-lifecycle-store), was the working template this resolution followed exactly. Closed the remaining gap for the other three plugins:

- `packages/admin/src/Admin.ts`: `adminMigrations` (`admin_impersonation` + a `sessionId` index) declared, passed as `Admin`'s own `migrations` option.
- `packages/passkey/src/Passkey.ts`: `passkeyMigrations` (`passkey_credential` + `userId` index, `passkey_challenge`) declared and wired the same way.
- `packages/organization/src/Organization.ts`: `organizationMigrations` — all 7 tables (`organization_org`, `organization_membership`, `organization_invitation`, `organization_team`, `organization_team_membership`, `organization_role`, `organization_active_context`) plus indexes on every real, independent single-column filter key each `*Records.ts` module's own queries use (mirroring `CoreMigrations.ts`'s own `accounts_user_id`/`sessions_user_id` precedent) — the largest remaining piece of this finding.

Every table's DDL is ported verbatim from that table's own pre-existing test fixture (each `*Records.test.ts` already hand-rolled a working `CREATE TABLE` for its own SQLite-backed suite) — the canonical, already-proven-correct shape, not a fresh design. No new uniqueness constraint was added beyond what each fixture already had (`organization_org.slug UNIQUE`, `organization_role`'s `UNIQUE(organizationId, role)`) — BAM-002's own ask is DDL parity, not a constraint audit. Columns are left unquoted under `pg` for admin/organization/passkey, matching `jwtMigrations`'s own precedent and rationale: every one of these plugins' own runtime queries already references every column unquoted, so Postgres's automatic lowercase-folding is what keeps migration and query consistent — quoting would have desynced `CREATE TABLE`'s literal casing from the unquoted runtime queries under Postgres specifically (caught and fixed during this same pass, before it shipped).

TDD, matching this finding's own recommended fix ("add a test asserting every declared table has a migration") in its strongest available form: rather than a separate static assertion (there is no single place in this codebase that imports every plugin package together without creating a new, artificial cross-package test dependency — plugins are consumer-composed, never imported by each other), every existing SQL-backed `*Records.test.ts` for these three plugins (9 files: `ImpersonationRecords`, `OrganizationRecords`, `MembershipRecords`, `InvitationRecords`, `TeamRecords`, `ActiveContextRecords`, `OrgRoleRecords`, `PasskeyCredentials`, `ChallengeStore`) now runs its `layerSql` suite through `Migrations.run(<Plugin>.migrations)` instead of its own hand-rolled fixture — the same conversion `packages/jwt/test/RevocationStore.test.ts` already established as this codebase's own precedent for "prove the real migrations work," not a new pattern invented here. Every one of the 10 plugin-owned tables this finding named is exercised by at least one of these converted suites, so this is strictly stronger than a name-matching assertion: it proves each migration produces a schema the plugin's own real CRUD queries actually run against successfully. Mutation-verified: temporarily dropping the `slug` column from `organization_org`'s migration broke `OrganizationRecords.test.ts` for exactly the expected reason (`table organization_org has no column named slug`, SQLite), confirmed, then reverted. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (721 passed, unchanged — every converted suite still passes against the real migrations); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures).
