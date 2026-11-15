---
phase: 06-record-store-scaffolding
plan: 04
subsystem: testing
tags: [f-06-01, gate-04, postgres, advisory-lock, race-test, baseline]

requires:
  - phase: 06-record-store-scaffolding
    provides: 06-BASELINE.md (known intermittents, path allowlist, comparison rule), 06-03 spike verdict go
provides:
  - key-scoped advisory-waiter latch in the deletion-vs-create race test
  - 06-BASELINE.md Amendments section with the F-06-01 evidence; F-06-01 removed from the known-intermittent list; first go-branch allowlist addition
affects: [06-05, 06-12]

requirements-completed: [GATE-04]

actuals:
  tokens: 9000
  tasks: 2
  commits: 2
commits: 2
plan_head_before: f9a0600f57d18ed5726a25dbb039d11f767b3d68
plan_head_after: 69fc1a9417cc8cd06a7009bab0e964532e3e6b0b

tech-stack:
  added: []
  patterns: ["wait on a pg_locks row for one advisory key (classid/objid decomposition), never a database-wide count"]

key-files:
  created: []
  modified:
    - packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "F-06-01 removed from the comparison rule: alone runs 6/6 green (3 under planted foreign waiters), two clean full Postgres runs, test never failed post-fix"

duration: ~2h (mostly full-suite waits)
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 04: F-06-01 scoped advisory-waiter latch Summary

The race test now waits for a waiter on its own lock keys (`LATCH_KEY`, then the hashed `organization_domain_claim:org:<id>`) instead of any advisory waiter in the shared database, and the baseline records the proof and drops F-06-01 from the known intermittents.

## Performance

- Test only; no `src` change; assertions byte-identical (`git diff -U0` shows no changed `assert` line).
- Pre-fix at PLAN_BASE with two planted foreign waiters: the race case failed deterministically (`create: "ok"` instead of `"InvalidConnection"`).
- Post-fix: file alone 3/3 green, 3/3 green under two foreign waiters held throughout, SQLite skips as before.
- Full `pnpm test` on Postgres (fresh container each): two clean runs (429 files, 6742 passed, 1 expected fail, 1 skipped). Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).

## Task Commits

1. Task 1: `935cb822` test(06-04): scope the race test's advisory-waiter latch to its lock keys (F-06-01)
2. Task 2: `69fc1a94` docs(06-04): record the F-06-01 fix evidence and amend the baseline

## Deviations from Plan

None in the work. Run-record notes (all in 06-BASELINE.md Amendments):
- The first full run on the bloated container (1.8 GB, 2492 leaked schemas) gave three 5 s timeouts and is recorded as a non-result; the container was recreated (`pg-fresh.sh`) before each later full run.
- Full runs: one failed only on the known passkey `ChallengeStore` intermittent (re-run green); one failed on two admin `ImpersonationRecords (sql)` 5 s timeouts (re-run green; `packages/admin/test/Contract.test.ts` alone 3/3 green). The F-06-01 test passed in every post-fix run.

## Issues Encountered

New unlisted intermittent, flagged not fixed (out of scope): admin `RecordsContract: awthaq/admin/records/ImpersonationRecords (sql)` `create [atomic]: an interrupted create leaves its row and its link together, or neither` and `create [race]: 8 creates racing verifyChain never report a break` time out at 5 s under full-suite load (2 of 5 full Postgres runs, one of them on the bloated container). The phase close should decide whether it joins the known-intermittent list.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` and `06-BASELINE.md` modified as recorded; commits `935cb822` and `69fc1a94` are on the branch; unscoped advisory-waiter count on the container is 0.
