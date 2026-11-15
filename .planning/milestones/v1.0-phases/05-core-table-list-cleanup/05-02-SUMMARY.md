---
phase: 05-core-table-list-cleanup
plan: 02
subsystem: testing
status: complete
tags: [pin-matrix, replica, derived-parent, rls, postgres, core-tables]

requires:
  - phase: 05-core-table-list-cleanup
    provides: 05-01 baseline and CoreTablePins (P1-P4)
provides:
  - packages/test/test/LaggingReplica.test.ts (P5, replica default table list)
  - AuthTenancy.test.ts additions (P6, Derived-parent acceptance set)
  - TenantScope.postgres.test.ts addition (P8, RLS table set on real Postgres)
affects: [05-03, 05-04, 05-05, 05-06]

actuals:
  tokens: 4000
  tasks: 2
  commits: 2
plan_head_before: 70e2c6be019bba647c7f83e6ccb26364008787c1
plan_head_after: 4bf345378b97ff5943fd3f6dd9b0f79a613c0466

tech-stack:
  added: []
  patterns:
    - "Pin tests assert inline literals, never the list they guard; each seen to fail under a one-literal mutation"

key-files:
  created:
    - packages/test/test/LaggingReplica.test.ts
  modified:
    - packages/core/test/AuthTenancy.test.ts
    - packages/sql/test/TenantScope.postgres.test.ts
    - .planning/phases/05-core-table-list-cleanup/05-BASELINE.md

key-decisions:
  - "Wave 0 is complete: P1-P6 and P8 are green against untouched src; no src, spec, features, examples or changeset file changed"

requirements-completed: []

duration: 10min
completed: 2026-11-14
---

# Phase 5 Plan 02: Remaining Wave 0 pins Summary

Three behaviours the catalogue must preserve are now pinned green against untouched `src`: the replica's default table list (P5), the exact Derived-parent set `Auth.make` accepts, with `auth_relay_cursor` and `rate_limit_buckets` refused as UnknownParent (P6), and the real-Postgres RLS table set for both `enableRls` option cases (P8).

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| 1. P5 and P6 | 31385d7b | packages/test/test/LaggingReplica.test.ts (new, 1 test), packages/core/test/AuthTenancy.test.ts (+2 tests, 6 to 8) |
| 2. P8 and Wave 0 record | 4bf34537 | packages/sql/test/TenantScope.postgres.test.ts (+1 `it.effect`, 10 to 11), 05-BASELINE.md ("05-02" section) |

## Verification

- SQLite: the four Wave 0 files, 3 passed | 1 skipped (Postgres file skips), 18 passed | 11 skipped.
- Postgres (run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): 4 files, 29 passed.
- Mutations seen to fail and reverted: `auth_relay_cursor` moved into the accepted loop (P6); "users" dropped from the `includeDirectory` literal (P8, on Postgres).
- tsc -b and tsc -p tsconfig.test.json: no `error TS`; format:check exit 0; lint only pre-existing warnings.
- `git diff --quiet ea56a16f -- packages/sql/src packages/core/src packages/test/src spec features examples .changeset` exits 0; existing-line edits to both extended test files: 0.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. T-05-03 and T-05-04 mitigated by P6 and P8.

## Self-Check: PASSED

Both commits are reachable from HEAD; the new test file and the summary exist.
