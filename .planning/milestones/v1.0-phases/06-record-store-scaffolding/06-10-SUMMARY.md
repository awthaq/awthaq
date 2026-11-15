---
phase: 06-record-store-scaffolding
plan: 10
subsystem: records
tags: [keyset, chronological, comparator, rec-04, adoption, organization, saml, scim, webhooks]

requires:
  - phase: 06-record-store-scaffolding
    provides: Keyset.chronological and its first three adopters (06-09), Wave 0 pins, 06-SHAPE-DTS.sha256
provides:
  - "the eight remaining comparator sites build their order with Keyset.chronological: ConnectionRecords listByOrganization, MembershipRecords applySort (direction passed through, .reverse() gone), TeamRecords descendantsIn and listTeamsByOrganization, SamlRecords byCreation and newestFirst, ScimRecords byCreation, WebhookRecords byCreation"
  - "ADOPTION-DELTA comparators recorded in 06-BASELINE.md beside the spike's numbers"
affects: [06-11, 06-12]

requirements-completed: []

actuals:
  tokens: 4000
  tasks: 2
  commits: 3
commits: 3
plan_head_before: 17a54f269d5aa1ca76fd9e059937fa6cd3ba2efd
plan_head_after: 8895a8bae3aafbba2ba829409e2e9a29f5064442

tech-stack:
  added: []
  patterns: ["Keyset.chronological({ createdAt: (row: R) => row.createdAt, id: (row) => row.id, direction }) at every (createdAt, id) listing; ScimRecords passes its tieBreak as id"]

key-files:
  created: []
  modified:
    - packages/organization/src/ConnectionRecords.ts
    - packages/organization/src/MembershipRecords.ts
    - packages/organization/src/TeamRecords.ts
    - packages/saml/src/SamlRecords.ts
    - packages/scim/src/ScimRecords.ts
    - packages/webhooks/src/WebhookRecords.ts
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "No new decision: the plan's site table was applied as written; four localeCompare sites now compare ids by code unit (T-06-20, accepted: identical on canonical lowercase UUIDv7 ids, pinned on both adapters)"

duration: ~25m
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 10: Keyset.chronological adopted at the remaining eight sites Summary

All 11 comparator sites of the 9 files now order through `Keyset.chronological`; every equal-createdAt pin and contract tie case passes unedited on SQLite and Postgres, and the helper's measured delta is recorded.

## Task Commits

1. Task 1 (tracer): `2a799729` refactor(06-10): organization records order with Keyset.chronological (Connection, Membership, Team x2)
2. Task 2: `fb8ecf18` refactor(06-10): saml, scim and webhooks records order with Keyset.chronological; `8895a8ba` docs(06-10): record the comparator helper's delta

## Measurements

- `ADOPTION-DELTA comparators: removed=45 added=103 net=-58` (`git diff --numstat 940aa7a2 HEAD -- packages`, 06-09 PLAN_BASE to `fb8ecf18`); spike was removed=44 added=103 net=-59 (added exact, removed one line higher). Recorded, not gated. Per-file numbers in 06-BASELINE.md "Adoption deltas".
- Census over the 16 files: CMP comparator anchors 13 -> 2 (DeviceGrantRecords F1, SigningKeyRecords F2); `Keyset.chronological(` 11; `localeCompare` 8 -> 2 (WebhookRecords non-adopted sites). Task 1 over its three files: CMP/localeCompare/reverse 0, `chronological(` 4. 16 declaration hashes OK.
- Task 2 commit: 3 files, +23/-15; Task 1 commit: 3 files, +25/-16.

## Verification

- SQLite: `tsc -b` and `tsc -p tsconfig.test.json` clean (pre-existing TS377149 warnings in `features/` only). Task 1 vitest (RecordsScaffoldPins + organization) 1073 passed, 8 skipped. Task 2 vitest (ports, sql, organization RecordOrderPins, saml, scim, webhooks) 1351 passed, 13 skipped. RC9 `Tests 1334 passed (1334)`.
- Postgres (`postgres://postgres:pw@localhost:55433/awthaq`, container `awthaq-p3-pg`, Debian postgres:16, 16.16, recreated fresh before each leg): organization Contract + RecordOrderPins 546 passed; RC9 plus the five pin files `Tests 1372 passed (1372)`, no intermittent hit, no re-run. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).
- Gates at baseline: `pnpm circular`, `check:transactions`, `lint` (exit 0; warnings only in untracked `.claude/hooks`), `format:check`, `check:error-tags` (163 internal and 137 wire, none shared), `check:contract-tests` (all 21 plugin classes); knip filtered output 0 lines, 3 `readme-quickstart.ts` lines.
- Wave 0 pins, contract files and 06-SHAPE-DTS.sha256 unedited. No allowlist change needed (the six files were listed by 06-08).

## Deviations from Plan

None - plan executed exactly as written. `DateTime` stayed in use in all six files, so no import was removed. MembershipRecords: the `.reverse()` removal equals the flipped order (ids unique); doc comment now says "flipped for `desc`".

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Commits 2a799729, fb8ecf18, 8895a8ba are ancestors of HEAD; the six source files and 06-BASELINE.md contain the changes.
