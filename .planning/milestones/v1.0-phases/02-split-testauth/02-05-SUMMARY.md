---
phase: 02-split-testauth
plan: 05
subsystem: testing
tags: [spec, traceability, testauth, phase-close, gate-comparison]

requires:
  - phase: 02-split-testauth
    provides: 02-04 contractRunner.ts and the pure TestAuth facade
provides:
  - Spec citations for BEH-EA-342/351/352/353, INV-EA-016 and the traceability matrix pointing at internal/composition.ts, internal/appHarness.ts, internal/contractRunner.ts
  - Phase close comparison against 02-BASELINE.md (every gate matches, counts grew by exactly one file and one test)
affects: []

actuals:
  tokens: 8000
  tasks: 2
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Spec Revision + Effective Date + Change History row moved in one edit (1.16, 1.90, 1.10), as in Phase 1 ffe1e99f"

key-files:
  created: []
  modified:
    - spec/behaviors/25-testing-harness.md
    - spec/traceability.md
    - spec/invariants.md

key-decisions:
  - "No changeset: the probe diff is empty and packages/test/package.json exports only `.`, so no change is package-visible (GATE-03 binds package-visible changes)"

patterns-established: []

requirements-completed: [TEST-04, TEST-01, TEST-02, TEST-03]

duration: 40min
completed: 2026-11-14
status: complete
commits: 1
plan_head_before: 9067f743aad39a202bee139822b0decbd589a29c
plan_head_after: 34f572a9
---

# Phase 2 Plan 05: Spec citations and phase close Summary

**The spec now cites where the TestAuth composition, harness and contract runner live (Revisions 1.16 / 1.90 / 1.10), and every Wave 0 gate matches at phase close, with +1 file and +1 test from TestAuthSurface.test.ts and nothing lost.**

## Accomplishments

- `spec/behaviors/25-testing-harness.md` (Revision 1.15 -> 1.16): BEH-EA-342 cites `packages/test/src/internal/composition.ts`, re-exported as `TestAuth.layer`; BEH-EA-351/352/353 cite `packages/test/src/internal/appHarness.ts`. Test file names kept (TestAuthHost, TestAuthRecords.types, AdminTier, TestAuthLifetime, TestAuthLazy, TestAuthListen). The two header citations (the facade's header, which stayed) and BEH-EA-351's out-of-scope `TestAuth.app` sentence untouched.
- `spec/traceability.md` (1.89 -> 1.90): file-25 row keeps the facade path over the four full internal module paths; TestAuthLifetime, TestAuthLazy and TestAuthListen rows cite `@awthaq/test/src/internal/appHarness.ts`; new `packages/test/test/TestAuthSurface.test.ts` row (cites the facade).
- `spec/invariants.md` (1.9 -> 1.10): INV-EA-016 Enforcement cites `packages/test/src/internal/contractRunner.ts`.
- Case-sensitive path check: every `@awthaq/test/src/...ts` and `packages/test/src/...ts` path cited by the three files is byte-for-byte in `git ls-files packages/test/src` (0 misses).

## Scope checks (before any gate)

| Check | Result |
|-------|--------|
| Allowlist: `git diff --name-only d4282e31 HEAD` outside `packages/test/`, the two census tests, `spec/`, `.planning/` | 0 of 28 files outside |
| Census lines: non-`file: "test/src/` changed lines in `packages/core/test` | 0; numstat `2 2` for each census file |
| `.changeset` and `knip.json` diff from d4282e31 | empty |

Files changed since d4282e31 (28): `.planning/` (16), `packages/core/test/{RequestContextSeams,SignInSeams}.test.ts`, `packages/test/src/TestAuth.ts`, `packages/test/src/internal/{appHarness,composition,contractRunner,foundation,session}.ts`, `packages/test/test/TestAuthSurface.test.ts`, `spec/behaviors/25-testing-harness.md`, `spec/invariants.md`, `spec/traceability.md`.

## Phase close vs baseline

Run in the order of the plan so nothing read a stale `lib/`; knip and `package:smoke` ran after `pnpm clean && pnpm build`.

| Gate | Baseline (exit, summary) | Close (exit, summary) | Verdict |
|------|--------------------------|-----------------------|---------|
| `npx tsc -b tsconfig.json` | 0, no output | 0, no output | match |
| `npx tsc -p tsconfig.test.json` | 0, 0 `error TS`, 2 pre-existing `warning TS377149` | 0, 0 `error TS`, 2 `warning TS` | match |
| `npx vitest run --project test` | 0, 33 files; 627 passed, 1 expected fail (628) | 0, 34 files; 628 passed, 1 expected fail (629) | match, +1 file +1 test (TestAuthSurface) |
| census pair | 0, 2 files, 17 tests | 0, 2 files, 17 tests | match |
| `npx vitest run Schema.lock.test` | 0, 13 files, 13 tests | 0, 13 files, 13 tests | match |
| `npx vitest run test/Contract.test.ts` | 0, 16 files, 1597 tests | 0, 16 files, 1597 tests | match |
| `pnpm test` | 0, 410 files passed + 4 skipped (414); 6490 passed, 1 expected fail, 15 skipped (6506) | 0, 411 passed + 4 skipped (415); 6491 passed, 1 expected fail, 15 skipped (6507) | match, +1 file +1 test |
| `pnpm test:bdd` | 0, 39 files; 1576 passed, 44 skipped (1620) | 0, 39 files; 1576 passed, 44 skipped (1620) | match |
| `pnpm circular` | 0, no findings | 0, no findings | match |
| `pnpm spec:verify:strict` | 0, PASS 32 FAIL 0 | 0, PASS 32 FAIL 0 SKIP 0 | match |
| `pnpm check:error-tags` | 0, 163 internal / 137 wire | 0, 163 internal / 137 wire, none shared | match |
| `pnpm check:transactions` | 0 | 0 | match |
| `pnpm check:contract-tests` | 0, all 21 plugin classes | 0, all 21 plugin classes; `@awthaq/test` stays dev-only | match |
| `pnpm coverage` | 0, 91.65 / 85.08 / 86.91 / 92.17 | 0, 91.65 / 85.08 / 86.91 / 92.17 (floors 89 / 83 / 84 / 90) | match, above floors |
| `pnpm lint` | 0, warnings only (`.claude/`, 7 in features RequestContextSteps) | 0, warnings only, none under `packages/` | match |
| `pnpm format:check` | 0, 1205 files | 0, 1210 files | match (+5 = new internal modules and surface test) |
| `pnpm check:readmes` | 0 | 0 | match |
| `pnpm workspace:check` | 0, 29 packages and 3 examples | 0, 29 packages and 3 examples | match |
| `pnpm clean`, `pnpm build` | n/a | 0, 0 | pass |
| `pnpm package:smoke` | 0, 30 PASS | 0, 30 PASS (`package:smoke: PASS test`; publint and attw accept lib/internal/*.d.ts) | match |
| `pnpm knip` (filtered) | 1 (pre-existing), banner, 2 headings, 3 readme-quickstart rows | 1 (pre-existing), same banner, headings and 3 readme-quickstart rows; 0 rows under packages/examples/features/scripts/spec beyond the three; none under `packages/test/src/internal` | match |

Coverage for the new internal modules (informational): appHarness.ts 96.66 / 83.92 / 95.83 / 96.42; composition.ts 95.45 / 90.47 / 90 / 95.45; session.ts 100 / 85.71 / 100 / 100. Baseline `TestAuth.ts` was 83.94 / 77.96 / 86.39 / 84.8.

Test and file deltas: the `test` project and `pnpm test` each gained exactly TestAuthSurface.test.ts and its one case; no file or test disappeared. Skipped counts unchanged (15 unit, 44 bdd).

`git diff --stat knip.json`: empty. Working tree after the gates: only the untracked `.claude/**` and `.planning/state.json` entries recorded at baseline.

## Records

1. **Census exception.** The four `file:` literals in `packages/core/test/SignInSeams.test.ts` and `RequestContextSeams.test.ts` were edited (2 lines each, by decision, 02-CONTEXT "Decided autonomously"). Those tests read source text keyed by path and import nothing from the TestAuth facade, so they are not consumers of it. ROADMAP success criterion 1 literally forbids editing anything outside `packages/test`; this is a disclosed deviation from its literal wording, not from the plan. Every other consumer is untouched (allowlist 0).
2. **No changeset.** The probe diff (02-SURFACE-BEFORE.txt vs 02-SURFACE-AFTER.txt) is empty and `packages/test/package.json` exports only `.`, so nothing is package-visible; GATE-03 binds package-visible changes. `git diff --name-only d4282e31 HEAD -- .changeset` is empty.
3. **Postgres.** `pnpm test:pg` was not run: Postgres-gated cases (`TestAuthHost.test.ts`, cited by BEH-EA-342, and the contract runner's Postgres parity case) are not run locally (`AWTHAQ_POSTGRES_URL` unset); they are skipped inside the counts above.
4. **Passkey intermittent** (ChallengeStore "consume [atomic]: false for any other value, a tampered one included"): did not occur in this plan's `test/Contract.test.ts`, `pnpm test` or `pnpm coverage` runs, and 02-04's SUMMARY records it did not occur there either. No re-run was needed.
5. **Count discrepancy.** ROADMAP and CONTEXT say 12 Schema.lock tests; the tree has 13 (baseline and close both 13 files, 13 tests). Recorded as a documentation discrepancy, not a regression.

## Task Commits

1. **Task 1: spec citations, Revisions 1.16 / 1.90 / 1.10** - `34f572a9` (docs)
2. **Task 2: phase close** - no source commit (verification only); recorded in this SUMMARY and the plan metadata commit.

## Deviations from Plan

None - plan executed exactly as written. Process note: the plan-head ledger file (protocol 0c) was not written under the worktree's git dir because that directory resolves inside the other checkout; `plan_head_before` is the HEAD SHA at start (9067f743), kept in the scratchpad.

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. T-02-10 mitigated (case-sensitive path check 0 misses; spec checks 10 and 14 pass, Change History rows added). T-02-11 mitigated (scope checks ran before gates; knip filter requires the three known rows; knip.json and `.changeset` unchanged).

## Self-Check: PASSED

- FOUND: spec/behaviors/25-testing-harness.md, spec/traceability.md, spec/invariants.md (edits present, strict spec verification PASS 32 FAIL 0)
- FOUND commit 34f572a9
