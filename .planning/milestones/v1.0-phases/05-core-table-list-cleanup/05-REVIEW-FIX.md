---
phase: 05-core-table-list-cleanup
fixed_at: 2026-11-14T00:00:00Z
review_path: .planning/phases/05-core-table-list-cleanup/05-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 5
skipped: 1
status: partial
---

# Phase 5: Code Review Fix Report

**Fixed at:** 2026-11-14
**Source review:** .planning/phases/05-core-table-list-cleanup/05-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (0 Critical, 0 Warning, 6 Info; fix scope widened to Info by the caller)
- Fixed: 5 (one commit each)
- Skipped: 1 (IN-06, a necessity finding the requirements mandate)

Edited in the worktree checkout (`architecture/deepening-batch-3`); verification ran there. Behaviour held: exported names, the element values and order of `TenantScope.partitionedTables` / `directoryTables`, `LaggingReplica.coreTables` and the coverage output are unchanged. The Wave 0 oracle files `CoreTablePins.test.ts` and `LaggingReplica.test.ts` were not edited; `AuthTenancy.test.ts` only gained lines. No `as` in src, no spec text touched (no Revision bump needed).

## Fixed Issues

### IN-01: `directoryTables` is typed with a hand-written literal union

**Files modified:** `packages/sql/src/CoreTables.ts`
**Commit:** 2165dafc
**Applied fix:** `directoryTables` is now `ReadonlyArray<Extract<Declared, { readonly tenancy: "directory" }>["name"]>`, written the same way as `partitionedTables`. The element type is the same union (`"users" | "accounts"`), so no declaration changes for consumers.

### IN-02: Exported lists are shared by reference and not frozen

**Files modified:** `packages/sql/src/CoreTables.ts`, `packages/sql/test/CoreTables.test.ts`
**Commit:** 688b0363
**Applied fix:** frozen at the source rather than copied at each alias, so `TenantScope.partitionedTables`, `TenantScope.directoryTables` and `LaggingReplica.coreTables` (which stay the same object as the catalogue's) can no longer be mutated through. A small `freeze` helper (`Object.freeze` returning `ReadonlyArray<A>`, no `as`) wraps `tables`, each entry's `sealed`, `names`, `partitionedTables`, `directoryTables`, `stamped` and `replicated`. Values and order are unchanged; every Wave 0 pin stays green. A new test asserts `Object.isFrozen` on each list.

### IN-03: The new `UnknownParent` wording is not asserted anywhere

**Files modified:** `packages/core/test/AuthTenancy.test.ts`
**Commit:** 415be223
**Applied fix:** added one test (an addition only; nothing removed, the old "accepts a core table as a Derived parent" test stays) that asserts the refusal message for a Derived table under `auth_relay_cursor` includes `its parent "auth_relay_cursor"` and `tenant-stamped core table`.

### IN-04: The reworded `TenancyDeclarationInvalid` doc comment runs to 118 columns

**Files modified:** `packages/core/src/Auth.ts`
**Commit:** c7f01201
**Applied fix:** re-wrapped the comment paragraph at about 100 columns. Comment only.

### IN-05: The drift guard proves less than the spec and README sentence suggests

**Files modified:** `packages/sql/test/CoreTables.test.ts`, `packages/sql/README.md`
**Commit:** abefdbe5
**Applied fix:**
- The guard's comparison is now two small functions (`unclassified`, `uncreated`) that the guard asserts empty. New negative tests: one runs them against a synthetic classified set (a stray table and a missing one are reported), one creates a real `stray_core_table` after both migrators ran and asserts the schema comparison reports exactly it. Both run on SQLite and Postgres (same file).
- ADR-EA-004 check is now nested-aware: every non-`sealed` value of an entry must be a scalar (nothing nested for a schema to hide in), and every `sealed` element must be, by identity, one of the `CoreSealedColumns.deployed` declarations.
- Partitioned versus directory: not distinguishable from the schema (migrations create the same nullable `"tenantId"` column and indexes for both; row-level security is only enabled by `TenantScope.enableRls`, never by migrations), so it was not added to the guard. The limit is stated in the test header and in the README ("Core tables" paragraph): the split is defended by the inline pins in `CoreTablePins.test.ts`.
- The rate limiter's migrator stays hard-coded (a generic registry would be new surface); the header and the README now say the guard covers the core migrations and the rate limiter's only, and that a future opt-in store with its own migrator must be added to the test. The spec sentence ("a core migration creates a table the catalogue does not classify") is accurate as written, so no spec edit and no Revision bump.

## Skipped Issues

### IN-06: `owner` is a constant and the `tables`/`sealed`/`names` projections have no source consumer (necessity)

**File:** `packages/sql/src/CoreTables.ts:56,64-68,71-73`
**Reason:** skipped by instruction. CAT-01 mandates the fields name, owner, tenancy and sealed (and the roadmap lists replicated), so the catalogue shape is a requirement, not a judgment call. Removing `owner` or moving `replicated` is a scope decision for the human if the catalogue is ever trimmed.
**Original issue:** every row carries the constant `owner: "core"`, and `tables`, `sealed`, `names` are read only by `CoreTables.test.ts`; `replicated`, a test-double concern, is part of the production `@awthaq/sql` type.

## Gate results

Run in the worktree checkout (`/Users/mohammadalmechkor/Projects/Perso/awthaq-arch`), after the last fix commit.

| Gate | Result |
|---|---|
| `npx tsc -b tsconfig.json` | exit 0, no output |
| `npx tsc -p tsconfig.test.json` | exit 0; the same 2 pre-existing `warning TS377149` in `TestingHarnessSteps.ts` |
| `pnpm lint` | exit 0; warnings only (untracked `.claude/` tree, `RequestContextSteps.ts`), none under `packages/` |
| `pnpm format:check` | exit 0 |
| `pnpm circular` | exit 0 |
| `pnpm check:readmes` | exit 0 |
| `pnpm spec:verify:strict` | exit 0, PASS 32, FAIL 0, SKIP 0 |
| `pnpm knip` | exit 1 (pre-existing); filtered: `Unused files (39)` (all `.claude/`) and the 3 `readme-quickstart.ts` unlisted dependencies, identical to `05-BASELINE.md` |
| Phase files on SQLite (`CoreTablePins`, `CoreTables`, `TenantScope.postgres`, `TenantScoped`, `AuthTenancy`, `LaggingReplica`) | 5 files passed, 1 skipped (the Postgres file); 41 passed, 11 skipped |
| Same files on Postgres (`AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq`) | 6 files passed; 52 passed, 0 skipped |
| BDD (`features`, includes `12-multi-tenancy/28-tenancy.feature`) | 39 files passed; 1580 passed, 44 skipped, 0 failed (same as the Phase 4 close) |

Postgres: run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote). Verification ran in the worktree, not in a teardown copy. The full `pnpm test` was not re-run; the changes touch one catalogue file, two test files, one doc comment and a README.

---

_Fixed: 2026-11-14_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
