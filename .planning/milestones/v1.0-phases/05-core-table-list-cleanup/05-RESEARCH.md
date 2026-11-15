# Phase 5: Core-table list cleanup - Research

**Researched:** 2026-11-14
**Domain:** one declared catalogue of the core SQL tables in `@awthaq/sql` (TypeScript, Effect v4, SQLite and Postgres), and the projections that replace the hand-kept copies
**Confidence:** HIGH on the census, the pins and the drift-guard mechanics (files read this session; the guard probe ran on SQLite and on Postgres 16.16); HIGH on the type-level design (prototype compiled with the repo `tsc` 7.0.2 under `--strict --declaration`); MEDIUM on spec/README fan-out (grep-level, listed as pin tasks)

No external library, API or package is involved, so the research-plan seam, Context7 and web search were not used. Nothing is installed: **Package Legitimacy Audit: not applicable.**

<user_constraints>
## User Constraints (from CONTEXT.md)

CONTEXT.md has `## Implementation Decisions` (with `### Re-grep at context time`, `### Claude's Discretion`, `### Decided autonomously`) and `## Deferred Ideas`. Copied verbatim; everything in them is locked, not open.

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
- [Catalogue scope] Q: "Catalogue or minimal LaggingReplica fix?" -> Selected: "Catalogue (CAT-01..03), because the drift guard and the classification of the two unlisted tables are the leverage; the roadmap's minimal-fix branch was conditional on only LaggingReplica being real" - standing rule: cleanest end state
- [Owner field] Q: "What does `owner` mean for core tables?" -> Selected: "A fixed `core` marker kept so plugin-owned tables can be told apart from core ones in `Auth.ts` (which already refuses a derived plugin table whose parent is not a core table)" - no behaviour change
- [Features copy] Q: "Is `TenancySteps.STAMPED_TABLES` in scope?" -> Selected: "Yes: it is a real copy; it projects from the catalogue (features already depend on `@awthaq/sql`)" - verify the dependency edge in the plans

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAT-01 | One core-table list in `@awthaq/sql` (name, owner, tenancy, sealed) is the source that `Auth.ts`, `LaggingReplica` and `TenantScope.coverage` project from | Q1 census (only 4 places are lists), Q2 pins (values/order), Q3 recommended shape (`CoreTables.ts`, order = migration creation order, so every projection is byte-identical), projection plan |
| CAT-02 | `auth_relay_cursor` and `rate_limit_buckets` are classified (included or documented as excluded) | Q4: both included, `tenancy: "none"`, `replicated: false`, each with a `reason`; evidence from `RelayCursorStoreSql.ts:6-7`, `ReadRouting`, ADR-EA-024 decision 2; a reason mis-citation in CONTEXT is corrected |
| CAT-03 | No column types or DDL (ADR-EA-004), `core -> sql` edge stays, declaration-list snapshot protects sealed AADs | Q3 key-set test, Q6 edges verified from `package.json`, Q2 AAD pin matrix, circular-import analysis |
| CAT-04 | If only the `LaggingReplica` copy proves real after re-grep, ship it as a minimal fix and close the candidate | Q1 census: TWO real copies plus two unclassified tables, so the minimal-fix branch does not apply; the reasoning is recorded and the closing check is the census command pair |
| GATE-04 | SQL-touching phases verified on Postgres, recorded for CI | Q5/Q7/Validation Architecture: drift guard runs on both dialects from one file via `TestSql.layer`; Postgres legs and wording |
</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

No `CLAUDE.md` exists in the worktree; `/Users/mohammadalmechkor/Projects/Perso/awthaq-arch/AGENTS.md` is the project instruction file. Directives that bind this phase:

- Domain docs are `spec/overview.md`, `spec/decisions/`, `spec/behaviors/`, `spec/traceability.md` (AGENTS.md "Domain docs"); plugin conventions in `docs/plugin-authoring.md`.
- `.oxlintrc.json` forbids type assertions in library source: `"typescript/consistent-type-assertions": ["error", { "assertionStyle": "never" }]` for `packages/*/src/**/*.ts` (`as const` stays allowed) [VERIFIED: /Users/mohammadalmechkor/Projects/Perso/awthaq-arch/.oxlintrc.json, overrides block]. The design below needs no `as` (prototype compiled clean).
- `effect/no-import-from-barrel-package` and `effect/no-js-extension-imports` apply: relative imports name `.ts` files (house style, e.g. `import * as SealedColumn from "./SealedColumn.ts";`).
- Strata `api < ports < sql < core < server < qadi < plugins < cli/test/features` and `pnpm circular` counts type-only imports (CONTEXT).

## Summary

The re-grep in CONTEXT holds, and is complete. Across `packages/*/src`, `packages/*/test`, `features/`, `examples/`, `docs/`, `spec/` and `scripts/` there are exactly four places that are a literal list of core tables in code: `TenantScope.partitionedTables` (4) and `directoryTables` (2) in `packages/sql/src/TenantScope.ts:45-53` (the existing source, with `coverage` already projecting from them), `LaggingReplica.coreTables` (6, real copy), and `TenancySteps.STAMPED_TABLES` (6, real copy). `Auth.ts` `coreTables` (`:779-782`) is a concat projection of the first two. Every other occurrence of a core table name is a per-table statement (a store adapter's `tableName`, a migration, a failure-injection trigger, a count), a Gherkin data table, or prose in spec/README. Two core tables are in no list: `auth_relay_cursor` (core migration 27) and `rate_limit_buckets` (own migrator, own ledger `awthaq_rate_limiter_migrations`). So CAT-04's minimal-fix branch (only `LaggingReplica` real) does not apply, exactly as CONTEXT records.

The catalogue is one module, `packages/sql/src/CoreTables.ts`, exported from the barrel as `CoreTables` (unavoidable: `core`, `@awthaq/test` and `features` import only the `@awthaq/sql` root export). Entries are declared **in migration-creation order** (`users, accounts, sessions, verification_tokens, verification_reservations, auth_audit_log, auth_relay_cursor, rate_limit_buckets`). That one ordering choice makes every projection byte-identical to the list it replaces with no sorting code: partitioned view = `sessions, verification_tokens, verification_reservations, auth_audit_log`; directory view = `users, accounts`; replicated view = `users, accounts, sessions, verification_tokens, verification_reservations, auth_audit_log` (the exact `LaggingReplica` order and the `STAMPED_TABLES` order). The drift guard is feasible and was probed: `Migrator` over `CoreMigrations` on a fresh database yields exactly 7 tables, and adding `RateLimiterStoreSql.migrate` adds `rate_limit_buckets` plus the third ledger table `awthaq_rate_limiter_migrations`, identically on SQLite and on Postgres 16.16. One test file using `TestSql.layer` runs both dialects.

Three findings change the plan. (1) CONTEXT's reason for excluding `rate_limit_buckets` from replication cites the `RateLimiterStoreSql.ts` header ("not multiplied by the replica count"), but that sentence is about **application** replicas sharing one table, not database read replicas; the correct read-routing reason is below (Q4). (2) `TenantScope.partitionedTables`/`directoryTables` are today `as const` tuples; a runtime-derived view cannot keep the tuple type without a forbidden `as`, but it can keep the literal-union **element type** through TypeScript's inferred type predicate (compiled and checked), so the public d.ts moves from a 4-tuple to `ReadonlyArray<"sessions" | ...>`. (3) `Auth.ts` must project the **stamped** (tenant-column-bearing) tables, not all catalogue names; otherwise a plugin `Derived` table whose parent is `auth_relay_cursor` would stop failing `UnknownParent` and be silently skipped by `coverage`.

**Primary recommendation:** Add `packages/sql/src/CoreTables.ts` (data-first, `as const` entries, derived views, `sealed` filled from `CoreSealedColumns.deployed({ encryptPii: true })`), export it from the barrel, make `TenantScope.partitionedTables`/`directoryTables`, `Auth.ts` `coreTables`, `LaggingReplica.coreTables` and `STAMPED_TABLES` derive from it, and land Wave 0 pins (literal lists, `coverage` matrix, AAD tuples, created-table set, RLS table set on Postgres) before any `src` edit.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Declaring which tables core owns, their tenancy and replication | Persistence stratum (`@awthaq/sql`) | none | `sql` already owns `CoreMigrations`, `TenantScope`, `CoreSealedColumns`; strata forbid it living in `core` |
| Which tables RLS covers | `@awthaq/sql` `TenantScope` | Postgres (policies) | `coverage` is the pure planner; DDL is `enableRls` |
| Accepting a core table as a plugin `Derived` parent | `@awthaq/core` (`Auth.make` link-time check) | `@awthaq/sql` (the list) | link-time validation lives in core; the data it reads is sql's |
| Which tables a lagging read replica mirrors in tests | `@awthaq/test` (`LaggingReplica`) | `@awthaq/sql` (the list) | a test double; reads the catalogue, owns the copy loop |
| Which tables a BDD step may inspect for `"tenantId"` | `features` (step definitions) | `@awthaq/sql` | BDD side reads the catalogue, keeps the per-table insert switch |
| Sealed columns (AAD convention, sweep) | `@awthaq/sql` `CoreSealedColumns` / `SealedColumn` | none | the catalogue is a view over it, never a second list |
| Detecting list/migration drift | Test suite in `@awthaq/sql` (`TestSql.schemaOf`) | CI Postgres | a test, not runtime code: ADR-EA-004 forbids a schema IR |

## Standard Stack

No new packages. Everything used is already a workspace dependency.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `effect` | catalog (`4.x`, per repo) | `Effect`, `Migrator`, `SqlClient` used by the drift-guard test | repo-wide [VERIFIED: packages/sql/package.json devDependencies `"effect": "catalog:"`] |
| `@effect/vitest` | catalog | `it.effect`, `assert` | existing test idiom [VERIFIED: packages/sql/test/SqlDdl.test.ts:5] |
| `@awthaq/test` `TestSql` | in-repo (`packages/test/src/TestSql.ts`) | `layer(suite)` picks SQLite or a Postgres schema by `AWTHAQ_POSTGRES_URL`; `schemaOf` lists tables | existing; sql tests import it by relative path `../../test/src/TestSql.ts` [VERIFIED: packages/sql/test/SqlDdl.test.ts:9] |
| tsc | 7.0.2+effect-tsgo.0.67.4 | `tsc -b` gate; type-level prototype | [VERIFIED: `./node_modules/.bin/tsc -v`] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| In-test inline literals for the AAD pin | `toMatchFileSnapshot` like the plugin `Schema.lock.test.ts` files | A file snapshot is rewritten by `vitest -u`; an inline `deepStrictEqual` literal cannot be silently regenerated, which is the point of CAT-03's "cannot be added, removed or re-keyed silently" |
| Catalogue module in `@awthaq/sql` | Catalogue in `@awthaq/ports` | `ports < sql`, but the catalogue references `SealedColumn.Sweepable` and `CoreSealedColumns`, which live in `sql`; moving them is out of scope |

**Installation:** none. **Version verification:** nothing recommended is a new package.

## Package Legitimacy Audit

Not applicable: this phase installs no external package. **Packages removed due to SLOP verdict:** none. **Packages flagged SUS:** none.

## Architecture Patterns

### System Architecture Diagram

```
 CoreMigrations.ts (DDL, ids 1-29)        RateLimiterStoreSql.migrations (DDL, own ledger)
        |  creates 7 tables                        |  creates rate_limit_buckets (+ ledger)
        v                                          v
   [drift guard test: run both migrators on a fresh DB, list tables, compare to catalogue]
                                  ^
                                  | must equal
 CoreSealedColumns.ts ---- sealed view ----> CoreTables.ts  (THE list: name, owner, tenancy,
 (six declarations)                              replicated, sealed, reason?)   no types, no DDL
                                                   |
        +---------------+-------------+------------+----------------+
        v               v             v                             v
 TenantScope.ts    Auth.ts       LaggingReplica.ts            TenancySteps.ts
 partitionedTables  coreTables    coreTables                   STAMPED_TABLES
 directoryTables    -> isStamped  -> CoreTables.replicated     -> CoreTables.isStamped
 (derived views;    (Derived-     (default `tables` of         (assert in storedTenants)
  coverage reads    parent check) `catchUp`)
  them, unchanged)
        |
        v
 enableRls(options) -> ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY (Postgres only)
```

Import DAG inside `packages/sql/src` (no cycle): `SealedColumn.ts` <- `CoreSealedColumns.ts` <- `CoreTables.ts` <- `TenantScope.ts`. `CoreTables.ts` imports nothing from `TenantScope.ts`, `TenantScoped.ts` or `CoreMigrations.ts`. [VERIFIED: import lines read this session: `CoreSealedColumns.ts:11` imports only `./SealedColumn.ts`; `TenantScope.ts:39` imports `./TenantScoped.ts`; `TenantScoped.ts:12-19` imports only `@awthaq/ports` and `effect/*`; `CoreMigrations.ts:36-40` imports `@awthaq/ports` and `effect/*`]

### Recommended Project Structure
```
packages/sql/src/
├── CoreTables.ts            # NEW: the catalogue + derived views (no DDL, no column types)
├── TenantScope.ts           # partitionedTables/directoryTables become aliases of CoreTables views
├── CoreSealedColumns.ts     # unchanged (the six declarations stay the source of the sealed view)
└── index.ts                 # + export * as CoreTables from "./CoreTables.ts"
packages/sql/test/
├── CoreTablePins.test.ts    # NEW (Wave 0): literal oracle of today's lists, coverage matrix, AAD tuples, created-table set
└── CoreTables.test.ts       # NEW (Wave 1): shape, projections equal the oracle, drift guard on both dialects
packages/test/src/LaggingReplica.ts   # coreTables = CoreTables.replicated (export kept)
packages/core/src/Auth.ts             # coreTables const removed; line 886 -> CoreTables.isStamped
features/step-definitions/TenancySteps.ts   # STAMPED_TABLES removed; line 123 -> CoreTables.isStamped
```

### Pattern 1: Data-first catalogue with derived views (Recommended, Shape A)
**What:** a small module (a deep interface over eight literal rows): entries are an `as const` tuple in migration-creation order; the exported views (`partitionedTables`-style name lists, `replicated`, `stamped`, `isStamped`) are `filter`/`map` of that tuple; `sealed` is filled by filtering `CoreSealedColumns.deployed({ encryptPii: true })` on `table === name`. **Leverage:** one edit site per new core table; the drift guard fails the build if the migration and the row disagree. **Locality:** all classification reasons sit beside the row they justify.

Prototype compiled with the repo `tsc` (`--strict --declaration --emitDeclarationOnly`, exit 0) and produced these declarations [VERIFIED: ran `./node_modules/.bin/tsc` on the prototype in the session scratchpad]:
```typescript
// Source: prototype compiled this session (scratchpad), no `as` assertions
export type Tenancy = "partitioned" | "directory" | "none";
const declared = [
  { name: "users", tenancy: "directory", replicated: true },
  { name: "accounts", tenancy: "directory", replicated: true },
  { name: "sessions", tenancy: "partitioned", replicated: true },
  { name: "verification_tokens", tenancy: "partitioned", replicated: true },
  { name: "verification_reservations", tenancy: "partitioned", replicated: true },
  { name: "auth_audit_log", tenancy: "partitioned", replicated: true },
  { name: "auth_relay_cursor", tenancy: "none", replicated: false, reason: "..." },
  { name: "rate_limit_buckets", tenancy: "none", replicated: false, reason: "..." },
] as const;
type Declared = (typeof declared)[number];
export type CoreTableName = Declared["name"];
export type NamesWithTenancy<K extends Tenancy> = Extract<Declared, { readonly tenancy: K }>["name"];
// TypeScript infers the type predicate for `entry => entry.tenancy === "partitioned"`:
export const partitionedTables: ReadonlyArray<NamesWithTenancy<"partitioned">> = declared
  .filter((entry) => entry.tenancy === "partitioned")
  .map((entry) => entry.name);
// emitted: readonly ("auth_audit_log" | "sessions" | "verification_reservations" | "verification_tokens")[]
```
A generic helper `withTenancy<K>(k: K): ReadonlyArray<NamesWithTenancy<K>>` did **not** compile (TS2322 on the generic indexed access); write one explicit typed `const` per view instead. Declaring `ReadonlyArray<CoreTableName>` for `replicated` and `stamped` is sufficient.

### Catalogue design: three shapes and the recommendation

| Shape | What | Depth / leverage | Locality | Seam and adapters | Verdict |
|-------|------|------------------|----------|-------------------|---------|
| **A. Data-first catalogue, derived views (recommended)** | One module, one `as const` tuple, exported literal-typed views, `sealed` derived from `CoreSealedColumns` | High: one small interface (`tables`, five views, `isStamped`) hides the filtering; four consumers get leverage | All classification and reasons in one file next to each other | The module is the seam; the four consumers are adapters that only project | Recommend |
| B. Per-store self-registration | Each `*StoreSql` registers its table into a registry at import time | Nominally high leverage | Table facts sit beside the DDL users | Registration order depends on import graph; barrel side effects; `partitionedTables` order would no longer be fixed; a table nobody imports is silently absent, which is the drift being removed | Reject |
| C. Catalogue as tagged union reusing `TenantScoped.Tenancy` (`Partitioned{column}` / `Global{reason}`) | Same as A with `Data.TaggedEnum` tenancy | Free `reason` on `Global`; consistent with plugin vocabulary | Same as A | `directory` has no counterpart in `TenantScoped.Tenancy`; adding a variant changes the plugin-facing union and the exhaustive `switch` in `Auth.ts:857-866` and cli `describeTenancy` | Reject (widens a public union for a core-only distinction) |

Entry shape (Shape A): `name`, `owner: "core"` (fixed marker; decided in CONTEXT), `tenancy: "partitioned" | "directory" | "none"` (`none` means no `"tenantId"` column), `replicated: boolean`, `sealed: ReadonlyArray<SealedColumn.Sweepable>` (derived), `reason?: string` (non-empty when `tenancy === "none"` or `replicated === false`; enforced by a test, not by type gymnastics). Entries carry **no** column names, types, defaults, indexes or DDL: a key-set test (`Object.keys(entry)` must be a subset of the six names above) is the automated CAT-03 check against a creeping schema IR (ADR-EA-004 rejects "a closed `ColumnType` union driving per-dialect DDL rendering") [CITED: /Users/mohammadalmechkor/Projects/Perso/awthaq-arch/spec/decisions/004-database-neutral-models.md "Alternatives considered"].

Module name: `CoreTables.ts`; barrel line `export * as CoreTables from "./CoreTables.ts";` beside `CoreSealedColumns` (alphabetical, `packages/sql/src/index.ts:29`). The barrel export is required, not optional: `@awthaq/core`, `@awthaq/test` and `features` can only import the `@awthaq/sql` root (`exports` has only `"."`) [VERIFIED: packages/sql/package.json exports block].

Projections (all derived, none copied):
- `TenantScope.partitionedTables = CoreTables.partitionedTables`, `directoryTables = CoreTables.directoryTables` (keep the exported names and doc comments). `TenantScope.coverage` keeps reading those two names unchanged (`TenantScope.ts:103-108`), so the coverage diff is zero; the pin proves it.
- `Auth.ts`: delete the local `coreTables` (`:779-782`), replace `coreTables.includes(tenancy.parent)` (`:886`) with `CoreTables.isStamped(tenancy.parent)`. Import becomes `import { CoreTables, type SealedColumn, TenantScope, type TenantScoped } from "@awthaq/sql";` (`:22`).
- `LaggingReplica.ts`: `export const coreTables: ReadonlyArray<string> = CoreTables.replicated;` (export name and `ReadonlyArray<string>` type kept; no consumer imports it outside the file) [VERIFIED: `grep` for `LaggingReplica` found only `ReadRouting.test.ts`, `index.ts:16` and the file itself].
- `TenancySteps.ts`: delete `STAMPED_TABLES` (`:70-77`), `assert.ok(CoreTables.isStamped(table), ...)` at `:123`; add `CoreTables` to the `@awthaq/sql` import (`:17`). The per-table insert switch (`:437-495`) stays: it is behaviour (how to insert one row into each table), with a `default: assert.fail`.

### Anti-Patterns to Avoid
- **`Auth.ts` accepting every catalogue name:** makes `Derived("auth_relay_cursor", ...)` pass `checkTenancy`, then `coverage` skips it ("its parent table is not covered by this call"). Today it fails `UnknownParent`. Use `isStamped`.
- **Typing a view as the literal-union array and then calling `.includes(someString)`:** does not compile (verified with `@ts-expect-error` in the prototype). Hence `isStamped(name: string): boolean`, as `Auth.ts:779` already widens to `ReadonlyArray<string>` today.
- **Sorting inside a view:** order is a pinned contract; declare entries in creation order and never sort.
- **A `replicated` flag defaulting to true for opt-in tables:** `LaggingReplica.catchUp` runs `SELECT * FROM <table>` on the primary for every replicated table; an opt-in table that was never migrated would fail every test. A test asserts `replicated` is a subset of the tables `CoreMigrations` creates.
- **Importing `TenantScope` or `CoreMigrations` into `CoreTables.ts`:** closes a type-only cycle that `pnpm circular` counts.

## Q1: Re-grep census (exhaustive)

Scope: `packages/*/src`, `packages/*/test`, `features/`, `examples/`, `docs/`, `spec/`, `scripts/`, plus repo root. Commands: `grep -rnE 'verification_reservations'` (the one name present in every six-table list), `grep -rnE 'auth_relay_cursor|rate_limit_buckets'`, `grep -rnE 'partitionedTables|directoryTables|coreTables|STAMPED_TABLES|CORE_TABLES|CoreTables'`, `grep -rnE '"auth_audit_log"'`, `grep -rnE '"accounts"'`, `grep -rnE 'sqlite_master|information_schema|pg_tables|pg_catalog'`, `grep -rnE 'effect_sql_migrations|awthaq_plugin_migrations|awthaq_rate_limiter_migrations'`.

| # | Location | What it is | Class |
|---|----------|-----------|-------|
| 1 | `packages/sql/src/TenantScope.ts:45-50` `partitionedTables`, `:53` `directoryTables` | the two literal lists RLS covers | **Source today** (becomes derived views) |
| 2 | `packages/sql/src/TenantScope.ts:103-108` `coverage` | `partitionedTables.map(...)`, `directoryTables.map(...)` | Already a projection |
| 3 | `packages/core/src/Auth.ts:779-782` `coreTables` (used once, `:886`) | `[...TenantScope.partitionedTables, ...TenantScope.directoryTables]` | Already a projection (consumer of 1) |
| 4 | `packages/test/src/LaggingReplica.ts:31-38` `coreTables` (default of `make`, `:59`) | six names, order `users ... auth_audit_log`, exported | **Real copy** |
| 5 | `features/step-definitions/TenancySteps.ts:70-77` `STAMPED_TABLES` (used once, `:123`) | the same six, same order | **Real copy** |
| 6 | `features/step-definitions/TenancySteps.ts:437-495` per-table `switch (table)` | how to insert one row into each of the six; `default: assert.fail` | Per-table behaviour, not a list (kept; fails loudly on an unlisted table) |
| 7 | `features/features/12-multi-tenancy/28-tenancy.feature:65-72`, `:80-87` Examples tables | the six names as Gherkin data | Not a table list in code (cannot project; they drive row 6) |
| 8 | `packages/sql/test/TenantScoped.test.ts:167-171` | `deepStrictEqual(tables(undefined), [...TenantScope.partitionedTables])` | A relative assertion: it pins nothing if both sides move together (see Pitfall 1) |
| 9 | `packages/sql/src/{User,Account,Session}StoreSql.ts` `tableName: "users" / "accounts" / "sessions"` (`UserStoreSql.ts:139`, `AccountStoreSql.ts:94`, `SessionStoreSql.ts:125`) | one table per adapter | Not a list |
| 10 | `packages/sql/src/CoreSealedColumns.ts:14-53` `table: "users" / "sessions" / "accounts"` | sealed-column declarations | Source of the sealed view (stays) |
| 11 | `packages/sql/src/CoreMigrations.ts` (`CREATE TABLE` at `:75,98,131,164,200,324,607` and `users_rebuild` `:473`) | DDL | Source of truth for the guard; not a list |
| 12 | `packages/sql/src/RateLimiterStoreSql.ts:43-59`, `:68` | creates `rate_limit_buckets` under ledger `awthaq_rate_limiter_migrations` | Unclassified table creation (classified by this phase) |
| 13 | `packages/test/src/StoreContract.ts:154-159` `migratedClient` | runs `CoreMigrations.coreMigrations`, then `RateLimiterStoreSql.migrate` | Consumer of both migrators, no list |
| 14 | `packages/test/src/internal/storeContract/rateLimiterStore.ts:93,102` | `SELECT bucket_key FROM rate_limit_buckets`, `DROP TABLE rate_limit_buckets` | Reader of `rate_limit_buckets`; not a list |
| 15 | `packages/test/src/TestSql.ts:202` `ledgers = ["effect_sql_migrations", "awthaq_plugin_migrations"]` | ledger names excluded by `schemaOf` | A ledger list (not core tables). It omits `awthaq_rate_limiter_migrations`; out of scope, handled in the guard (see Q5) |
| 16 | `packages/test/src/internal/contractRunner.ts:189` | `NOT IN ('effect_sql_migrations', pluginMigrationsTable)` | Ledger exclusion; not a core-table list |
| 17 | `packages/core/src/Migrations.ts:43,77` `pluginMigrationsTable`, `coreMigrationsTable` | ledger name constants | Not core tables |
| 18 | `packages/core/test/{Retention,Verification,AuthEventsUnitOfWork,Accounts,FederatedIdentitySql}.test.ts`, `packages/sql/test/{VerificationStoreSql,CoreStoresSql}.test.ts`, `packages/cli/test/Import.test.ts` | per-table counts, failure injection, per-column timestamp lists (`CoreStoresSql.test.ts:352-360`) | Not a table list |
| 19 | `features/step-definitions/{VerificationSteps.ts:840,894, CompositionSteps.ts:700-704, MigrationFixtures.ts:124, PersistenceMigrationSteps.ts:510, CliSteps.ts:91}` | assertions on `users/accounts/sessions` being present, ledger rows, raw SQL on one table | Not a table list; `PluginFixtures.ts:121-137` `"sessions"`/`"users"` are plugin ids |
| 20 | `packages/cli/src/{Doctor,Sources,Plugin,Migration}.ts` | no core table names; `Plugin.ts:60-70` `describeTenancy` is a formatter of the plugin `TenantScoped.Tenancy` | Not a list |
| 21 | `packages/core/src/Retention.ts`, `packages/sql/src/{ReadRouting,SqlDdl,StoreFailure}.ts`, `scripts/*.mjs`, `examples/*` | none name a core table list | Not a list |
| 22 | Prose copies: `spec/behaviors/28-tenancy.md:34-36` (BEH-EA-231), `spec/decisions/018-tenancy-is-an-organization.md:25`, `spec/decisions/016`, `spec/decisions/004:41`, `packages/sql/README.md:126,135,150`, `spec/overview.md:48`, `spec/traceability.md:201`, `spec/decisions/030-...:26`, `spec/behaviors/13-events.md:79` | documentation of the six tables | Prose; update `28-tenancy.md`, README `:126`/`:150`, `overview.md:48` to name the catalogue; the others are historical decision text, leave |
| 23 | `packages/sql/lib/*`, `packages/test/lib/*`, `packages/qadi/lib/*` | `tsc -b` output (gitignored: `.gitignore` line 2 `lib/`; `git check-ignore packages/sql/lib packages/test/lib` printed both) | Generated; not source |
| 24 | `.plan/`, `.scratch/`, `.issues/`, `.planning/` history, `*-dashboard.html` | planning history | Not code |

**Where the two unclassified tables are created, by what ledger, who reads them:**
- `auth_relay_cursor`: created by core migration 27, `migration(27, "create_auth_relay_cursor", ...)` at `CoreMigrations.ts:603`, ledger `effect_sql_migrations` (the `Migrator` default). Read and written only by `RelayCursorStoreSql.ts` (`get` `:30-35`, `advance` `:38-54`) and renamed in two failure tests (`packages/sql/test/RelayCursorStoreSql.test.ts:32`, `packages/core/test/EventRelay.test.ts:379`). [VERIFIED: files read]
- `rate_limit_buckets`: created by `RateLimiterStoreSql.migrations` (`create_rate_limit_buckets`, `RateLimiterStoreSql.ts:43`), run by `RateLimiterStoreSql.migrate` under ledger `"awthaq_rate_limiter_migrations"` (`:68`), deliberately **outside** `CoreMigrations` ("an application that keeps rate limits in memory should not get a table it never uses", `:35-36`). Read and written by `RateLimiterStoreSql.layerStoreSqlWith` (`:83-163`, `upsert`, `peek`, `sweep`) and by the store contract (`StoreContract.ts:158`, `rateLimiterStore.ts:93,102`). Wired in `examples/sql-server/app.ts:85-86` and `packages/sql/test/fixtures/readme-quickstart.ts:45-46`. [VERIFIED]

**CAT-04 disposition (to record in the plans):** more than the `LaggingReplica` copy is real (`TenancySteps.STAMPED_TABLES` too) and two tables were unclassified, so the minimal-fix branch is not taken; the candidate closes with the catalogue. Closing census, expected counts (command: `grep -rnE '"verification_reservations"' packages/*/src features/step-definitions`): today 4 lines (`TenantScope.ts:48`, `LaggingReplica.ts:36`, `TenancySteps.ts:75`, `TenancySteps.ts:482`); after the phase 2 lines (`CoreTables.ts` and the `case` label at `TenancySteps.ts`).

## Q2: Today's behaviour to pin before any `src` change

Values quoted verbatim from files read this session.

**`TenantScope` lists** [VERIFIED: packages/sql/src/TenantScope.ts:44-53]:
```typescript
export const partitionedTables = [
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
] as const;
/** The global identity directory (DRS-005): unique across tenants, RLS only on request. */
export const directoryTables = ["users", "accounts"] as const;
```
Declared d.ts today: `readonly ["sessions", "verification_tokens", "verification_reservations", "auth_audit_log"]` and `readonly ["users", "accounts"]` [VERIFIED: packages/sql/lib/TenantScope.d.ts:7,9 (build output)].

**`TenantScope.coverage` option matrix.** From `TenantScope.ts:103-150` [VERIFIED]: base `covered` is `partitionedTables.map(table => ({ table, kind: "column", column: "tenantId" }))`; `includeDirectory === true` appends `directoryTables` with the same shape; each declared `Partitioned` plugin table is appended (`column: entry.tenancy.column`); `Keyed` only when `includeKeyed === true`; `Derived` tables are resolved by repeated passes against `covered`, else land in `skipped` with the reason `"its parent table is not covered by this call"`. Expected outputs the pin captures (Wave 0 records them at HEAD by running the function, not by hand):

| Option | `covered[].table` in order | `skipped` |
|--------|---------------------------|-----------|
| `undefined` | sessions, verification_tokens, verification_reservations, auth_audit_log (each `{kind:"column", column:"tenantId"}`) | `[]` |
| `{ includeDirectory: true }` | the four above, then users, accounts | `[]` |
| `{ plugins: declared }` | four core, then `webhooks_endpoint`, then `webhooks_delivery` (`kind:"parent"`), then `organization_active_context` (`kind:"parent"`, parent `sessions`) | `organization_team_membership` |
| `{ plugins: declared, includeKeyed: true }` | adds `organization_org`, `organization_team`, `organization_team_membership` | `[]` |
| `{ includeDirectory: true, plugins: declared, includeKeyed: true }` | all of the above plus users, accounts | `[]` |

`declared` is the fixture in `packages/sql/test/TenantScoped.test.ts` (`describe("TenantScope.coverage")`, lines ~138-165); the existing assertions there use `include`/`notInclude` on table names and one `deepStrictEqual` on `webhooks_delivery`, so the **whole-structure** pin (`deepStrictEqual` on the full `{ covered, skipped }`) is new. The rows above for plugin cases are my reading of the code, not an executed result: Wave 0 must run and freeze the real output.

**`Auth.ts`** [VERIFIED: packages/core/src/Auth.ts:779-782 and :882-891]:
```typescript
const coreTables: ReadonlyArray<string> = [
  ...TenantScope.partitionedTables,
  ...TenantScope.directoryTables,
];
```
```typescript
    if (parent === undefined) {
      if (coreTables.includes(tenancy.parent)) continue;
      throw invalid(
        entry,
        "UnknownParent",
```
The only use is `:886` (the Derived-parent check inside `checkTenancy`, `:842-`). The `UndeclaredTableDependency` check near `:757-775` (`checkTableDependencies`) builds `ownerOf` from **plugin** `plugin.tables` only and skips tables with no plugin owner (`if (owner === undefined || owner.id === plugin.id) continue;`), so it does not read the core list and stays unchanged. Existing pins: `packages/core/test/AuthTenancy.test.ts:45-58` ("accepts a core table as a Derived parent" using `sessions`; refuses `stranger_a` as `UnknownParent`). **Gap to pin:** a Derived parent of `users`, `accounts`, `verification_tokens`, `verification_reservations`, `auth_audit_log` is accepted; a Derived parent of `auth_relay_cursor`, `rate_limit_buckets` is refused `UnknownParent`. Neither is tested today.

**`LaggingReplica`** [VERIFIED: packages/test/src/LaggingReplica.ts:30-38, :59-74]:
```typescript
export const coreTables: ReadonlyArray<string> = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
];
```
`make` uses `options.tables ?? coreTables`; `catchUp` loops `for (const table of tables)`: `SELECT * FROM ${primary(table)}`, `DELETE FROM ${replica(table)}`, then `INSERT ... replica.insert(rows)`. **Order does not matter functionally:** the core DDL has no foreign keys (`grep -nE 'REFERENCES|FOREIGN|foreign_keys' packages/sql/src/*.ts` printed nothing) and each table is deleted and refilled independently. It is pinned anyway, because the catalogue order makes it free.

**`TenancySteps.STAMPED_TABLES`** [VERIFIED: features/step-definitions/TenancySteps.ts:69-77]: same six, same order as `LaggingReplica`; the only use is `assert.ok(STAMPED_TABLES.includes(table), ...)` at `:123` inside `storedTenants`. The literal is private, so it is pinned two ways: the BDD outline rows (`28-tenancy.feature:65-72,80-87`, which fail if a stamped table drops out of the switch) and, after the change, the unit assertion `CoreTables.stamped` equals the six-name literal.

**The six sealed columns and their AADs** [VERIFIED: packages/sql/src/CoreSealedColumns.ts:14-67 and SealedColumn.ts:94-96]:
```typescript
export const usersMetadata = SealedColumn.column({ table: "users", column: "metadata", key: "id", adoptPlaintext: true });
export const sessionsIpAddress = SealedColumn.column({ table: "sessions", column: "ipAddress", key: "id", adoptPlaintext: true });
export const sessionsUserAgent = SealedColumn.column({ table: "sessions", column: "userAgent", key: "id", adoptPlaintext: true });
export const accountsAccessToken = SealedColumn.column({ table: "accounts", column: "accessToken", key: "id" });
export const accountsRefreshToken = SealedColumn.column({ table: "accounts", column: "refreshToken", key: "id" });
export const accountsIdToken = SealedColumn.column({ table: "accounts", column: "idToken", key: "id" });
export const providerTokens = [accountsAccessToken, accountsRefreshToken, accountsIdToken];
export const personalData = [usersMetadata, sessionsIpAddress, sessionsUserAgent];
export const deployed = (options) => options.encryptPii ? [...providerTokens, ...personalData] : providerTokens;
export const aadOf = (declared, rowKey) => `${declared.table}:${rowKey}:${declared.column}`;
```
(shortened from the file; the object literals above are the exact field values; `adoptPlaintext` defaults to `false` in `validated`, `SealedColumn.ts:76`.) The AAD is built by `aadOf`, one convention `<table>:<rowKey>:<column>`. Where it is pinned today: `deployed(...)` **order and names** only (`packages/test/test/CoreSealedColumns.test.ts:416-421` and `:430-445`, which expect `accounts.accessToken, accounts.refreshToken, accounts.idToken, users.metadata, sessions.ipAddress, sessions.userAgent`), and the AAD *convention* on a synthetic column (`packages/sql/test/SealedColumn.test.ts:91`). **No test pins `key` or `adoptPlaintext` of the six, or their rendered AADs.** The new pin therefore freezes, for `deployed({ encryptPii: true })` in that order: `{ table, column, key, adoptPlaintext, aad: aadOf(col, "<id>") }`, giving the AAD strings `accounts:<id>:accessToken`, `accounts:<id>:refreshToken`, `accounts:<id>:idToken`, `users:<id>:metadata`, `sessions:<id>:ipAddress`, `sessions:<id>:userAgent`, plus `deployed({ encryptPii: false })` equals the first three.

### Pin matrix (Wave 0, all green on unchanged `src`, committed before the first `src` edit)

| # | Pin | Where | Frozen value |
|---|-----|-------|-------------|
| P1 | `TenantScope.partitionedTables` and `directoryTables` literals | new `packages/sql/test/CoreTablePins.test.ts` | the two arrays above, `deepStrictEqual` to inline literals |
| P2 | `TenantScope.coverage` full output, 5 option cases | same file | full `{ covered, skipped }` for each row of the matrix |
| P3 | sealed declaration list and AADs | same file | six tuples above + AAD strings + `deployed({encryptPii:false})` |
| P4 | tables created by core and by core + rate limiter | same file, `TestSql.layer("sql_CoreTablePins")` | core: `accounts, auth_audit_log, auth_relay_cursor, sessions, users, verification_reservations, verification_tokens`; with `RateLimiterStoreSql.migrate`: those plus `awthaq_rate_limiter_migrations` (ledger) and `rate_limit_buckets` (same on SQLite and Postgres, probed) |
| P5 | `LaggingReplica.coreTables` | new `packages/test/test/LaggingReplica.test.ts` | the six-name array, order included |
| P6 | Derived-parent acceptance/refusal for the 7 non-`sessions` names | extend `packages/core/test/AuthTenancy.test.ts` | users, accounts, verification_tokens, verification_reservations, auth_audit_log accepted; auth_relay_cursor, rate_limit_buckets refused with `cause === "UnknownParent"` |
| P7 | `STAMPED_TABLES` literal | `05-BASELINE.md` text pin: `sed -n 70,77p features/step-definitions/TenancySteps.ts`, plus the BDD outlines | the six names |
| P8 | RLS table set on Postgres | extend `packages/sql/test/TenantScope.postgres.test.ts` (existing `describe.skipIf(skip)`), new `it.effect` beside `:176` | after `enableRls({ includeDirectory: true })`, `pg_class.relrowsecurity` is true for exactly the six stamped tables and false for `auth_relay_cursor` (and `rate_limit_buckets` when migrated) |

## Q3: Public surface, edges and the spec fan-out (Q6 of the brief)

**Dependency edges (no change)** [VERIFIED from `package.json` files read this session]:
- `@awthaq/core` depends on `@awthaq/sql` (`"@awthaq/sql": "workspace:*"` under dependencies): the `core -> sql` edge exists, so `Auth.ts` importing `CoreTables` from `@awthaq/sql` changes nothing.
- `@awthaq/test` depends on `@awthaq/sql` (dependencies) and on `@awthaq/core`.
- `@awthaq/features` lists `@awthaq/sql` under `devDependencies` (`features/package.json`).
- `@awthaq/sql` depends on `@awthaq/api` and `@awthaq/ports` only; `CoreTables.ts` imports `./CoreSealedColumns.ts` and nothing else in-package, no new dependency.

**Barrel:** export `CoreTables` from `packages/sql/src/index.ts`. `pnpm knip` treats the root export as the package entry, so exported members are not flagged unused; Phase 3 added `KeysetSql` the same way with the knip filtered output unchanged [CITED: 04-BASELINE.md knip row; precedent only]. Run `pnpm knip` and expect the baseline (39 `.claude/` files, 3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`). `pnpm check:readmes` only checks the "planned package" banner against `src/` [VERIFIED: scripts/check-readme-status.mjs:14-47], so it cannot be affected. `spec:verify:strict` check 13 compares the `<!-- surface:ports -->` block in `overview.md` with `packages/ports/src/index.ts` [VERIFIED: spec/scripts/check-drift.mjs:184-200]; the `sql` barrel is not checked, so check 13 is unaffected. Check 10 (`:86-112`) fails when `spec/invariants.md` or `spec/traceability.md` cite a `packages/...` path that does not exist unless the line says "Planned:" or "does not exist": every test file the traceability rows name must exist at that commit. Check 14 (`:203-225`) requires each touched spec document's `Revision` equal to the newest Change History entry.

**`@awthaq/test` `LaggingReplica.coreTables`:** keep the export (CONTEXT); its only in-repo consumer is `make` in the same file. It is part of the published `@awthaq/test` surface (`packages/test/src/index.ts:16` `export * as LaggingReplica`).

**Spec and README documents to touch, with current revisions** [VERIFIED: header lines read]:
| Document | Now | Edit |
|----------|-----|------|
| `spec/behaviors/28-tenancy.md` | Revision 1.15 | BEH-EA-231 (`:34-36`) names the six tables in the REQUIREMENT block: add that the list is `CoreTables` in `@awthaq/sql` (stamped = `tenancy !== "none"`); bump to 1.16 with a Change History entry |
| `spec/overview.md` | Revision 1.18 | package-map row (`:48`) lists `SealedColumn` and `CoreSealedColumns`: add `CoreTables`; bump to 1.19 |
| `spec/traceability.md` | Revision 1.93 | rows for the new test files (`CoreTablePins.test.ts`, `CoreTables.test.ts`, `LaggingReplica.test.ts`), mapped to BEH-EA-231/232/233/037 (planner to confirm ids); bump to 1.94 |
| `packages/sql/README.md` | n/a | `:126` "Tenant columns (24-25)" and `:150` comment list the tables: say they are the catalogue's stamped tables; add one short "Core tables" paragraph naming `CoreTables` and the two classified exclusions |
| `spec/behaviors/05-persistence-stratum.md` (1.14), `spec/decisions/004` (1.3), `spec/decisions/018` (1.7), `spec/decisions/024` (1.2) | | No edit required. ADR-EA-004 is the constraint, not the subject; do not bump it unless the planner wants the key-set test recorded there (optional, then bump Revision and Change History together) |

**Changeset (one candidate, one changeset), `.changeset/core-table-catalogue.md`:** `@awthaq/sql: minor` (new `CoreTables` export; the types of `TenantScope.partitionedTables`/`directoryTables` move from a readonly tuple to `ReadonlyArray` of the literal-name union), `@awthaq/test: patch` (same behaviour), `@awthaq/core: patch` (internal only). The packages are in one `fixed` group (`.changeset/config.json`) so they version together regardless. `Migration:` line (precedent: `keyset-page-module.md`, `connection-lifecycle-module.md`): none needed for the lists' values; state that code relying on the exact tuple type of `partitionedTables`/`directoryTables` (indexing by a literal position) must widen, and that `LaggingReplica.coreTables` is unchanged.

## Q4: Classification decisions

| Table | tenancy | replicated | Reason (goes in `reason`) | Evidence |
|-------|---------|-----------|---------------------------|----------|
| users | directory | true | | `directoryTables`; `TenantScope.ts:52` comment "global identity directory (DRS-005)" |
| accounts | directory | true | | same |
| sessions | partitioned | true | | `partitionedTables` |
| verification_tokens | partitioned | true | | same |
| verification_reservations | partitioned | true | | same |
| auth_audit_log | partitioned | true | | same |
| auth_relay_cursor | **none** | **false** | "No tenant column: one row per named relay, deployment-wide (migration 27 declares only `name`, `lastEventId`, `updatedAt`). Never read from a replica: a relay must never resume from a stale position." | DDL `CoreMigrations.ts:607-611` quoted below; `RelayCursorStoreSql.ts:6` "`get`: one read of the primary (a relay must never resume from a replica's stale position)"; the adapter has no `Tenant.resolve` stamp |
| rate_limit_buckets | **none** | **false** | "No tenant column: a bucket is keyed by `bucket_key` alone. A read-modify-write counter (one atomic upsert `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, plus `peek` for escalation's block check), always on the primary; never replica-eligible. Opt-in table: created by `RateLimiterStoreSql.migrate`, not `CoreMigrations`, so a test replica of an unmigrated database must not copy it." | DDL `RateLimiterStoreSql.ts:49-53`; `layerStoreSqlWith` uses only the ambient `sql`, never `ReadRouting.ReplicaSqlClient` (`:83-163`); ADR-EA-024 decision 2 |

Migration 27 DDL, verbatim [VERIFIED: packages/sql/src/CoreMigrations.ts:603-621 (sqlite branch last line `"updatedAt" TEXT NOT NULL`)]:
```text
CREATE TABLE auth_relay_cursor (
  name TEXT PRIMARY KEY,
  "lastEventId" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
)
```
`rate_limit_buckets` DDL [VERIFIED: packages/sql/src/RateLimiterStoreSql.ts:49-53]: `bucket_key TEXT PRIMARY KEY, hit_count INTEGER NOT NULL, reset_at_ms DOUBLE PRECISION NOT NULL`. Neither has a `"tenantId"` column, so `tenancy: "none"` is a fact of the schema, not a choice.

**Correction to CONTEXT (record in the plans):** CONTEXT justifies excluding `rate_limit_buckets` from replication with "a limit must not be multiplied by the replica count, `RateLimiterStoreSql.ts` header". The header says "every replica counts against the same `rate_limit_buckets` rows, so a limit is not multiplied by the replica count the way `RateLimiter.layerStoreMemory`'s per-process `Ref` multiplies it" [VERIFIED: packages/sql/src/RateLimiterStoreSql.ts:3-8]. "Replica" there is an **application replica** (a process), not a database read replica. The exclusion stands (CONTEXT locks it) but its reason is the read-routing one above, which the `reason` text must use. ADR-EA-024 decision 2 [CITED: /Users/mohammadalmechkor/Projects/Perso/awthaq-arch/spec/decisions/024-read-replica-routing.md:24]: "Replica-eligible are **display/history listings only**: `SessionStore.listLive` ... and `AuditLogStore.select`/`pageAfter`", with everything else primary-pinned.

**What `replicated` means (record, so the field is not over-read):** "`LaggingReplica` mirrors this table's rows" (test-side) which equals "a replica holds this table's rows meaningfully". It is **not** ADR-EA-024's replica-*eligible read* set (only `sessions` and `auth_audit_log` have an `eventual` read path today), and the catalogue must not be used to derive routing. Document that in the entry type's doc comment.

**Other tables found:** none. Ledger tables (`effect_sql_migrations`, `awthaq_plugin_migrations`, `awthaq_rate_limiter_migrations`) and plugin tables are out of scope and are excluded from the guard by name. `users_rebuild` (migration 21 SQLite rebuild) is renamed to `users` and does not survive (`CoreMigrations.ts:473-486`); the probe confirms it is absent.

## Q5: Drift guard feasibility (probed)

A throwaway test in the session scratchpad (outside the repo) ran `Migrator.make({})({ loader: CoreMigrations.coreMigrations })`, then `TestSql.schemaOf`, then `RateLimiterStoreSql.migrate`, then `TestSql.schemaOf` again, under `TestSql.layer(...)`. Output [VERIFIED: executed; identical on SQLite and on `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq`, PostgreSQL 16.16]:
```text
CORE: ["accounts","auth_audit_log","auth_relay_cursor","sessions","users","verification_reservations","verification_tokens"]
BOTH: ["accounts","auth_audit_log","auth_relay_cursor","awthaq_rate_limiter_migrations","rate_limit_buckets","sessions","users","verification_reservations","verification_tokens"]
```
The probe's Postgres schema (`t_probe_catalogue`) was not left behind (cleanup ran). Mechanics for the planner:
- Use `TestSql.layer("sql_CoreTables")` from the sql test with the relative import `../../test/src/TestSql.ts` (the `SqlDdl.test.ts` idiom). One file runs on SQLite by default and on Postgres under `AWTHAQ_POSTGRES_URL`, each build getting a fresh schema. No dialect branching in the guard.
- `schemaOf` already excludes `effect_sql_migrations` and `awthaq_plugin_migrations` but **not** `awthaq_rate_limiter_migrations` (`TestSql.ts:202`). The guard filters `RateLimiterStoreSql.migrationsTable` itself; do not edit `TestSql.ts` (it is Postgres infrastructure excluded from coverage and outside this phase).
- Guard assertions (sorted-name set equality, so failures print the difference):
  1. Do not hard-code `rate_limit_buckets` as an exception in the test. Run the two migrators in sequence and assert: tables after core are a **subset** of the catalogue names (every table `CoreMigrations` creates is classified), and tables after core + rate limiter, minus the rate-limiter ledger, **equal** the catalogue names (nothing is classified that no migrator creates).
  2. every `replicated` entry is among the tables created after core only (an opt-in table cannot be replicated).
  3. every `sealed` column's `table.column` exists as a column in `shape.tables[table]` (a sealed declaration on a column that migrations never create fails), and the flattened `sealed` of the catalogue has the same `table.column` set and count as `CoreSealedColumns.deployed({ encryptPii: true })` (the derived filter cannot silently drop a column whose table is unlisted).
  4. every entry with `tenancy !== "none"` has a `tenantId` column and every entry with `tenancy === "none"` has none (`shape.tables[name]` column names): ties the classification to the schema without storing types in the catalogue.
  5. every entry with `tenancy === "none"` or `replicated === false` has a non-empty `reason`.
- A new opt-in store with its own migrator (a hypothetical third) is not covered by construction; the test header says so. This is the "documented exception" CONTEXT allows, narrowed to one sentence.
- Postgres leg: the same file; plus P8 (RLS) in `TenantScope.postgres.test.ts`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Listing tables created by migrations | a bespoke `sqlite_master`/`information_schema` query in the guard | `TestSql.schemaOf` (`packages/test/src/TestSql.ts:349`) | already dialect-split, tested by `TestSqlSchema.test.ts`; also gives columns for assertions 3 and 4 |
| Per-dialect fresh database per test file | a `PgClient.layer` + `DROP SCHEMA` block as in `CoreMigrations.postgres.test.ts` | `TestSql.layer(suite)` | picks SQLite or a Postgres schema by env var; handles the `regclass` codec quirk for a second migrator run |
| AAD rendering in the pin | string concatenation in the test | `SealedColumn.aadOf(column, "<id>")` for the computed side, inline literals for the expected side | the test must compare the real convention against frozen text |
| Tuple-preserving views | `as` casts | inferred type predicate over an `as const` tuple (prototype) | `consistent-type-assertions: never` in `packages/*/src` |
| Schema description (column types, DDL) in the catalogue | a mini schema IR | nothing: key-set test + the guard reading real migrations | ADR-EA-004 rejects the IR |

**Key insight:** the catalogue is a classification, not a schema. Every attempt to make it describe columns reintroduces the IR ADR-EA-004 rejected; the guard compares it with the real database instead.

## Runtime State Inventory

Not a rename/refactor of stored strings: no table, column, key or id is renamed and no row changes. Stored data: none (no rename; verified by scope). Live service config: none. OS-registered state: none. Secrets/env vars: none (`AWTHAQ_POSTGRES_URL` is test-only). Build artifacts: `packages/*/lib` are regenerated by `tsc -b`, which `test:bdd` needs (the `@awthaq/sql` export `"import"` resolves to `./lib/index.js`); GATE-01 already orders `tsc -b` before every cross-package vitest run. The sealed AADs are unchanged, so no data migration and no re-seal.

## Common Pitfalls

### Pitfall 1: A relative assertion pins nothing
**What goes wrong:** `TenantScoped.test.ts:167-171` asserts `tables(undefined) == [...TenantScope.partitionedTables]`; if both sides derive from a reordered catalogue the test still passes. **How to avoid:** P1/P2 compare to inline literals. **Warning sign:** any new test that reads the list it is meant to guard.

### Pitfall 2: Order drift
**What goes wrong:** declaring the catalogue alphabetically or by tenancy group changes `partitionedTables` order (and `coverage` order, which is the order `enableRls` issues DDL) or `LaggingReplica`/`STAMPED_TABLES` order. **How to avoid:** migration-creation order; P1, P2, P5 and the stamped literal fail on any change.

### Pitfall 3: `Auth.ts` accepting non-stamped tables as Derived parents
See Anti-Patterns. P6 is the guard. `isStamped` is defined as "named in the catalogue and `tenancy !== "none"`".

### Pitfall 4: `includes(string)` on a literal-union array
Does not compile. Keep `isStamped(name: string)`; keep `LaggingReplica.coreTables: ReadonlyArray<string>`.

### Pitfall 5: TS2883 / declaration emit
New exported types (`CoreTable`, `Tenancy`, `CoreTableName`, `NamesWithTenancy`) must be exported or inline-able; the prototype's `declare const declared` and `type Declared` are emitted into the d.ts as local declarations (no TS2883). Re-run `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` after the first catalogue commit; `packages/test` re-exports `LaggingReplica` through `@awthaq/test`, the place a non-nameable inferred type would surface. Annotate every exported `const` with an explicit type.

### Pitfall 6: Strata and `pnpm circular`
`CoreTables.ts` must import only `./CoreSealedColumns.ts` (and type-only `./SealedColumn.ts` if needed). `TenantScope.ts` importing `CoreTables.ts` adds one edge in a DAG. `pnpm circular` counts type-only imports (CONTEXT; `scripts/circular.mjs` runs a type-inclusive pass).

### Pitfall 7: Opt-in table in the replicated view
`LaggingReplica.catchUp` fails on a missing table. Guard assertion 2.

### Pitfall 8: Known flaky tests
Two documented intermittents: `packages/passkey/test/Contract.test.ts` "ChallengeStore (sql) > consume [atomic]: false for any other value, a tampered one included", and `packages/organization/test/TenantMiddleware.test.ts` "a suspended organization still resolves (the plugin's own gate refuses it)" [CITED: .planning/phases/04-connection-lifecycle-module/04-BASELINE.md "Known intermittents" items 1-2]. Rule from that file: one re-run; a command whose only failures are these is re-run, not diagnosed. Neither touches the catalogue.

### Pitfall 9: `knip` unlisted-dependency baseline
`packages/sql/test/fixtures/readme-quickstart.ts` already produces 3 unlisted dependencies; the new sql tests must not add imports of `@awthaq/*` packages that `packages/sql/package.json` does not list. Import `TestSql` by relative path (as `SqlDdl.test.ts` does), and import `@awthaq/ports` only (already a dependency).

## Code Examples

### Drift guard skeleton (the shape the planner should task; names are suggestions)
```typescript
// Source: composed from packages/sql/test/SqlDdl.test.ts (TestSql.layer idiom) and the probe run this session
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as CoreTables from "../src/CoreTables.ts";
import * as RateLimiterStoreSql from "../src/RateLimiterStoreSql.ts";
import * as TestSql from "../../test/src/TestSql.ts";

const tablesNow = Effect.map(TestSql.schemaOf, (shape) =>
  Object.keys(shape.tables).filter((name) => name !== RateLimiterStoreSql.migrationsTable).sort(),
);

describe("CoreTables drift guard", () => {
  it.effect("every table a migration creates is classified, and every classified table is created", () =>
    Effect.gen(function* () {
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      const afterCore = yield* tablesNow;
      yield* RateLimiterStoreSql.migrate;
      const afterBoth = yield* tablesNow;
      const classified = [...CoreTables.names].sort();
      for (const name of afterCore) assert.include(classified, name);
      assert.deepStrictEqual(afterBoth, classified);
      for (const name of CoreTables.replicated) assert.include(afterCore, name);
    }).pipe(Effect.provide(TestSql.layer("sql_CoreTables"))),
  );
});
```
`CoreTables.names` is one more view (`declared.map((entry) => entry.name)`); keep the public view set to: `tables`, `names`, `partitionedTables`, `directoryTables`, `stamped`, `replicated`, `isStamped`.

### AAD pin (frozen literals, no snapshot file)
```typescript
// Source: values from packages/sql/src/CoreSealedColumns.ts:14-67; expected side is inline text on purpose
assert.deepStrictEqual(
  CoreSealedColumns.deployed({ encryptPii: true }).map((c) => [c.table, c.column, c.key, c.adoptPlaintext, SealedColumn.aadOf(c, "<id>")]),
  [
    ["accounts", "accessToken", "id", false, "accounts:<id>:accessToken"],
    ["accounts", "refreshToken", "id", false, "accounts:<id>:refreshToken"],
    ["accounts", "idToken", "id", false, "accounts:<id>:idToken"],
    ["users", "metadata", "id", true, "users:<id>:metadata"],
    ["sessions", "ipAddress", "id", true, "sessions:<id>:ipAddress"],
    ["sessions", "userAgent", "id", true, "sessions:<id>:userAgent"],
  ],
);
```

## State of the Art

| Old Approach | Current Approach | When | Impact |
|--------------|------------------|------|--------|
| Three hand-kept six-name lists plus two lists RLS reads | One catalogue in `@awthaq/sql`, four derived projections | This phase | adding a core table is one row plus a migration; the guard fails otherwise |
| `LaggingReplica.coreTables` silently missed `auth_relay_cursor` (added later by migration 27) | the guard fails when a migration adds a table the list does not classify | This phase | exactly the drift this phase removes |

**Deprecated/outdated:** the comment "The core tables `@awthaq/sql`'s `CoreMigrations` creates" on `LaggingReplica.coreTables` (`LaggingReplica.ts:30`) is wrong today (it omits one); it is replaced by a doc comment pointing at `CoreTables.replicated`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `pnpm knip` does not flag members of a namespace re-exported from the package entry (`export * as CoreTables`) | Q3 | A new knip finding; fix by using each exported member or trimming the view set |
| A2 | The `coverage` rows for the plugin option cases in the Q2 table are as computed from reading the code | Q2 | Wave 0 freezes real output, so a misreading only affects this document, not the pin |
| A3 | BEH-EA-231/232/233/037 are the right behaviour ids for the traceability rows | Q3 | Planner re-reads `spec/traceability.md` and the ids; trace-check 10 only needs paths to exist |
| A4 | `@awthaq/test: patch` and `@awthaq/core: patch` are accepted bump levels in the one `fixed` group | Q3 | Changeset review changes the level; the fixed group versions them together anyway |
| A5 | A changeset `Migration:` line stating "no code change needed except widening a literal-position index on the two lists" satisfies GATE-03 | Q3 | User may prefer `Migration: none`; wording only |
| A6 | `tsgo`'s inferred type predicate over a union filter also holds in the vitest/esbuild transpile (transpile-only, no type check) | Pitfall 5 | None at runtime: predicates erase; type errors surface only in `tsc -b` |

## Open Questions

None for the user. Resolved here under the cleanest-end-state rule, to be recorded in the plans:
1. **`replicated` semantics** = "mirrored by `LaggingReplica`", not routing eligibility (Q4).
2. **Reason text for `rate_limit_buckets`** uses read-routing, not the "replica count" header sentence (Q4 correction).
3. **`Auth.ts` projects the stamped view**, not all names (Pitfall 3).
4. **Exported view types** move from tuples to `ReadonlyArray` of the literal-name union; no assertion is possible otherwise (Q3 changeset note).
5. **Guard exception** for tables created outside `CoreMigrations` is not a hard-coded exception: the guard runs the rate limiter's own migrator and filters its ledger by `RateLimiterStoreSql.migrationsTable` (Q5).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | everything | yes | v26.13.0 | none |
| pnpm | gates | yes | 11.20.0 | none |
| tsc | `tsc -b`, `tsc -p tsconfig.test.json` | yes | 7.0.2+effect-tsgo.0.67.4 | none |
| Docker container `awthaq-p3-pg` (postgres:16, Debian, PostgreSQL 16.16, host port 55433) | Postgres legs, GATE-04 | yes (running) | 16.16 | none needed; CI confirmation stays open |
| `AWTHAQ_POSTGRES_URL` | Postgres legs | unset in the shell | `postgres://postgres:pw@localhost:55433/awthaq` | pass it explicitly on every Postgres command |
| `psql` on host | ad-hoc SQL | not checked; use `docker exec awthaq-p3-pg psql -U postgres -d awthaq` | n/a | as stated |

Do not use `scripts/test-pg.sh` (alpine image, other port, launches its own container) [CITED: 04-RESEARCH.md Environment Availability]. Record Postgres runs as: "run locally on the CI image, CI confirmation open (no git remote)". Hosted CI cannot run (no git remote configured; AGENTS.md).

## Validation Architecture

`.planning/config.json` contains only `workflow.use_worktrees`; `workflow.nyquist_validation` is absent, so this section is enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 5.0.2 (`it.effect` from `@effect/vitest`), projects per package; BDD via `@effect-cucumber/vitest` in `features/` |
| Config file | root `vitest.config.ts` (`projects: ["packages/*", ...]`), per-package `vitest.config.ts`, `tsconfig.test.json` |
| Quick run command | `npx vitest run packages/sql/test/CoreTablePins.test.ts packages/sql/test/CoreTables.test.ts packages/sql/test/TenantScoped.test.ts packages/test/test/LaggingReplica.test.ts packages/core/test/AuthTenancy.test.ts` |
| Postgres run | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run packages/sql/test/CoreTablePins.test.ts packages/sql/test/CoreTables.test.ts packages/sql/test/TenantScope.postgres.test.ts packages/sql/test/CoreMigrations.postgres.test.ts packages/sql/test/ReadRouting.postgres.test.ts packages/sql/test/TenantScoped.test.ts` |
| Full suite command | `npx tsc -b tsconfig.json && pnpm test && pnpm test:bdd`, then the gate list below |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAT-01 | catalogue is the single list; `partitionedTables`, `directoryTables`, `coverage`, `LaggingReplica.coreTables`, stamped view each equal the literal they replace | unit | `npx vitest run packages/sql/test/CoreTablePins.test.ts packages/sql/test/CoreTables.test.ts packages/test/test/LaggingReplica.test.ts` | Wave 0 (pins) / Wave 1 (`CoreTables.test.ts`) |
| CAT-01 | `Auth.make` accepts exactly the stamped core tables as Derived parents | unit | `npx vitest run packages/core/test/AuthTenancy.test.ts` | extend existing (P6) |
| CAT-01 | the BDD stamping outlines still pass over `CoreTables.isStamped` | BDD | `pnpm test:bdd` (28-tenancy) | exists |
| CAT-01 | no remaining hand-kept list | census | `grep -rnE '"verification_reservations"' packages/*/src features/step-definitions` prints 2 lines (`CoreTables.ts`, `TenancySteps.ts` case label) | command |
| CAT-02 | both tables classified `tenancy: "none"`, `replicated: false`, non-empty reason; guard covers `rate_limit_buckets` through its own migrator | unit | `npx vitest run packages/sql/test/CoreTables.test.ts` (SQLite) and the Postgres run | Wave 1 |
| CAT-03 | catalogue keys are only `name, owner, tenancy, replicated, sealed, reason` (no types/DDL) | unit | `npx vitest run packages/sql/test/CoreTables.test.ts` | Wave 1 |
| CAT-03 | sealed AAD list, `key` and `adoptPlaintext` frozen; catalogue `sealed` equals `deployed({encryptPii:true})` as a set | unit | `npx vitest run packages/sql/test/CoreTablePins.test.ts packages/sql/test/CoreTables.test.ts` | Wave 0 / Wave 1 |
| CAT-03 | `core -> sql` edge unchanged, no new dependency, no cycle | static | `pnpm circular`; `git diff --stat -- packages/*/package.json pnpm-lock.yaml` prints nothing | gate |
| CAT-04 | the minimal-fix branch is not taken; reasoning recorded | doc | the census table in this file and the plan note; closing census command above | command |
| GATE-04 | drift guard, RLS table set and RLS/ReadRouting suites on Postgres | integration (Postgres) | the Postgres run above | Wave 0 (P8, P4) / Wave 1 |

### Sampling Rate
- **Per task commit:** the quick run plus `npx tsc -b tsconfig.json`.
- **Per wave merge:** `pnpm test`, `pnpm test:bdd`, the Postgres run.
- **Phase gate:** every gate below at or equal to the Wave 0 baseline.

### Gates and baseline (Wave 0 re-records at the planning HEAD; Phase 4 close is the reference)
Commands and Phase 4 close figures [CITED: .planning/phases/04-connection-lifecycle-module/04-BASELINE.md "Phase close" gate table]:

| Gate | Command | Phase 4 close |
|------|---------|--------------|
| tsc -b | `npx tsc -b tsconfig.json` | exit 0, 0 `error TS` |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 errors; 2 pre-existing `warning TS377149` in `TestingHarnessSteps.ts` |
| circular | `pnpm circular` | no findings |
| error tags | `pnpm check:error-tags` | 163 internal / 137 wire |
| transactions | `pnpm check:transactions` | no bare `sql.withTransaction` |
| contract tests | `pnpm check:contract-tests` | 21 plugin classes |
| lint | `pnpm lint` | warnings only (`.claude/`, 7 in `RequestContextSteps.ts`), no errors |
| format | `pnpm format:check` | correct on 1224 files (grows with new files; all formatted) |
| readmes | `pnpm check:readmes` | every README matches |
| workspace | `pnpm workspace:check` | 29 packages and 3 examples |
| bdd | `pnpm test:bdd` | 39 files; 1580 passed, 44 skipped |
| unit | `pnpm test` | 420 files passed + 6 skipped; 6648 passed, 1 expected fail, 21 skipped (SQLite/memory); Postgres run 426 files, 6690 passed |
| coverage | `pnpm coverage` | 91.73 / 85.22 / 87.03 / 92.25 (floors 89 / 83 / 84 / 90) |
| spec | `pnpm spec:verify:strict` | PASS 32, FAIL 0, SKIP 0 |
| knip | `pnpm knip` | exit 1 pre-existing: 39 `.claude/` files + 3 unlisted deps in `readme-quickstart.ts`; must gain nothing |
| package smoke | `pnpm package:smoke` | 30 PASS |

Comparison rule (as Phases 1-4): every gate exits as in the baseline, counts only grow, coverage stays at or above baseline, `check:error-tags` and `check:contract-tests` numbers unchanged, knip filtered output (`pnpm knip 2>&1 | grep -v '^\.claude/' | grep -v '^\.reports/'`) gains nothing, `git diff --stat knip.json` empty. `tsc -b` runs before every cross-package vitest run (GATE-01).

### Wave 0 Gaps
- [ ] `05-BASELINE.md` (every gate at the planning HEAD, as `04-BASELINE.md`; Postgres container version recorded).
- [ ] `packages/sql/test/CoreTablePins.test.ts` (P1-P4).
- [ ] `packages/test/test/LaggingReplica.test.ts` (P5).
- [ ] extend `packages/core/test/AuthTenancy.test.ts` (P6).
- [ ] extend `packages/sql/test/TenantScope.postgres.test.ts` (P8).
- [ ] P7 text pin and census baseline in `05-BASELINE.md`.
- Framework install: none.

### Suggested wave structure (planner may adjust; STATE.md anticipates 9 plans)
- **Wave 0:** baseline, all pins green on untouched `src` (one commit per pin file; oracle files are not edited afterwards, as in Phase 4).
- **Wave 1:** `CoreTables.ts` + barrel + `CoreTables.test.ts` (shape, projections equal the oracle, drift guard on both dialects); `TenantScope.partitionedTables`/`directoryTables` become aliases.
- **Wave 2 (independent files, parallel):** `Auth.ts`; `LaggingReplica.ts`; `TenancySteps.ts`.
- **Wave 3:** spec/README/changeset, full gate re-run, Postgres leg, close census, `05-BASELINE.md` "Phase close" section.

## Security Domain

`security_enforcement` is not disabled in `.planning/config.json`, so it applies. This is a refactor with no new input, endpoint or credential path.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | untouched |
| V3 Session Management | no | untouched (sessions table only classified) |
| V4 Access Control | yes | tenant isolation: RLS coverage must be byte-identical (`coverage` pin, P8 Postgres `relrowsecurity` set) |
| V5 Input Validation | yes | `identifier()` validation of table names in `enableRls` is unchanged; catalogue names are static literals, never user input |
| V6 Cryptography | yes | sealed-column AAD binding (`<table>:<rowKey>:<column>`) must not change: a changed AAD makes every stored envelope `Unreadable`; P3 freezes it. No hand-rolled crypto |

| Threat | STRIDE | Standard Mitigation |
|--------|--------|---------------------|
| A refactor drops or reorders a table from RLS coverage, silently weakening tenant isolation | Information disclosure / Elevation | P1/P2 literal pins; P8 on Postgres; the Postgres run of `TenantScope.postgres.test.ts` |
| A sealed column added, removed or re-keyed silently (stored ciphertext becomes unreadable, or a column is stored in plaintext) | Tampering / Information disclosure | P3 AAD and declaration pin; guard assertion 3 |
| A plugin table declared `Derived` under a non-tenant core table is accepted and then silently left uncovered by RLS | Elevation / Information disclosure | `Auth.ts` projects the stamped view; P6 |
| A new core table with tenant data ships without being classified (never RLS-covered) | Information disclosure | the drift guard fails the build on an unclassified created table |

## Sources

### Primary (HIGH confidence, read or executed this session)
- `/Users/mohammadalmechkor/Projects/Perso/awthaq-arch/packages/sql/src/{TenantScope,CoreSealedColumns,SealedColumn,CoreMigrations,RateLimiterStoreSql,RelayCursorStoreSql,ReadRouting,index}.ts`
- `/Users/mohammadalmechkor/Projects/Perso/awthaq-arch/packages/core/src/{Auth,Migrations}.ts`, `packages/test/src/{LaggingReplica,TestSql,StoreContract}.ts`, `packages/test/src/internal/{contractRunner,storeContract/rateLimiterStore}.ts`
- `/Users/mohammadalmechkor/Projects/Perso/awthaq-arch/features/step-definitions/TenancySteps.ts`, `features/features/12-multi-tenancy/28-tenancy.feature`
- Tests read: `packages/sql/test/{TenantScoped,TenantScope.postgres,CoreMigrations,CoreMigrations.postgres,SqlDdl,SealedColumn,CoreStoresSql}.test.ts`, `packages/test/test/{ReadRouting,CoreSealedColumns}.test.ts`, `packages/core/test/AuthTenancy.test.ts`
- Spec: `spec/behaviors/28-tenancy.md`, `spec/decisions/{004,018,024}-*.md`, `spec/scripts/check-drift.mjs` (checks 10, 13, 14), `spec/overview.md`, `spec/traceability.md` headers
- Config/scripts: `.oxlintrc.json`, `knip.json`, `.changeset/{config.json,keyset-page-module.md,connection-lifecycle-module.md}`, `scripts/{circular,check-readme-status,test-pg}.mjs/sh`, `package.json` files of `sql`, `core`, `test`, `features`
- Executed: drift-guard probe on SQLite and Postgres 16.16; TypeScript prototype compiled with `./node_modules/.bin/tsc` 7.0.2 (`--strict --declaration --emitDeclarationOnly`)
- `.planning/phases/05-core-table-list-cleanup/05-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/phases/04-connection-lifecycle-module/{04-RESEARCH,04-BASELINE}.md`

### Secondary / Tertiary
- None. No web research was needed: no new library or external API is involved.

## Metadata

**Confidence breakdown:**
- Census and classification: HIGH (grep plus file reads; the DDL quoted).
- Drift-guard mechanics: HIGH (executed on both dialects).
- Type design: HIGH for compile and declaration emit under the repo `tsc`; the final exported d.ts shape is MEDIUM until `tsc -b` runs on the real files.
- Spec/README fan-out: MEDIUM (grep-level; ids to confirm).
- Pitfalls: HIGH.

**Research date:** 2026-11-14
**Valid until:** 30 days (internal refactor against a moving branch; re-record the baseline at the planning HEAD `16643f40`)
