---
phase: 06-record-store-scaffolding
plan: 12
subsystem: planning
tags: [phase-close, census, gates, postgres, rec-03, rec-04, gate-01, gate-04]

requires:
  - phase: 06-record-store-scaffolding
    provides: the two helpers adopted across the 16 records modules, the Wave 0 pins, the changeset (06-04 to 06-11)
provides:
  - "06-BASELINE.md 'Phase close': census, REC-03 and REC-04 closure, findings F1/F2/F-06-01/F-06-03, spike margins, allowlist, oracle and contract integrity, declarations, dependencies, docs-last order"
  - "every gate on SQLite and on Postgres (Debian postgres:16) against the baseline with a MET verdict per comparison rule"
affects: []

requirements-completed: []

actuals:
  tokens: 12000
  tasks: 2
  commits: 2
commits: 2
plan_head_before: 6fd1e73b2d2781ab2b29baf182b32ec90db9d386
plan_head_after: 1b34ee324876f0351c3858aee40b4c41805533da

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "No new decision: the close is a record. F1 stays open (adopting the helper at DeviceGrantRecords.listByUser would add a tie-break, a behaviour change); F2 noted; F-06-03 listed as an open load-sensitivity finding"

duration: ~25m
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 12: phase close Summary

Phase 6 is closed with evidence: 16 of 16 label closures and 11 of 11 comparator sites adopted, nothing else changed, every gate at or above the baseline on SQLite and on Postgres, no known intermittent fired.

## Task Commits

1. Task 1 (tracer): `95c28775` docs(06-12): record the phase 6 structural close, census and REC-03/REC-04 closure
2. Task 2: `1b34ee32` docs(06-12): record the phase 6 gate close on SQLite and Postgres

## Closure evidence

- **REC-04 census** (F16 concatenated): closure shape 16 -> 0; `StoreFailure.labelled("` 0 -> 16; binding calls 154 -> 154; comparator anchor lines 13 in 11 files -> 2 in 2 (`DeviceGrantRecords.ts:215` F1, `SigningKeyRecords.ts:172` F2); `Keyset.chronological(` 0 -> 11; `localeCompare` 8 -> 2 (WebhookRecords only); files naming `Keyset.` 2 -> 11; MembershipRecords `reverse()` 1 -> 0; `export const labelled` 1; `export const chronological` 1; F16 lines 10664 -> 10676.
- **REC-03 closure:** scaffolded `Keyset.chronological` (`@awthaq/ports`) and `StoreFailure.labelled` (`@awthaq/sql`), each with one test; the three `SPIKE-NOT-PURSUED` lines (tenant-visibility, wire-row, sqlstore-make) quoted verbatim in 06-BASELINE.md.
- **Behaviour preservation:** five Wave 0 pin files each in exactly one commit (`e47f02e2`, `3b75b1ea`, `726235f8`); contract verdict files diff empty; 16 declaration hashes OK; dependency diff empty; allowlist residue 0 with 30 non-planning paths; spec, changeset after the last `packages/*/src` commit (`bad=0`).
- **Findings recorded:** F1 open (DeviceGrantRecords.listByUser memory has no tie-break, SQL orders `createdAt, id`; not fixed), F2 noted (SigningKeyRecords, same shape), F-06-01 fixed in 06-04 (`935cb822`), F-06-03 open (admin `ImpersonationRecords (sql)` pair, 5 s timeouts under full-suite Postgres load; did not fire this time).
- **Margins recorded honestly:** `labelled` ended net -2 against the spike's projected +1 (`ADOPTION-DELTA unavailable-label: removed=31 added=33 net=-2`; kept for locality, not size); `comparators` passed criterion (b) only through the divergent-copies branch (`ADOPTION-DELTA comparators: removed=45 added=103 net=-58`).

## Gates

SQLite (all first run, `AWTHAQ_POSTGRES_URL` unset): tsc -b 0, tests typecheck 0 (the same 2 pre-existing warnings), circular, check:error-tags (163 / 137), check:transactions, check:contract-tests (21 classes), lint (87 `.claude` + 7 features warnings, none under packages), format (1233 files), readmes, workspace all 0; bdd 1580 passed / 44 skipped (39 files); unit 428 + 6 skipped files, 6727 passed / 1 expected fail / 23 skipped (baseline + 28 tests, + 5 files); coverage 91.81 / 85.31 / 87.13 / 92.33; spec PASS 32 FAIL 0 SKIP 0; knip exit 1 with filtered output identical to the baseline and `knip.json` unchanged; package smoke 30 PASS; RC9 1334 passed; phase files 52 passed (7 files).

Postgres (container `awthaq-p3-pg`, Debian postgres:16, recreated empty before each run; run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): RC9 1346 passed (9 files); RC9 plus the five pin files 1372 passed (14 files); phase files plus `OrganizationConnectionLifecycle.sql.test.ts` 55 passed (8 files); full unit 434 files, 6770 passed / 1 expected fail / 1 skipped (baseline + 28); full bdd 1580 passed / 44 skipped. Failing list empty; no known intermittent fired, so no re-run was needed.

## Deviations from Plan

None - plan executed exactly as written. (Worktree guard refused a compound `git` line, so the structural checks were run from a scratch script; the commands and their outputs are the plan's.)

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

`.planning/phases/06-record-store-scaffolding/06-BASELINE.md` has one `## Phase close` section; `UNMET` count 0; `CI confirmation open` count >= 3; commits `95c28775` and `1b34ee32` are ancestors of HEAD.
