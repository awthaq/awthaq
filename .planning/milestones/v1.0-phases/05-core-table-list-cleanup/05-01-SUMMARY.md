---
phase: 05-core-table-list-cleanup
plan: 01
subsystem: testing
tags: [baseline, pin-matrix, postgres, rls-coverage, sealed-columns, core-tables, census]

requires:
  - phase: 04-connection-lifecycle-module
    provides: the baseline record format and the Wave 0 pin discipline reused here
provides:
  - 05-BASELINE.md (gate baseline, Postgres record, census, CAT-04 disposition, spec facts, comparison rule and path allowlist, Wave 0 pins record)
  - packages/sql/test/CoreTablePins.test.ts (P1-P4: TenantScope lists, coverage matrix, sealed AAD snapshot, created-table set)
affects: [05-02, 05-03, 05-04, 05-05, 05-06]

actuals:
  tokens: 10000
  tasks: 2
  commits: 2
plan_head_before: adfaf4bf2978a928a920af5956005686d836e95d
plan_head_after: 7720a413104e3677158c610af6e9aa197eaa5e14

tech-stack:
  added: []
  patterns:
    - "Pin expected values are inline literals compared through ReadonlyArray<string>, so one file type-checks against tuple and array list types"

key-files:
  created:
    - .planning/phases/05-core-table-list-cleanup/05-BASELINE.md
    - packages/sql/test/CoreTablePins.test.ts
  modified: []

key-decisions:
  - "CAT-04 minimal-fix branch not taken: the BDD STAMPED_TABLES literal is a second real copy and auth_relay_cursor and rate_limit_buckets are in no list; the candidate closes with the catalogue (CAT-01..03)"
  - "Postgres full-suite record at HEAD has no failing tests (426 files, 6718 passed, 1 skipped), so Phase 5 starts with an empty pre-existing Postgres failing list"
  - "rate_limit_buckets stays out of the replicated set for the read-routing reason (primary-only counter, ADR-EA-024 decision 2), not the replica-count sentence CONTEXT cited"

patterns-established:
  - "Mutation check on every pin file: flip one expected literal, see the case fail, revert"

requirements-progressed: [CAT-01, CAT-03, CAT-04]

duration: 17min
completed: 2026-11-14
status: complete
---

# Phase 5 Plan 01: Wave 0 baseline and core-table pins Summary

**05-BASELINE.md records every gate, the Postgres full suite and the four-list census at HEAD, and CoreTablePins.test.ts freezes the RLS coverage matrix, the six sealed AADs and the created-table set before any src change.**

## Performance

- **Duration:** 17 min
- **Tasks:** 2
- **Files modified:** 2 created, 0 modified; no file under `packages/*/src`, `spec`, `features`, `examples` or `.changeset` changed

## Accomplishments

- Every GATE-01 gate measured at HEAD on an untouched tree: all exit 0 except `pnpm knip` (1, the three pre-existing `readme-quickstart.ts` rows and the untracked `.claude/` files). SQLite: 420 files passed + 6 skipped, 6676 tests; bdd 1580 passed, 44 skipped; coverage 91.75 / 85.24 / 87.06 / 92.27; spec PASS 32 / FAIL 0; 30 packages smoke PASS.
- Postgres (Debian postgres:16, 16.16): targeted legs 56 passed; full unit 426 files, 6718 passed, 1 skipped, no failure; full bdd 1580 passed, 44 skipped. Failing list empty. Run locally on the CI image, CI confirmation open (no git remote).
- Census pasted verbatim: 4 quoted `verification_reservations` lines, the list-name grep classified, the two unclassified tables, the private BDD six-name literal; CAT-04 disposition and the CONTEXT correction recorded; comparison rule and path allowlist written for 05-06.
- CoreTablePins.test.ts: 9 tests, green on SQLite and Postgres against untouched src; two one-literal mutations seen to fail and reverted.

## Task Commits

1. **Task 1: gate baseline, Postgres record, census** - `b39dc366` (docs)
2. **Task 2: CoreTablePins.test.ts and the Wave 0 pins record** - `7720a413` (test)

## Files Created

- `.planning/phases/05-core-table-list-cleanup/05-BASELINE.md`
- `packages/sql/test/CoreTablePins.test.ts`

## Decisions Made

See frontmatter `key-decisions`.

## Deviations from Plan

None - plan executed exactly as written. Real P2 output matched the RESEARCH reading, so no difference was recorded.

## Issues Encountered

- First `pnpm test` run hit the known passkey `ChallengeStore` intermittent (the `(memory)` variant this time); the one re-run was green and both runs are recorded in 05-BASELINE.md "Known intermittents". The TenantMiddleware intermittent did not fire.
- A stray `npx tsc -v` issued from outside the repo root tried to fetch the unrelated npm package `tsc`; it printed a "not the tsc command" banner and nothing was installed into the repo. The real toolchain line was re-taken from the repo root.

## Known Stubs

None.

## Threat Flags

None. Only a planning record and a test file were added.

## Next Phase Readiness

05-02 (LaggingReplica and AuthTenancy pins) and later plans are judged against 05-BASELINE.md and CoreTablePins.test.ts; the pin file is not to be edited again.

## Self-Check: PASSED

- FOUND: .planning/phases/05-core-table-list-cleanup/05-BASELINE.md
- FOUND: packages/sql/test/CoreTablePins.test.ts
- FOUND commits: b39dc366, 7720a413
