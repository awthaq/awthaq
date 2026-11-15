---
phase: 02-split-testauth
plan: 01
subsystem: testing
tags: [testauth, surface-snapshot, gate-baseline, typescript-compiler-api, vitest]

requires:
  - phase: 01-cli-views-and-configlist-removal
    provides: gate baseline format and the knip/census comparison discipline
provides:
  - 02-SURFACE-BEFORE.txt, the 47-name mechanical snapshot of the exported TestAuth surface (23 values, 24 types)
  - 02-BASELINE.md, the gate baseline, probe source and phase-close comparison rule
  - TestAuthSurface.test.ts, a permanent runtime value pin and compile-time type-name pin
affects: [02-02, 02-03, 02-04, 02-05, phase-07]

actuals:
  tokens: 14500
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Surface equality proved by diffing scope-free printed probe output from a TS 5.9.3 compiler API kept outside the repo"
    - "Type-name pin as one type-only re-export clause in a test file, checked by tsc -p tsconfig.test.json"

key-files:
  created:
    - .planning/phases/02-split-testauth/02-SURFACE-BEFORE.txt
    - .planning/phases/02-split-testauth/02-BASELINE.md
    - packages/test/test/TestAuthSurface.test.ts
  modified: []

key-decisions:
  - "Probe script kept in a scratch directory outside the repo and never committed (a committed .cjs would be a new knip Unused files row); its source is recorded verbatim in 02-BASELINE.md"
  - "Value array of the pin generated from Object.keys at run time and cross-checked against the 23 [value] headings of the snapshot; both agreed exactly"

patterns-established:
  - "Wave 0 pin: snapshot and pin land green on untouched src before any extraction"

requirements-completed: [TEST-01]

duration: 25min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: dce2dff5fe16f0b98b67628f1c33cb828ad2aa94
plan_head_after: 5ae0ef19bd4aa31dab1694f830183010af406e49
---

# Phase 2 Plan 01: Surface snapshot, gate baseline and TestAuth pin Summary

**Mechanical 47-name TestAuth surface snapshot (TS 5.9.3 compiler API probe), the full gate baseline, and a permanent TestAuthSurface.test.ts that pins 23 values and 24 type names, all captured green on untouched packages/test/src.**

## Performance

- **Duration:** about 25 min (gate run about 8 min of it)
- **Tasks:** 2 of 2
- **Files:** 3 created, 0 modified

## Accomplishments

- `02-SURFACE-BEFORE.txt`: 176 lines, 47 headings, 23 `[value]`, 24 `[type]`, 0 `[value+type]`, 0 `import(`; two consecutive probe runs diffed empty.
- `02-BASELINE.md`: every Phase 1 gate plus `check:contract-tests`, the `test` project, census pair, 13 Schema.lock files, 16 plugin Contract suites, raw and filtered knip, probe source verbatim, comparison rule.
- `TestAuthSurface.test.ts`: `Object.keys(TestAuth).sort()` deepStrictEqual the 23 names; one `export type { ... } from "../src/TestAuth.ts"` clause of the 24 type names. A deliberate mismatch in the clause produced TS2724 (reverted), proving the compile-time half bites.

## Baseline numbers (captured at HEAD dce2dff5, tree identical to d4282e31 in packages/test/src)

| Gate | Exit | Result |
|------|------|--------|
| tsc -b / tsc -p tsconfig.test.json | 0 / 0 | 0 `error TS` (2 pre-existing TS377149 warnings) |
| pnpm test | 0 | 410 files passed, 4 skipped; 6490 passed, 1 expected fail, 15 skipped |
| pnpm test:bdd | 0 | 39 files; 1576 passed, 44 skipped |
| pnpm coverage | 0 | 91.65 / 85.08 / 86.91 / 92.17 (floors 89/83/84/90) |
| spec:verify:strict | 0 | PASS 32 FAIL 0 |
| check:contract-tests | 0 | all 21 plugin classes run the contract suite |
| `test` project | 0 | 33 files, 627 passed + 1 expected fail (after pin: 34 files, 628 + 1) |
| census pair | 0 | 2 files, 17 tests |
| Schema.lock | 0 | 13 files, 13 tests |
| plugin Contract suites | 0 | 16 files, 1597 tests |
| knip | 1 (pre-existing) | 39 `.claude/` unused files + 3 readme-quickstart unlisted deps, identical to Phase 1 |
| package:smoke | 0 | 30 PASS |
| circular, error-tags, transactions, lint, format, readmes, workspace | 0 | as Phase 1 |

The passkey ChallengeStore intermittent did not occur; no re-run was needed.

Postgres-gated cases: not run locally (`AWTHAQ_POSTGRES_URL` unset).

## Task Commits

1. **Task 1: surface snapshot and gate baseline** - `ea1571f6` (docs)
2. **Task 2: TestAuthSurface.test.ts pin and Wave 0 pin note** - `5ae0ef19` (test)

## Deviations from Plan

None - plan executed exactly as written. Wall times of a few gates are shorter than the Phase 1 baseline (machine load); tsc -b took 0 s because the incremental build was up to date.

## Issues Encountered

None. The worktree guard rejects `cd ...; git ...` and `git ...; echo $?` forms, so git commands were issued plainly.

## Known Stubs

None.

## Threat Flags

None. The raw output pasted into 02-BASELINE.md is limited to gate summaries, knip file lists, `git status --short` and `git diff --stat knip.json` (T-02-01); the probe was never committed and no `.cjs`/`.mjs` was added since d4282e31 (T-02-02).

## Next Phase Readiness

Wave 1 (02-02) can start extracting from `packages/test/src/TestAuth.ts`: the BEFORE snapshot and baseline are committed, the pin is green and runs in every `--project test` loop. No file under `packages/test/src`, `packages/core/test` or `spec` changed in this plan (`git diff d4282e31 HEAD` over those paths is empty).

## Self-Check: PASSED

- FOUND: .planning/phases/02-split-testauth/02-SURFACE-BEFORE.txt, 02-BASELINE.md, packages/test/test/TestAuthSurface.test.ts
- FOUND commits ea1571f6, 5ae0ef19
