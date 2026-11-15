---
phase: 05-core-table-list-cleanup
plan: 06
subsystem: verification
status: complete
tags: [phase-close, census, gates, postgres, cat-04]

requires:
  - phase: 05-core-table-list-cleanup
    provides: 05-01 baseline and comparison rule; 05-02 pins; 05-03 catalogue; 05-04 consumers; 05-05 spec, README, changeset
provides:
  - "Phase close" section of 05-BASELINE.md: census pair 4 -> 2, CAT-04 closure, allowlist, oracle integrity, dependency proof, gate table, Postgres records, comparison-rule verdicts
affects: []

actuals:
  tokens: 9000
  tasks: 2
  commits: 2
plan_head_before: 53d7037db9a032bebfb4898396722ce00a019f47
plan_head_after: 56ac97bc91d9a622a59074635608c293d2815ead

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - .planning/phases/05-core-table-list-cleanup/05-BASELINE.md

key-decisions:
  - "CAT-04 closes with the catalogue, not the minimal-fix branch: a second real copy (BDD STAMPED_TABLES) and two unclassified core tables existed; evidence is the census pair 4 -> 2"

requirements-completed: []

duration: 25min
completed: 2026-11-14
---

# Phase 5 Plan 06: Phase-close gate Summary

Every phase-5 gate was re-run on SQLite and on the Debian postgres:16 CI image and meets the 05-BASELINE.md comparison rule (nine rules, all MET, no regression); no source changed.

## Commits

- `d19c9ab4` docs(05-06): record the phase 5 structural close and the CAT-04 census
- `56ac97bc` docs(05-06): record the phase 5 gate close on SQLite and Postgres

## Results versus the baseline

- Census: reservations grep 4 -> 2 lines (`CoreTables.ts:26` row and the `TenancySteps.ts:473` case label); `coreTables` in Auth.ts 2 -> 0; `STAMPED_TABLES` 2 -> 0; `as const` in TenantScope.ts 2 -> 0; LaggingReplica hand list 6 -> 0; barrel export 0 -> 1; auth_relay_cursor and rate_limit_buckets classified (2 rows).
- Allowlist: 34 changed paths, filter prints nothing. Oracles: one commit each (`7720a413`, `31385d7b`), additions-only files 0 removed lines. Dependencies: package.json and lockfile diff empty, three `@awthaq/sql` edges unchanged, `pnpm circular` 0.
- SQLite: all gates exit as baseline (knip 1 pre-existing, filtered output identical, knip.json untouched). Unit 423 + 6 skipped files, 6695 passed / 1 expected fail / 23 skipped (baseline 420 / 6676 / 22; the +1 skipped is the new Postgres-only P8 test); bdd 1580 / 44 unchanged; coverage 91.81 / 85.24 / 87.13 / 92.33 (baseline 91.75 / 85.24 / 87.06 / 92.27); spec PASS 32 FAIL 0 SKIP 0; error-tags 163 / 137; contract-tests 21; smoke 30 PASS.
- Postgres (run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): targeted 8 files / 73 tests green (incl. CoreTablePins, CoreTables, TenantScope.postgres); full unit 429 files / 6738 passed, no failures; bdd 39 / 1580 / 44. No shared-memory or connection symptoms.
- Known intermittents did not fire; no re-runs needed.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- 05-BASELINE.md "Phase close" present; `UNMET` count 0; `CAT-04 closure`, `minimal-fix`, `Comparison rule verdicts` present; commits `d19c9ab4` and `56ac97bc` are ancestors of HEAD.
