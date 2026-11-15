---
phase: 06-record-store-scaffolding
plan: 01
subsystem: testing
tags: [baseline, postgres, record-store, contract-suites, known-intermittents]

requires:
  - phase: 05-core-table-list-cleanup
    provides: the 05-BASELINE.md format, gate list and comparison-rule shape reused here
provides:
  - 06-BASELINE.md (gate baseline on SQLite, RC9 record-store Contract suites on SQLite and Postgres, full Postgres record, three known intermittents, phase-close comparison rule, path allowlist, go-branch obligations)
affects: [06-02, 06-03]

actuals:
  tokens: 6000
  tasks: 2
  commits: 2
plan_head_before: 567c698530d96a7805ab067a8df347430048e5ce
plan_head_after: 90884bc8851c12048339b4306a4697b0bb851bdd

tech-stack:
  added: []
  patterns:
    - "Baseline taken on an untouched tree (git diff --quiet against the phase base for packages, spec, features, examples, docs, .changeset, knip.json, scripts) and re-checked after the Postgres runs"

key-files:
  created:
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md
  modified: []

key-decisions:
  - "Postgres baseline is the fresh-container record (postgres:16 Debian 16.16, --shm-size=1g, empty database); the first attempt on the old container (4.7 GB, 5877 leaked schemas, load average 31-49) produced only 5000 ms load timeouts and is kept as a note, not a result"
  - "F-06-01: OrganizationConnectionLifecycle.sql.test.ts 'an organization deletion racing a create ...' is recorded as a third known intermittent (database-wide advisory-waiter count in the test helper); same re-run rule (at most twice, every run recorded); its fix is planned after the phase and is not made here"
  - "Path allowlist is the narrowest no-go set (spec/decisions/041-domain-store-ports.md and .planning/); only a go-branch plan may widen it by naming its own paths"

patterns-established:
  - "RC9 (nine Contract suites of the 8 record-owning packages plus the plugin template) is the record-store regression command, pasted in full with its nine paths wherever it is cited"

requirements-progressed: [GATE-01, GATE-04]

duration: 40min
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 01: Gate baseline and Postgres record Summary

**06-BASELINE.md records every gate at HEAD `567c6985` on SQLite, the nine record-store Contract suites (RC9) on SQLite (1334 tests) and Postgres (1346 tests), the full Postgres unit and bdd runs, and fixes the close rule and path allowlist before the spike.**

## Performance

- **Duration:** about 40 min wall time (gates, first Postgres attempt, container recreation, re-run)
- **Completed:** 2026-11-14
- **Tasks:** 2
- **Files modified:** 1 (`.planning/phases/06-record-store-scaffolding/06-BASELINE.md`)

## Accomplishments

- 16 gates recorded with exit code, summary line and wall time: tsc, tests typecheck, circular, error tags 163 / 137, transactions, contract tests 21 classes, lint, format (1228 files), readmes, workspace, bdd 39 files / 1580 passed / 44 skipped, unit 423 + 6 skipped files / 6699 passed / 1 expected fail / 23 skipped, coverage 91.80 / 85.23 / 87.12 / 92.32 (floors 89 / 83 / 84 / 90), spec PASS 32 / FAIL 0 / SKIP 0, knip exit 1 with the Phase 1 to 5 filtered output, package smoke 30 PASS.
- RC9 on SQLite: 9 files, 1334 tests. RC9 on Postgres (fresh Debian postgres:16 container): 9 files, 1346 tests (the 12 extra are Postgres-only cases).
- Postgres full unit on the fresh container: run 1 failed on one test (F-06-01, below), run 2 green (429 files, 6742 passed, 1 expected fail, 1 skipped); full bdd 39 files, 1580 passed, 44 skipped.
- Phase-close comparison rule (six items), the narrowest path allowlist and the go-branch obligations (frozen `Ref` counts, `ImpersonationRecords` keeps two `Ref`s and a `Semaphore`, docs and template last) are written down before the spike.
- No file outside `.planning/` changed: `git diff --quiet 3be32564 -- packages spec features examples docs .changeset knip.json scripts` exits 0.

## Task Commits

1. **Task 1: gate baseline on SQLite/memory, RC9, knip, intermittents, comparison rule, allowlist** - `e99040f1` (docs)
2. **Task 2: Postgres leg (RC9, full unit, full bdd)** - `90884bc8` (docs)

## Decisions Made

See `key-decisions` in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

None to code (this plan changes no code).

### Execution deviations

**1. [Rule 3 - Blocking] First Postgres attempt unusable; container recreated by the orchestrator**
- **Found during:** Task 2
- **Issue:** On the old container (default 64 MB shm, `awthaq` database 4733 MB, 5877 leaked schemas, 538,624 `pg_class` rows) with machine load average 31 to 49, RC9 and the full run failed with a different set of 5000 ms timeouts on each run (admin `ImpersonationRecords (sql)`, `OrganizationMembers` natural race, scim and saml schema-equivalence), none with crash or shared-memory symptoms.
- **Fix:** Stopped and reported; the orchestrator recreated `awthaq-p3-pg` with `--shm-size=1g` and an empty database; the Postgres leg was re-run. The first attempt is recorded in 06-BASELINE.md as a short note, not as a result.
- **Files modified:** none
- **Commit:** `90884bc8` (the record)

**2. [Plan wording] A third known intermittent recorded (F-06-01)**
- **Found during:** Task 2
- **Issue:** The first full Postgres `pnpm test` on the fresh container failed on `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` "an organization deletion racing a create for it leaves no connection, claim or owner row behind, and the create is refused" (assertion: `create: "ok"` instead of `"InvalidConnection"`). The test's `waitForAdvisoryWaiters` counts advisory waiters database-wide, so parallel test files can release the latch early. It passes alone 3 of 3 and the second full run was green. No `packages` file changed since the Phase 5 close.
- **Fix:** Recorded as the third known intermittent with the same re-run rule (at most twice, every run recorded). The test fix (scope the count to the lock key) is not made in this phase: planned after the phase as a separate commit.
- **Files modified:** `.planning/phases/06-record-store-scaffolding/06-BASELINE.md`
- **Commit:** `90884bc8`

## Issues Encountered

- First `pnpm coverage` run hit known intermittent 1 (passkey ChallengeStore memory variant, tampered-consume); the re-run was green. Both runs are recorded.
- F-06-01 as above.

## Known Stubs

None.

## Threat Flags

None. The Postgres URL in the baseline is the throwaway local container credential already in the planning docs; no environment dumps were pasted.

## Next Phase Readiness

06-02 and 06-03 compare against 06-BASELINE.md. The spike (06-SPIKE.md) decides go or no-go; the allowlist and close rule already cover both outcomes.

## Self-Check: PASSED

- `.planning/phases/06-record-store-scaffolding/06-BASELINE.md`: FOUND
- Commits `e99040f1` and `90884bc8`: FOUND in the branch history
