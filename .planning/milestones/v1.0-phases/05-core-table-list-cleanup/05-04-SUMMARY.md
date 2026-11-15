---
phase: 05-core-table-list-cleanup
plan: 04
subsystem: persistence
status: complete
tags: [core-tables, catalogue, tenant-scope, auth, lagging-replica, bdd]

requires:
  - phase: 05-core-table-list-cleanup
    provides: 05-03 CoreTables catalogue; 05-01/05-02 Wave 0 pins
provides:
  - TenantScope.partitionedTables and directoryTables as catalogue views
  - Auth.make Derived-parent check through CoreTables.isStamped
  - LaggingReplica.coreTables as CoreTables.replicated
  - TenancySteps stamped-table guard through CoreTables.isStamped
affects: [05-05, 05-06]

actuals:
  tokens: 1500
  tasks: 3
  commits: 3
plan_head_before: 76914b43acdca1998299f528b3488704c0be851a
plan_head_after: be5d9b8d5dbd3c038b81694c69c5c186d7d24df4

tech-stack:
  added: []
  patterns:
    - "Hand lists replaced by projections of the one catalogue; Wave 0 oracles pass byte-unchanged as the equality proof"

key-files:
  created: []
  modified:
    - packages/sql/src/TenantScope.ts
    - packages/core/src/Auth.ts
    - packages/test/src/LaggingReplica.ts
    - features/step-definitions/TenancySteps.ts

key-decisions:
  - "TenantScope exports are annotated typeof CoreTables.<view>, so the element types stay the literal unions and only the tuple shape becomes ReadonlyArray (for the 05-05 changeset)"
  - "Auth.ts projects the stamped view, not every catalogue name: UnknownParent wording is now 'or a tenant-stamped core table'"

requirements-completed: []

duration: 8min
completed: 2026-11-14
---

# Phase 5 Plan 04: Consumers project from CoreTables Summary

The four hand-kept core-table copies (TenantScope's two lists, Auth.ts's Derived-parent list, LaggingReplica.coreTables, the BDD step file's private list) now read the 05-03 catalogue, and every Wave 0 oracle passes unchanged, which shows each projection equals the list it replaced.

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| 1. TenantScope views and Auth Derived-parent check | c1733d80 | packages/sql/src/TenantScope.ts, packages/core/src/Auth.ts |
| 2. LaggingReplica replicated view | 34f3afb0 | packages/test/src/LaggingReplica.ts |
| 3. BDD tenancy steps guard | be5d9b8d | features/step-definitions/TenancySteps.ts |

## Verification

- `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json`: 0 `error TS` after each task (only the 2 pre-existing TS377149 warnings). `pnpm lint` exit 0, `pnpm circular` exit 0, `pnpm format:check` clean.
- SQLite set (CoreTablePins, CoreTables, TenantScoped, AuthTenancy): 4 files, 36 passed. LaggingReplica + ReadRouting: 2 files, 11 passed.
- Postgres (run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): CoreTablePins, TenantScope.postgres, TenantScoped: 3 files, 32 passed.
- BDD tenancy feature (28-tenancy.steps.test.ts): 60 passed, 7 skipped. `pnpm test:bdd`: 39 files, 1580 passed, 44 skipped.
- `pnpm test`: 423 files passed, 6 skipped; 6695 tests passed, 1 expected fail, 23 skipped. No known intermittent fired; no re-runs.
- Grep gates: `as const` in TenantScope.ts 0; `coreTables` in Auth.ts 0; `CoreTables.isStamped` in Auth.ts 1; `tenant-stamped core table` in Auth.ts 2; `CoreTables.replicated` in LaggingReplica 2 (doc + use); `STAMPED_TABLES` 0; quoted `"verification_reservations"` census over `packages/*/src` and `features/step-definitions` = 2.
- Oracles: `git diff --name-only ea56a16f` over the three test dirs lists only the five phase test files, none edited in this plan. No package.json or lockfile changes.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. T-05-09 to T-05-12 are mitigated by the unchanged P1/P2/P5/P6/P8 pins and the retained `isStamped` guard.

## Self-Check: PASSED

- Modified files present; commits c1733d80, 34f3afb0, be5d9b8d are ancestors of HEAD.
