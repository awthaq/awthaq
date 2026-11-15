---
phase: 06-record-store-scaffolding
plan: 03
subsystem: spike
tags: [spike, go-no-go, rec-02, record-store, comparators, store-failure]

requires:
  - phase: 06-record-store-scaffolding
    provides: 06-BASELINE.md (path allowlist, go-branch obligations), 06-02 (ADR-EA-041 rev 1.7, REC-01)
provides:
  - 06-SPIKE.md with the CONTEXT rule verbatim, the reproduced census, per-helper (a)/(b)/(c) measurements, findings F1-F2, verdict go, and a continuation input
affects: [06-04]

actuals:
  tokens: 14700
  tasks: 3
  commits: 3
commits: 3
plan_head_before: b0de5660412fcde882f1095513c33cec3e83bb9f
plan_head_after: 3f325034a588ff34ba6005f5cbea68e633b98517

tech-stack:
  added: []
  patterns: []

key-files:
  created:
    - .planning/phases/06-record-store-scaffolding/06-SPIKE.md
  modified: []

key-decisions:
  - "SPIKE-VERDICT: go. comparators and unavailable-label pass all three criteria; tenant-visibility, wire-row and sqlstore-make are not pursued"

requirements-progressed: [REC-02]

duration: long
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 03: Record-store scaffolding spike Summary

The CONTEXT per-helper rule, applied mechanically with the plan's D1-D9 to a re-run census and four oxfmt-formatted scratch prototypes, gives `SPIKE-VERDICT: go` with two passed helpers, `comparators` (Keyset.chronological in `@awthaq/ports`) and `unavailable-label` (StoreFailure.labelled in `@awthaq/sql`), both on thin margins.

## Result

| Helper | (a) files | (b) removed / added / net | (c) | Verdict |
|--------|-----------|---------------------------|-----|---------|
| comparators | 9 | 44 / 103 / -59, passes by divergent copies (3 spellings, `<` chains against `localeCompare`) | pass | pass |
| tenant-visibility | 2 | n/e | n/e | not pursued ((a) fails) |
| unavailable-label | 16 | 31 / 30 / +1 | pass | pass |
| wire-row | 16 (14 adoptable) | 14 / 24 / -10, one spelling | pass | not pursued ((b) fails) |
| sqlstore-make | 16 | 198 / 247 / -49, names only | pass (`read`/`once` variant) | not pursued ((b) fails) |

Census re-run reproduced the planning value exactly (`CENSUS: files=16 lines=10664 labels=154 closure=16 dialectFields=16 make=0 atomically=5 matches=2 visibility=2 lift=10 keyset=2 comparator=11 localeCompare=5 makeRow=4`). Collation probe: 0 of 20000 canonical UUIDv7 pairs differ between `localeCompare` and code-unit order. 29 spike operations classified: 9 read, 6 write, 14 once. `spike-check.sh` prints `spike-check OK: go (comparators, unavailable-label)`.

## Margins (reported as measured, not adjusted)

- comparators fails the line-count branch of (b) by 59 lines and passes only through the divergent-copies branch (D6).
- unavailable-label passes (b) by net +1. A test case wrapped in its own `describe` (the first prototype, 2 more lines) measured net -1 and would fail; the D5 convention (an `it` inside an existing `describe`) was applied uniformly to all prototypes and the final value is +1.

## Findings

- F1: `DeviceGrantRecords.listByUser` memory sort has no id tie-break while SQL orders `"createdAt" ASC, id ASC`; the contract does not pin equal-time rows; recorded, not fixed.
- F2: `SigningKeyRecords.newestFirst` has no tie-break on either side; consistent.

## Deviations from Plan

- Test-case placement: the first comparators and unavailable-label prototypes wrapped the new `it` in its own `describe`; D5 says one `it` case, so both were redone with the `it` inside an existing `describe` before the final counts (the -1 intermediate is disclosed in 06-SPIKE.md). Not a rule deviation; recorded because it moves unavailable-label's net by 2.
- sqlstore-make relabelling lengthens each call and oxfmt re-wraps; the plan's "same length" assumption does not hold, which is part of the measured result.
- Restricted the comparators adopter set to the 11 sites of the 13 census anchors that have an id tie-break; four non-anchor sort sites and the two no-tie-break sites are listed, not adopted.

## Known Stubs

None.

## Threat Flags

None. No file outside `.planning/` changed; `git diff --quiet 3be32564 -- packages features examples docs .changeset` exits 0 and `git status --porcelain -- packages features examples docs spec .changeset` prints nothing; the prototype directory was deleted and does not exist.

## Self-Check: PASSED

- 06-SPIKE.md exists and carries the machine lines; the three task commits are ancestors of HEAD (d9a72dc6, 97450c45, 3f325034).
