---
phase: 07-world-scaffold-and-credentials-split-optional
plan: 06
subsystem: features-world-scaffold
tags: [bdd, world, classification, guard]
requires: ["07-05"]
provides:
  - "features/features/_guard/world-table.steps.test.ts: one test, inline map of all 31 Worlds, four assertions"
  - "07-WORLD-TABLE.md: 31 rows (3 scaffolded, 5 hand-wired, 23 no-tail) with the honest record that only the events subscriber repeats"
affects: ["07-07"]
key-files:
  created:
    - features/features/_guard/world-table.steps.test.ts
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-WORLD-TABLE.md
decisions:
  - "The scaffold-subscription check reads the `.stream` property of the event bus in comment-stripped code; it is the signature of the inline subscriber the scaffold replaced"
metrics:
  tasks: 2
  commits: 2
  plan_head_before: cfd5281ab9f9844ac69dfc2f952721b084fbdd35
  plan_head_after: bb33999275b4b24b193cafd421ac578a5ea297dc
status: complete
actuals:
  tokens: 9000
  tasks: 2
  commits: 2
---

# Phase 7 Plan 6: The World classification guard and table Summary

A one-test guard classifies all 31 `*World.ts` files from an inline map and was shown to fail on an unclassified World and on a misclassified one; `07-WORLD-TABLE.md` is its committed, re-measured human copy.

## Commits

- `006a9fa0` test(07-06): guard the World classification
- `bb339992` docs(07-06): record the World classification table

## Measured results

- Guard: 1 file, 1 test passed, `[leak-guard] features/_guard/world-table.steps.test.ts apps=0 sqlClients=0`. Map 31 entries (3 scaffolded, 5 hand-wired, 23 no-tail); `it(` count 1.
- Mutation (a): empty `ZzzWorld.ts` made the guard fail with `ZzzWorld: unclassified`; file deleted, `git status --short features/step-definitions` empty. Mutation (b): `AdminWorld` flipped to `no-tail` failed with `AdminWorld: no-tail but imports ./shared/EventCapture.ts`; restored from a byte copy (grep confirms the entry).
- Table: 31 rows (3 / 5 / 23), its World set equals the files on disk (diff 0), carries `only the events subscriber repeats`, the `Hand-wired on purpose` source and the guard path.
- Full `pnpm test:bdd` (SQLite): exit 0, Test Files 40 passed (40), Tests 1581 passed, 44 skipped (1625): baseline 39 / 1580 / 44, so +1 file and +1 passed test, skipped unchanged. Sorted `[leak-guard]` lines differ from `07-LEAK-GUARD-BEFORE.txt` by exactly one added line, the guard file's.
- `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` clean (only the pre-existing `TestingHarnessSteps.ts` TS377149 warnings); `pnpm lint` exit 0 (baseline warnings, none in the guard); `pnpm format:check` clean; `pnpm circular` exit 0; `pnpm knip` exit 1 with no row for the guard file (baseline rows only).
- Integrity: no World, helper or package file changed in this plan; the diff against `ee8b80a1` over `features/step-definitions` and `packages` stays inside the planned set (0 outside).

## Deviations from Plan

None - plan executed exactly as written. Table cells that cite line ranges were re-measured against the current files (the scaffolded Worlds' ranges moved after the adoptions) rather than copied from the research census.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- `features/features/_guard/world-table.steps.test.ts` and `07-WORLD-TABLE.md` exist; commits `006a9fa0` and `bb339992` are on the branch.
