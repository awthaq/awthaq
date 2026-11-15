---
phase: 02-split-testauth
plan: 04
subsystem: testing
tags: [testauth, contract-runner, schema-lock, facade, surface-probe, internal-modules]

requires:
  - phase: 02-split-testauth
    provides: 02-03 internal/session.ts and internal/appHarness.ts behind the facade
provides:
  - packages/test/src/internal/contractRunner.ts, the plugin contract runner and migratedSchema (verbatim move)
  - TestAuth.ts as a pure facade (header, module map, named re-exports only)
  - 02-SURFACE-AFTER.txt, byte-identical to 02-SURFACE-BEFORE.txt (47 names)
affects: [02-05]

actuals:
  tokens: 40000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Mechanical line-range move via a throwaway script in the scratchpad, never committed"
    - "Facade of named re-exports grouped per internal module; no star re-export"

key-files:
  created:
    - packages/test/src/internal/contractRunner.ts
    - .planning/phases/02-split-testauth/02-SURFACE-AFTER.txt
  modified:
    - packages/test/src/TestAuth.ts

key-decisions:
  - "The TestFramework type re-export stays in the facade (listed after the contractRunner re-exports, as the plan's final order says); contractRunner imports the type from ../TestFramework.ts"

patterns-established:
  - "Import DAG for the facade split: contractRunner -> composition, foundation; appHarness -> session; no internal module imports TestAuth.ts"

requirements-completed: [TEST-01, TEST-02]

duration: 15min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 96e137d62eb30f4a4f64ce8fe91e516d883bb40c
plan_head_after: 0693972eedbafeb2160704761b73d01cb56e6610
---

# Phase 2 Plan 04: Extract the contract runner and finish the facade Summary

**The contract runner (runPluginContractTests, migratedSchema with its single `TestSql.schemaOf` call) now lives verbatim in internal/contractRunner.ts, and TestAuth.ts is a pure named-re-export facade whose public surface probes byte-identical to the pre-split snapshot.**

## Accomplishments

- `internal/contractRunner.ts`: TestAuth.ts lines 124-1006 at 96e137d6 minus the TestFramework type re-export (throwingFramework through runPluginContractTests, 880 lines). Imports `makeLayer, recordModes` from `./composition.ts`, `memoryFoundation` from `./foundation.ts`, the TestFramework type from `../TestFramework.ts`; nothing from the facade (the two `TestAuth` hits are doc-comment text).
- `TestAuth.ts`: header kept word for word except the RateLimiter bullet now says `internal/composition.ts`; module-map paragraph; re-exports for foundation, composition, session, appHarness, contractRunner, `TestFramework` type, then the unchanged conformance block. 0 imports, 0 local declarations, 0 star re-exports.
- `02-SURFACE-AFTER.txt`: probe source taken from 02-BASELINE.md, same `TS_API_PATH`; `diff` against BEFORE is empty, 47 headings.

## Gate results

| Gate | Result |
|------|--------|
| `npx tsc -b tsconfig.json` | 0, after each commit |
| `npx tsc -p tsconfig.test.json` | 0 `error TS` |
| `npx vitest run --project test` | 34 files passed; 628 passed, 1 expected fail (TestAuthSurface unedited, 1 commit in its history) |
| census pair | 2 files, 17 tests passed |
| `npx vitest run Schema.lock.test` | 13 files, 13 tests passed |
| `npx vitest run test/Contract.test.ts` | 16 files, 1597 tests passed (passkey intermittent did not occur) |
| `git diff --name-only d4282e31` | no `schema.sqlite.json` listed |
| `pnpm circular` | no findings |
| `pnpm lint` | warnings only under untracked `.claude/`, nothing under `packages/` |
| `pnpm format:check` | all files correctly formatted |
| `pnpm test:bdd` | 39 files; 1576 passed, 44 skipped (1620): equal to baseline |
| verbatim gate (contractRunner.ts vs d4282e31) | 0 non-import code lines absent |
| "nothing lost" gate (d4282e31 vs facade + five internal modules) | 0 |
| facade greps | imports 0; declarations 0; `export *` 0; `wired in below` 0; `internal/composition.ts` 4; `internal/contractRunner.ts` 3; header `BEH-EA-193 through BEH-EA-200` 1 |
| contractRunner greps | `TestSql.schemaOf` 1 (facade `schemaOf` 0); `export const migratedSchema` 1; `const applyMigrationsOn` 1; composition, foundation, `../TestFramework.ts` imports 1 each |
| AFTER probe diff | empty; 47 headings |
| Postgres parity case (runner) and Postgres-gated tests | not run locally (`AWTHAQ_POSTGRES_URL` unset) |

## Task Commits

1. **Task 1: extract internal/contractRunner.ts end to end** - `c7d75f77` (refactor)
2. **Task 2: finish TestAuth.ts as a pure facade, AFTER probe** - `0693972e` (refactor)

## Deviations from Plan

None - plan executed exactly as written. (The schema-lock check `git diff --quiet d4282e31 -- ':(glob)**/schema.sqlite.json'` was refused by the worktree command guard as too complex; the equivalent `git diff --name-only d4282e31` shows no schema.sqlite.json changed. Task 1's first `tsc -b` listed only the expected unused-import errors in the facade, removed in the same task.)

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. T-02-08 mitigated (verbatim gate 0 both ways; runPluginContractTests.test.ts, 16 Contract suites, 13 schema locks green; Postgres parity case not run locally). T-02-09 mitigated (star re-exports 0, AFTER probe diff empty, surface pin unedited and green).

## Self-Check: PASSED

- FOUND: packages/test/src/internal/contractRunner.ts
- FOUND: .planning/phases/02-split-testauth/02-SURFACE-AFTER.txt
- FOUND commits c7d75f77, 0693972e
