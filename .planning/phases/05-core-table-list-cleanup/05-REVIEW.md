---
phase: 05-core-table-list-cleanup
reviewed: 2026-11-14T17:10:00Z
depth: deep
files_reviewed: 16
files_reviewed_list:
  - packages/sql/src/CoreTables.ts
  - packages/sql/src/TenantScope.ts
  - packages/sql/src/index.ts
  - packages/core/src/Auth.ts
  - packages/test/src/LaggingReplica.ts
  - features/step-definitions/TenancySteps.ts
  - packages/sql/test/CoreTablePins.test.ts
  - packages/sql/test/CoreTables.test.ts
  - packages/sql/test/TenantScope.postgres.test.ts
  - packages/core/test/AuthTenancy.test.ts
  - packages/test/test/LaggingReplica.test.ts
  - spec/behaviors/28-tenancy.md
  - spec/overview.md
  - spec/traceability.md
  - packages/sql/README.md
  - .changeset/core-table-catalogue.md
findings:
  critical: 0
  warning: 0
  info: 6
  total: 6
  necessity: 1
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** deep
**Files Reviewed:** 16
**Status:** issues_found

## Summary

I read the diff `ea56a16f..HEAD` (non-`.planning`) in full, plus the sources it depends on: `CoreSealedColumns`, `CoreMigrations`, `RateLimiterStoreSql`, `RelayCursorStoreSql`, `TestSql` (`layer`, `schemaOf`, `postgres`), `TenantScope.enableRls/disableRls/coverage` and the `ReadRouting` ADR (EA-024). I re-ran `tsc -b` for `@awthaq/sql`, `@awthaq/core` and `@awthaq/test` and `tsc --noEmit` for `features`, all clean. The catalogue, pin, `AuthTenancy` and `LaggingReplica` suites pass on SQLite (28 + 8 + 1 tests). The Postgres-only pin (P8) is read, not run, since `AWTHAQ_POSTGRES_URL` is unset here.

No Critical or Warning issue survived verification. Each behaviour-preservation claim holds against the source:

- **Projections.** `partitionedTables` (sessions, verification_tokens, verification_reservations, auth_audit_log), `directoryTables` (users, accounts), `replicated` and `stamped` are the filtered `declared` order, equal to the removed lists. The `Auth.ts` `coreTables` spread was the same six names, and `STAMPED_TABLES` in `TenancySteps.ts` was the same six. `isStamped` is false for `auth_relay_cursor` and `rate_limit_buckets`, so both still produce `UnknownParent`.
- **Pins.** They compare inline literals, not the derived views. `CoreTablePins` and `LaggingReplica.test.ts` were each added in a single commit (7720a413, 31385d7b) and never touched afterward.
- **Types.** There is no `as` in `src` except `as const`. The literal element types survive (`partitionedTables` is `ReadonlyArray<"sessions" | ...>`). Declaration emit is clean, with no TS2883.
- **Import DAG.** `CoreTables` imports only `CoreSealedColumns` and a type from `SealedColumn`. `TenantScope` imports `CoreTables`. `Auth.ts` and `LaggingReplica.ts` import it through the `@awthaq/sql` barrel. There is no cycle, and `index.ts` exports the namespace.
- **ADR-EA-004.** The catalogue holds no column types or DDL, and the sealed view is `deployed({ encryptPii: true })` filtered by table. It is derived, not copied: `sealed[0] === CoreSealedColumns.usersMetadata` is asserted by identity.
- **Reason texts.** They are accurate against the code. Migration 27 declares `name`, `lastEventId` and `updatedAt`. `RelayCursorStoreSql.get` is a primary-only read, per its header. `rate_limit_buckets` is created by `RateLimiterStoreSql.migrate` under `awthaq_rate_limiter_migrations`, with a single `INSERT ... ON CONFLICT` upsert plus a `peek`. ADR-EA-024 decision 2 makes only listings replica-eligible.
- **Drift guard.** A new core-migration table fails the first test (`afterCore` not in `classified`, or `afterBoth` not equal to `classified`). A classified table that is never created fails the same equality. Both dialects run the same file. The Postgres schema is dropped and recreated per layer build (`TestSql.postgres` `reset`), so tests do not leak state.
- **Docs.** Spec revisions advance 1.15 to 1.16 (28-tenancy), 1.18 to 1.19 (overview) and 1.93 to 1.94 (traceability), each with a matching Change History entry. The BEH ids (231/233/328) land on the right sections. The changeset's Migration line is accurate.
- **Consumers.** No other consumer of the old shapes or of the old "or a core table" wording remains in src, tests, features, docs or examples. The only hit is a test title (IN-03).

What remains is design and hygiene.

## Info

### IN-01: `directoryTables` is typed with a hand-written literal union, unlike its siblings

**File:** `packages/sql/src/CoreTables.ts:84-87`
**Issue:** `partitionedTables` derives its element type (`Extract<Declared, { tenancy: "partitioned" }>["name"]`, line 80). `directoryTables` hard-codes `ReadonlyArray<"users" | "accounts">`. Both only compile because TypeScript infers a type predicate from the `.filter((entry) => entry.tenancy === ...)` callback. If a table is later reclassified `directory`, the annotation fails to compile, which is loud but non-obvious. `stamped` and `replicated` fall back to the wide `CoreTableName`.
**Fix:** Use the same `Extract<Declared, { readonly tenancy: "directory" }>["name"]` form, so the two lists are written one way.

### IN-02: Exported lists are shared by reference and not frozen

**File:** `packages/sql/src/CoreTables.ts:70-98`, `packages/test/src/LaggingReplica.ts:35`, `packages/sql/src/TenantScope.ts:46,49`
**Issue:** Before the phase each list was its own array. `Auth.ts` even built a private spread copy. Now `TenantScope.partitionedTables` and `CoreTables.partitionedTables` are the same object, and `LaggingReplica.coreTables` is `CoreTables.replicated`. `ReadonlyArray` is compile-time only. Any consumer that casts and mutates one name, for example a test that `push`es onto `coreTables`, silently corrupts RLS coverage, `isStamped` and the replica list process-wide.
**Fix:** `Object.freeze` the exported arrays in `CoreTables.ts` (one line each), or have the aliases copy (`[...CoreTables.replicated]`).

### IN-03: A duplicated test title, and the new `UnknownParent` wording is not asserted anywhere

**File:** `packages/core/test/AuthTenancy.test.ts:45,50,63`
**Issue:** The old test "accepts a core table as a Derived parent" (line 45, `sessions` only) is now a strict subset of the new "accepts every tenant-stamped core table" (line 50). The refusal test (line 63) asserts only `.cause === "UnknownParent"`. The message change the changeset advertises ("tenant-stamped core table") has no test. That wording is the only observable output change in the phase.
**Fix:** Drop the old test or fold it into the new one. Add `assert.include(refusal([p])?.message ?? "", "tenant-stamped core table")` to the refusal test.

### IN-04: The reworded `TenancyDeclarationInvalid` doc comment runs to 118 columns

**File:** `packages/core/src/Auth.ts:106-107`
**Issue:** The edit lengthened one line of the comment. The surrounding lines wrap near 100. Comments are not reflowed by the formatter, so it stays ragged.
**Fix:** Re-wrap the paragraph after "a `dependsOn` plugin's, or a tenant-stamped core table,".

### IN-05: The drift guard proves less than the spec and README sentence suggests

**File:** `packages/sql/test/CoreTables.test.ts:27-62,100-104`; `spec/behaviors/28-tenancy.md` (BEH-EA-231 paragraph); `packages/sql/README.md:128`
**Issue:**
- The second test checks only that a `tenantId` column exists exactly when `tenancy !== "none"`. A table misfiled `partitioned` instead of `directory` (or the reverse) passes the guard. The only defences are the inline pins (P1/P2, and P8 on Postgres), so a future reclassification would have to edit a "never edited" pin file to go green. That is acceptable but worth stating.
- The guard hard-codes the rate limiter's migrator, as its header admits. A future opt-in store with its own migrator is uncovered. The spec and README say "a test fails when a core migration creates a table the catalogue does not classify", which is true of core migrations only.
- No test demonstrates that the guard fails. Phase 5 summaries do not record a mutation run either.
- "An entry carries no column types or DDL" (line 100) checks only the top-level keys, so it cannot see anything nested under `sealed`.

**Fix:** Soften the README sentence to "core migrations and the rate limiter's". Optionally add a guard case that creates a stray table and expects the comparison to fail. A Postgres `relrowsecurity`-versus-tenancy assertion would close the partitioned/directory gap.

### IN-06: Necessity: `owner` is a constant and the `tables`/`sealed`/`names` projections have no source consumer

**Category:** necessity
**File:** `packages/sql/src/CoreTables.ts:56,64-68,71-73`
**Issue:** Every row carries `owner: "core"`, a fixed marker the type itself documents as constant. `grep` shows no reader of `CoreTable.owner`, `.sealed`, `CoreTables.tables` or `CoreTables.names` in any `src/` or `features/` file; only `CoreTables.test.ts` reads them. The live consumers use `partitionedTables`, `directoryTables`, `replicated` and `isStamped`. Related: `replicated`, a test-double concern (`LaggingReplica`), is part of the production `@awthaq/sql` public type, and its own JSDoc has to warn "never derive read routing from it". Both are mandated by CAT-01..03 in the phase CONTEXT, so this rests on judgment (Info), not on a defect.
**Fix:** Keep, since the requirements ask for it. If the catalogue is ever trimmed, drop `owner` and move `replicated` next to `LaggingReplica`, leaving `@awthaq/sql` to own tenancy only.

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
