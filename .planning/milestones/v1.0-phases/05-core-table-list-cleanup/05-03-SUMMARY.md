---
phase: 05-core-table-list-cleanup
plan: 03
subsystem: persistence
status: complete
tags: [core-tables, catalogue, drift-guard, sealed-columns, postgres, sqlite]

requires:
  - phase: 05-core-table-list-cleanup
    provides: 05-01 and 05-02 Wave 0 pins (CoreTablePins, LaggingReplica, AuthTenancy, TenantScope.postgres)
provides:
  - packages/sql/src/CoreTables.ts (the core-table catalogue and derived views), exported from @awthaq/sql as CoreTables
  - packages/sql/test/CoreTables.test.ts (dual-dialect drift guard plus classification, key-set and sealed-view tests)
affects: [05-04, 05-05, 05-06]

actuals:
  tokens: 4200
  tasks: 2
  commits: 2
plan_head_before: d0d60dc068e6d67f640d6dd404ae19870422a742
plan_head_after: 4bf14a22ed42b0592ebb9cb670185c00d3014757

tech-stack:
  added: []
  patterns:
    - "Data-first catalogue: one as const tuple in migration-creation order, one explicitly typed const per derived view, no sorting"
    - "Drift guard runs both migrators that create core tables and compares with TestSql.schemaOf"

key-files:
  created:
    - packages/sql/src/CoreTables.ts
    - packages/sql/test/CoreTables.test.ts
  modified:
    - packages/sql/src/index.ts

key-decisions:
  - "partitionedTables is typed with Extract<Declared, { tenancy: 'partitioned' }>['name'] instead of the four literals, so the quoted reservations name stays on one line (census constraint for 05-06)"
  - "replicated documents that it is LaggingReplica's mirror set, not ADR-EA-024's replica-eligible read set"

requirements-completed: []

duration: 12min
completed: 2026-11-14
---

# Phase 5 Plan 03: CoreTables catalogue and drift guard Summary

`@awthaq/sql` now exports `CoreTables`, the one declared list of the eight core tables (name, owner, tenancy, replicated, sealed view, reason for the two tenant-less tables), and a drift guard proves it against the real migrations on SQLite and Postgres. No consumer is switched yet (05-04 does that).

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| 1. Catalogue, barrel export, drift guard | 94567774 | packages/sql/src/CoreTables.ts (new), packages/sql/src/index.ts, packages/sql/test/CoreTables.test.ts (new, 2 tests) |
| 2. Classification, key-set and sealed-view tests | 4bf14a22 | packages/sql/test/CoreTables.test.ts (+5 tests, 2 to 7) |

## Verification

- `npx tsc -b`, `npx tsc -p tsconfig.test.json`: 0 `error TS` (the 2 pre-existing TS377149 warnings only). `pnpm lint` exit 0 (no finding under packages/), `pnpm circular` exit 0, `pnpm format:check` clean.
- SQLite: CoreTables, CoreTablePins, LaggingReplica, AuthTenancy: 4 files, 25 passed.
- Postgres (run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): CoreTables, CoreTablePins, TenantScope.postgres: 3 files, 27 passed.
- knip filtered output equals the 05-BASELINE.md block (39 `.claude/` files filtered, 3 pre-existing unlisted dependencies), no new row under `packages/`.
- Mutations seen to fail, each reverted: removing the rate_limit_buckets row (drift guard created-set equality), swapping users and accounts (view-order test), adding a `column: "text"` key to a row (key-set test; tsc accepted it because the spread widens, so the test is the evidence).
- Wave 0 oracles (CoreTablePins.test.ts, LaggingReplica.test.ts) have only their add commits; `git diff --name-only ea56a16f -- packages/sql/src packages/core/src packages/test/src features` lists exactly CoreTables.ts and index.ts.
- Grep checks: one barrel line, CoreTables.ts imports only the two sealed-column modules, the quoted reservations name on exactly one line, `CoreTables` present in built `lib/index.d.ts`.
- Flaky-test re-runs: none needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Quoted reservations name appeared on two lines**
- **Found during:** Task 1 verification (grep census check)
- **Issue:** the four-literal return type of `partitionedTables` repeated `"verification_reservations"`, breaking the one-line census constraint.
- **Fix:** typed the view with `Extract<Declared, { readonly tenancy: "partitioned" }>["name"]`; tsc declaration emit and tests unaffected.
- **Files modified:** packages/sql/src/CoreTables.ts
- **Commit:** 94567774

Otherwise: none, the plan executed as written.

## Known Stubs

None.

## Threat Flags

None. The catalogue adds no endpoint, auth path or schema change; T-05-05 to T-05-08 are mitigated by the drift guard, the identity-checked sealed view, the key-set test and the import grep plus `pnpm circular`.

## Self-Check: PASSED

- packages/sql/src/CoreTables.ts, packages/sql/test/CoreTables.test.ts found; commits 94567774 and 4bf14a22 are ancestors of HEAD.
