---
phase: 06-record-store-scaffolding
plan: 09
subsystem: ports
tags: [keyset, chronological, comparator, rec-03, rec-04, adoption, device-authorization, api-key]

requires:
  - phase: 06-record-store-scaffolding
    provides: StoreFailure.labelled adopted in all 16 closures (06-07, 06-08), Wave 0 pins, 06-SHAPE-DTS.sha256
provides:
  - "Keyset.chronological({ createdAt, id, direction }): Order.Order<Row>, appended after paginate in @awthaq/ports"
  - "DeviceClientRecords.oldestFirst, ApiKeyClientRecords.newestFirst and ApiKeyRecords.newestFirst build their comparator with the helper (3 of 11 comparator sites)"
  - "the 06-09 allowlist line in 06-BASELINE.md"
affects: [06-10, 06-11, 06-12]

requirements-completed: []

actuals:
  tokens: 2500
  tasks: 2
  commits: 4
commits: 4
plan_head_before: 940aa7a25649040d4954f4412751a901eae8ad9b
plan_head_after: 5d239e26324bd07bd357c34aae4a90fbc39cdd72

tech-stack:
  added: []
  patterns: ["Keyset.chronological({ createdAt: (record: R) => record.createdAt, id: (record) => record.<id>, direction }); desc is Order.flip of the ascending (createdAt, id) order"]

key-files:
  created: []
  modified:
    - packages/ports/src/Keyset.ts
    - packages/ports/test/Keyset.test.ts
    - packages/device-authorization/src/DeviceClientRecords.ts
    - packages/api-key/src/ApiKeyClientRecords.ts
    - packages/api-key/src/ApiKeyRecords.ts
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "No new decision: the helper is the 06-SPIKE.md prototype with the explicit Order.Order<Row> return type; annotating the first accessor's parameter (as the plan says) is enough for tsc to infer Row"

duration: ~20m
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 09: Keyset.chronological and its first three adopters Summary

`Keyset.chronological` (the `(createdAt by DateTime.Order, id by code unit)` order, `desc` as its `Order.flip`) is scaffolded with one test and replaces the hand-written comparator in the three spike-file stores; every pinned order is unchanged.

## Task Commits

1. Task 1: `54e0d09a` feat(06-09): Keyset.chronological orders a record listing by (createdAt, id); `c1050cd4` refactor(06-09): DeviceClientRecords orders clients with Keyset.chronological
2. Task 2: `71d79189` refactor(06-09): api-key records order newest first with Keyset.chronological; `5d239e26` docs(06-09): allowlist the chronological helper

## Measurements

`git diff --numstat 940aa7a2 HEAD -- packages` (added/removed): Keyset.ts 14/0, Keyset.test.ts 17/0, DeviceClientRecords 8/4, ApiKeyClientRecords 8/5, ApiKeyRecords 8/5 (helper delta for 06-10: 14 src + 17 test added, adopters 24/14). CMP census over the three files 0 (was 3), `Keyset.chronological(` calls 3, `export const chronological` 1. 16 declaration hashes OK after `npx tsc -b`.

## Verification

- SQLite: `tsc -b`, `tsc -p tsconfig.test.json` clean (pre-existing TS377149 warnings in `features/` only); Keyset test 13 passed; task 1 vitest (Keyset + RecordsScaffoldPins + device-authorization) 186 passed; task 2 vitest (ports + pins + device-authorization + api-key) 667 passed; RC9 `Tests 1334 passed (1334)`.
- Postgres (`postgres://postgres:pw@localhost:55433/awthaq`, container `awthaq-p3-pg`, Debian postgres:16, 16.16): device-authorization contract 69 passed. RC9 run 1 (fresh container): 1345/1346, the single failure the known intermittent 3 (`ImpersonationRecords (sql) create [atomic]`, 5006 ms timeout); run 2 on a freshly recreated container: `Tests 1346 passed (1346)`. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).
- Gates: `pnpm circular`, `check:transactions`, `lint` (exit 0), `format:check` (exit 0), `check:error-tags` (163 internal and 137 wire, none shared), `check:contract-tests` (all 21 plugin classes) at baseline; knip filtered output 0 lines, 3 `readme-quickstart.ts` lines (baseline; `chronological` is consumed).
- Wave 0 pins, contract files and 06-SHAPE-DTS.sha256 unedited; the three contract tie cases (DeviceClientRecords :117, ApiKeyClientRecords :98, ApiKeyRecords :131) pass on both adapters.

## Deviations from Plan

None - plan executed exactly as written. (One re-run of intermittent 3 on a fresh container, recorded above; `DateTime` stayed in use in all three files so no import was removed.)

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Commits 54e0d09a, c1050cd4, 71d79189, 5d239e26 are ancestors of HEAD; `Keyset.ts`, its test, the three adopter files and 06-BASELINE.md contain the changes.
