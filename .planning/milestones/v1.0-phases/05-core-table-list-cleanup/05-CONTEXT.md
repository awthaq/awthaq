# Phase 5: Core-table list cleanup - Context

**Gathered:** 2026-11-14
**Status:** Ready for planning

<domain>
## Phase Boundary

One declared list of the core tables lives in `@awthaq/sql`, and every hand-maintained copy projects from it. It records, per table: name, owner (core), tenancy (partitioned, directory or none), whether the test-side `LaggingReplica` copies it, and its sealed columns (derived from `CoreSealedColumns`, never copied). `auth_relay_cursor` and `rate_limit_buckets` are each classified with a documented reason. The list carries no column types and no DDL (ADR-EA-004). The `core -> sql` package edge is unchanged and there is no new dependency. A declaration-list snapshot protects the sealed AADs. A drift guard fails when a core migration creates a table that the list does not classify.

Requirements: CAT-01, CAT-02, CAT-03, CAT-04.

</domain>

<decisions>
## Implementation Decisions

### Re-grep at context time (CAT-04, success criterion 4)
The roadmap asks for a re-grep before widening past `LaggingReplica`. Done on 2026-11-14 at HEAD `ea56a16f`:
- `packages/sql/src/TenantScope.ts:45,53` already holds `partitionedTables` (sessions, verification_tokens, verification_reservations, auth_audit_log) and `directoryTables` (users, accounts), and `TenantScope.coverage` already projects from them (`TenantScope.ts:103-108`). This is the existing source, not a duplicate.
- `packages/core/src/Auth.ts:779-782` `coreTables` is already a projection of those two lists. Not a duplicate.
- `packages/test/src/LaggingReplica.ts:31-38` `coreTables` is a REAL hand copy (the same six names, other order, exported from `@awthaq/test`).
- `features/step-definitions/TenancySteps.ts:70-77` `STAMPED_TABLES` is a REAL hand copy (same six names, BDD side).
- `auth_relay_cursor` (migration 27, `CoreMigrations.ts:603`, store `RelayCursorStoreSql.ts`) and `rate_limit_buckets` (created by `RateLimiterStoreSql.ts` itself; read by `packages/test/src/internal/storeContract/rateLimiterStore.ts`) appear in no list today. The planner re-verifies this grep and records the disposition in the plans.
- Disposition: the candidate was over-claimed (two of the three named lists already derive from one source), but two real copies and two unclassified tables remain. The user's standing rule is the cleanest end state, complexity accepted, so the catalogue ships as written in CAT-01..03 and is justified by the classification plus the drift guard rather than by the duplicate count. CAT-04's minimal-fix path does not apply (more than the `LaggingReplica` copy is real); record that reasoning.

### Claude's Discretion
All implementation choices are at Claude's discretion: structural refactor, no new user-facing behaviour. Constraints already decided:
- No column types and no DDL in the catalogue (ADR-EA-004); the `core -> sql` edge stays; no new dependency; `pnpm circular` passes (it counts type-only imports).
- `TenantScope.partitionedTables` and `directoryTables` keep their exported names, element types and ORDER (public surface and `TenantScoped.test.ts` asserts them); they become derived views. `TenantScope.coverage` output is unchanged (pinned before the change).
- `LaggingReplica.coreTables` keeps its export name and the exact current table list and order (`users, accounts, sessions, verification_tokens, verification_reservations, auth_audit_log`) unless a test shows the order is irrelevant; it is derived from the catalogue's replicated tables. `rate_limit_buckets` stays excluded from replication with its documented reason (a limit must not be multiplied by the replica count, `RateLimiterStoreSql.ts` header). `auth_relay_cursor` is classified (tenancy none) with the reason it does or does not replicate; the planner decides from `ReadRouting` (only display/history listings go to the replica) and records it.
- Sealed columns: the catalogue references `CoreSealedColumns` declarations (it is a view over them, not a second list). A snapshot test pins the exact AAD list (`users:<id>:metadata`, `sessions:<id>:ipAddress`, `sessions:<id>:userAgent`, `accounts:<id>:accessToken|refreshToken|idToken`) so a sealed column cannot be added, removed or re-keyed silently. Pin the snapshot BEFORE refactoring.
- Drift guard: a test enumerates the tables created by `CoreMigrations` (by running the migrations on SQLite and reading the schema, excluding migration ledger tables) and asserts every one is classified in the catalogue, and vice versa. `rate_limit_buckets` is created outside `CoreMigrations`; the catalogue still classifies it and the guard covers it through its own creation path or an explicit documented exception.
- Wave 0 before any `src` change: record `05-BASELINE.md` (every gate at HEAD, as Phases 1-4) and pin today's behaviour: `TenantScope.coverage` for the option matrix (undefined, includeDirectory, plugins Partitioned/Keyed/Derived), `TenantScope.partitionedTables`/`directoryTables` values and order, `LaggingReplica.coreTables`, the `STAMPED_TABLES` literal, the sealed AAD list.
- Postgres is available locally (Debian `postgres:16` container at `postgres://postgres:pw@localhost:55433/awthaq`, pass `AWTHAQ_POSTGRES_URL` explicitly; use `--shm-size=1g` if the container is recreated): phase gates include the Postgres legs of `TenantScoped`/RLS tests; record "run locally on the CI image, CI confirmation open (no git remote)".
- Public-surface change (if the new module is exported from the `@awthaq/sql` barrel) ships a changeset with a `Migration:` line (one candidate, one changeset); spec Revision and Change History bump together; `spec/behaviors/28-tenancy.md` and the sql README name the catalogue where they list the core tables; `pnpm knip`, `pnpm check:readmes` and `pnpm spec:verify:strict` stay at baseline.
- Strata: `api < ports < sql < core < server < qadi < plugins < cli/test/features`; the catalogue lives in `sql`.
- Executors do not run `requirements.mark-complete`.

### Decided autonomously
- [Catalogue scope] Q: "Catalogue or minimal LaggingReplica fix?" → Selected: "Catalogue (CAT-01..03), because the drift guard and the classification of the two unlisted tables are the leverage; the roadmap's minimal-fix branch was conditional on only LaggingReplica being real" — standing rule: cleanest end state
- [Owner field] Q: "What does `owner` mean for core tables?" → Selected: "A fixed `core` marker kept so plugin-owned tables can be told apart from core ones in `Auth.ts` (which already refuses a derived plugin table whose parent is not a core table)" — no behaviour change
- [Features copy] Q: "Is `TenancySteps.STAMPED_TABLES` in scope?" → Selected: "Yes: it is a real copy; it projects from the catalogue (features already depend on `@awthaq/sql`)" — verify the dependency edge in the plans

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/sql/src/TenantScope.ts` (lists, `coverage`), `packages/sql/src/CoreSealedColumns.ts` (six sealed columns, AAD convention), `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/RelayCursorStoreSql.ts`, `packages/sql/src/RateLimiterStoreSql.ts`, `packages/sql/src/ReadRouting.ts`.
- `packages/test/src/LaggingReplica.ts`, `packages/test/test/ReadRouting.test.ts`; `packages/core/src/Auth.ts:779`; `features/step-definitions/TenancySteps.ts:70`; tests `packages/sql/test/TenantScoped.test.ts`, `packages/sql/test/CoreStoresSql.test.ts`.
- Phase 3 `Keyset`/`KeysetSql` modules are the house style for a small declaration module plus a builder.

### Established Patterns
- Phase process: baseline and pin matrix first, then refactor, then re-run every gate; verbatim moves; changeset with `Migration:`; spec Revision plus Change History bumped together.

### Integration Points
- `@awthaq/sql` barrel (`packages/sql/src/index.ts`), `spec/behaviors/28-tenancy.md`, `spec/decisions/004-database-neutral-models.md`, `packages/sql/README.md`.

</code_context>

<specifics>
## Specific Ideas

None beyond the success criteria.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>
