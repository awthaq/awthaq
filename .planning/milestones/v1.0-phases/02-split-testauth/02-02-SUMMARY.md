---
phase: 02-split-testauth
plan: 02
subsystem: testing
tags: [testauth, composition, internal-modules, facade, census]

requires:
  - phase: 02-split-testauth
    provides: 02-01 surface snapshot, gate baseline and TestAuthSurface.test.ts pin
provides:
  - packages/test/src/internal/composition.ts, the composition behind every TestAuth.layer overload (verbatim move)
  - RetentionRegistryService and FoundationServices in internal/foundation.ts beside FoundationRegistries
  - TestAuth.ts re-exporting every composition and foundation name by name (makeLayer stays off the facade)
affects: [02-03, 02-04, 02-05]

actuals:
  tokens: 30000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Mechanical line-range move via a throwaway script kept in the scratchpad, never committed"
    - "Named facade re-exports only; internal helper (makeLayer) exported from the internal module for the sibling runner, never re-exported"

key-files:
  created:
    - packages/test/src/internal/composition.ts
  modified:
    - packages/test/src/TestAuth.ts
    - packages/test/src/internal/foundation.ts
    - packages/core/test/RequestContextSeams.test.ts

key-decisions:
  - "Encryption.Encryption named in composition.ts's TestProvided union (the original line-281 pattern) to keep testPorts and encryption declaration emit portable (TS2883) once FoundationServices no longer keeps the Encryption namespace in scope there"

patterns-established:
  - "Leaf-first extraction: composition before the contract runner that imports makeLayer and recordModes from it"

requirements-completed: [TEST-01]

duration: 15min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 1d0ada122cb589d04110cabf2b08b2bd1d6d6f4d
plan_head_after: 03c8571a0dab3022d2f9c3298176175bab35b769
---

# Phase 2 Plan 02: Extract composition and foundation type names Summary

**TestAuth's composition (test ports, redaction guard, makeLayer, the layer overloads, encryption and the HTTP client doubles) now lives verbatim in internal/composition.ts behind named facade re-exports, with the two foundation type names moved beside FoundationRegistries.**

## Accomplishments

- `internal/composition.ts`: TestHasher, testPorts, fixedClientAddress, GuardLive, TestCsrfConfig, recordModes, CommonOptions, SqlMode, MemoryMode, the private helper types, `makeLayer` (now `export`, for the contract runner only), both `layer` overloads plus implementation, `encryption`, `clientReturning`, `httpClient`. Moved by line range with a script, never retyped.
- `TestAuth.ts`: regions removed; `export { TestCsrfConfig, encryption, httpClient, layer, recordModes }` and `export type { CommonOptions, MemoryMode, SqlMode }` from composition; `import { makeLayer, recordModes }` for the runner still in the facade; `export type { FoundationServices, RetentionRegistryService }` from foundation; unused imports trimmed.
- Census: `RequestContextSeams.test.ts` ClientAddress entry keys `test/src/internal/composition.ts` (count 2, why unchanged); `git diff --numstat d4282e31` reads `1 1`.
- `GuardLive` is still merged into the decorate slot and `UndeclaredEventPolicy` is still provided as `"die"` (acceptance greps 1 and 1).

## Gate results

| Gate | Result |
|------|--------|
| `npx tsc -b tsconfig.json` | 0, after each commit |
| `npx tsc -p tsconfig.test.json` | 0 `error TS`, after each commit |
| `npx vitest run --project test` | 34 files passed; 628 passed, 1 expected fail (unchanged vs baseline), after each commit |
| census pair | 2 files, 17 tests passed, after each commit |
| `pnpm circular` | 0, after each commit |
| `TestAuthSurface.test.ts` | green, unedited (makeLayer not on `TestAuth.*`) |
| `npx vitest run test/Contract.test.ts` | first run 1 failure (passkey ChallengeStore "consume [atomic]: false for any other value, a tampered one included", the `(sql)` variant); re-run 16 files, 1597 tests green |
| `pnpm lint` | no error under packages; warnings only under untracked `.claude/` (as baseline) |
| `pnpm format:check` | all files correctly formatted |
| Postgres-gated tests | not run locally |

Acceptance greps: composition.ts exists; `export const makeLayer` present; `ClientAddress.ClientAddress` count 2; facade has 3 `from "./internal/composition.ts"` lines (2 re-export clauses plus the runner import); no internal module imports the facade; foundation.ts holds both aliases, TestAuth.ts holds none, and has 3 `from "./internal/foundation.ts"` lines.

## Task Commits

1. **Task 1: extract internal/composition.ts end to end** - `af3e388b` (refactor)
2. **Task 2: move RetentionRegistryService and FoundationServices into internal/foundation.ts** - `03c8571a` (refactor)

## Deviations from Plan

**1. [Verbatim-move gate, false-fail by an anticipated TS2883 fix] One added code line in composition.ts**
- **Found during:** Task 1
- **Issue:** with FoundationServices (the only user of the `Encryption` namespace) gone from the facade, `tsc -b` reported TS2883 on `testPorts` and `encryption`, whose inferred type references `Encryption` from `@awthaq/ports`.
- **Fix:** the plan's own remedy: name the type in composition.ts the way the original line 281 does. Added `type Encryption` to the `@awthaq/ports` import and `| Encryption.Encryption` after `| SmsSender.SmsSender` in `TestProvided`. The union already contained it through `Layer.Success<ReturnType<typeof testPorts>>`, so no type changes; the surface and every gate are unchanged.
- **Consequence for the gate:** the verbatim gate (`grep -vxFf` count of non-import, non-makeLayer code lines absent from d4282e31's TestAuth.ts) reads 1, not 0: the single line is `  | Encryption.Encryption`. The only other absent line is makeLayer's own `export const makeLayer = <` (oxfmt split the one-line generics over several lines; the continuation lines are byte-identical to lines already present at d4282e31, and the gate excludes lines containing `makeLayer`). The gate was not edited.
- **Files modified:** packages/test/src/internal/composition.ts
- **Commit:** af3e388b

No other deviations.

## Issues Encountered

- The passkey ChallengeStore intermittent (recorded in 02-BASELINE.md; here the `(sql)` variant of the same case) failed once in `test/Contract.test.ts`; the single allowed re-run passed.
- The worktree guard refused chained shell commands and `git` calls inside compound commands; all were issued plainly.

## Known Stubs

None.

## Threat Flags

None. No new network, auth, file or schema surface; T-02-03 (makeLayer moved as one unit, GuardLive and `"die"` policy greps green, runPluginContractTests and TestAuthDecorate tests in the `test` project run green) and T-02-04 (surface pin green) are mitigated.

## Self-Check: PASSED

- FOUND: packages/test/src/internal/composition.ts
- FOUND commits af3e388b, 03c8571a
