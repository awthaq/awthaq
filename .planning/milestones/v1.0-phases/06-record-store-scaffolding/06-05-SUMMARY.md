---
phase: 06-record-store-scaffolding
plan: 05
subsystem: testing
tags: [wave-0, source-scan, operation-labels, lock-keys, declaration-hashes, rec-03, rec-04]

requires:
  - phase: 06-record-store-scaffolding
    provides: 06-BASELINE.md (path allowlist, comparison rule), 06-SPIKE.md go verdict and label multisets
provides:
  - RecordsScaffoldPins.test.ts, the Wave 0 source-scan oracle for labels, Ref/Semaphore counts and lock keys
  - 06-SHAPE-DTS.sha256, the 16 emitted declaration hashes (the no-*Shape-change check)
  - 06-BASELINE.md Wave 0 pins record and the 06-05 allowlist line
affects: [06-06, 06-07, 06-08, 06-09, 06-10, 06-11, 06-12]

requirements-completed: []

actuals:
  tokens: 40000
  tasks: 2
  commits: 2
commits: 2
plan_head_before: 112ccb36ba54421238f3f9c8028fbc4498f133df
plan_head_after: 6c056510df52de7f2523353b809d5d1a99cc3eb0

tech-stack:
  added: []
  patterns: ["source-scan pin: expected values as inline literals, the guarded modules read as text and never imported", "label scanner that accepts today's closure and StoreFailure.labelled so the pin survives the adoption"]

key-files:
  created:
    - packages/sql/test/RecordsScaffoldPins.test.ts
    - .planning/phases/06-record-store-scaffolding/06-SHAPE-DTS.sha256
  modified:
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "Label arrays were frozen by a scratch script using the plan's patterns, then the test's own scanner reproduced them: 16 modules, 176 strings, identical to the planner's table"

duration: ~30m
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 05: Wave 0 source-scan pins and declaration hashes Summary

One pin file freezes, per `*Records` module, every StoreUnavailable label and store-named string (176 over 16 modules), the `Ref.make` (17) and `Semaphore.make` (1) counts and the 11 `SqlStore.atomically` lock keys of 9 files; a hash list of the 16 emitted `*Records.d.ts` makes any `*Shape`, layer or record type change visible with `shasum -c`. Both are green on `src` unchanged since `3be32564` and are not edited again.

## Task Commits

1. Task 1: `e47f02e2` test(06-05): pin record-store labels, Ref counts and lock keys before the scaffolding change
2. Task 2: `6c056510` docs(06-05): record the Wave 0 source-scan pin and the declaration hashes

## Results

- `npx vitest run packages/sql/test/RecordsScaffoldPins.test.ts`: 1 file, 4 tests passed. tsc `-b` and `-p tsconfig.test.json` clean; `pnpm lint` has no warning for the file; `pnpm format:check` clean.
- Mutation check (scratch edit of `WebhookRecords.claimDue` in the test's own table, before the add commit): labels case red, 3 others green; restored byte for byte.
- Counts equal the planner's table: 154 calls + 4 writes + 18 direct = 176; ActiveContextRecords non-literal calls 2, others 0; Ref 17 (ImpersonationRecords 2), Semaphore 1; 11 lock keys over 9 files.
- `shasum -a 256 -c 06-SHAPE-DTS.sha256`: 16 OK; the DeviceClientRecords hash equals the planner's (`a7a3443d...10791`).
- `git diff --name-only 3be32564 -- packages examples | grep -c '/src/'`: 0 at both commits; the pin imports nothing it guards (grep gate 0); exactly one commit touches the pin.
- No Postgres leg: the pin reads source text only. No full-suite run was needed, so no known intermittent fired.

## Deviations from Plan

None - plan executed as written. One lint fix before the add commit: the scanner self-check's template literal used an unneeded `\$` escape in a plain string (`no-useless-escape` warning); rewritten as a template literal with `\${`, nothing committed with the warning.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- FOUND: packages/sql/test/RecordsScaffoldPins.test.ts
- FOUND: .planning/phases/06-record-store-scaffolding/06-SHAPE-DTS.sha256
- FOUND commits: e47f02e2, 6c056510
