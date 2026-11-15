---
phase: 06-record-store-scaffolding
plan: 07
subsystem: sql
tags: [store-failure, labelled, rec-03, rec-04, adoption]

requires:
  - phase: 06-record-store-scaffolding
    provides: Wave 0 pins (RecordsScaffoldPins, four RecordOrderPins), 06-SHAPE-DTS.sha256, 06-SPIKE.md unavailable-label adopters
provides:
  - "StoreFailure.labelled(store): orStoreUnavailable bound to one store name, typed typeof orStoreUnavailable, with one test"
  - "six records modules (DeviceClient, DeviceGrant, ApiKeyClient, ApiKey, SigningKey, Impersonation) bind unavailable on one line"
  - "06-BASELINE.md allowlist line for 06-07"
affects: [06-08, 06-09, 06-10, 06-11, 06-12]

requirements-completed: []

actuals:
  tokens: 6000
  tasks: 2
  commits: 6
commits: 6
plan_head_before: 312ab409a8c891baf66332371940ca8be334d3b9
plan_head_after: bdf216b2cdd7948ac18ae778f8c45e9bfe8423f4

tech-stack:
  added: []
  patterns: ["const unavailable = StoreFailure.labelled(\"<Store>\"); one line per closure, call sites unchanged"]

key-files:
  created: []
  modified:
    - packages/sql/src/StoreFailure.ts
    - packages/sql/test/StoreFailure.test.ts
    - packages/device-authorization/src/DeviceClientRecords.ts
    - packages/device-authorization/src/DeviceGrantRecords.ts
    - packages/api-key/src/ApiKeyClientRecords.ts
    - packages/api-key/src/ApiKeyRecords.ts
    - packages/jwt/src/SigningKeyRecords.ts
    - packages/admin/src/ImpersonationRecords.ts
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "labelled is annotated `(store: string): typeof orStoreUnavailable`, so each adopter's binding keeps its exact type and call sites"

duration: ~30m
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 07: StoreFailure.labelled and its first six adopters Summary

`StoreFailure.labelled(store)` (6 lines in `packages/sql/src/StoreFailure.ts`) forwards to `orStoreUnavailable` with `<store>.<operation>`; six records modules replace their two-line `unavailable` closure with `StoreFailure.labelled("<Store>")`, every label, lock key and Ref/Semaphore count byte-identical.

## Task Commits

1. Task 1a: `4083d617` feat(06-07): StoreFailure.labelled binds orStoreUnavailable to one store name
2. Task 1b: `32914fbf` refactor(06-07): DeviceClientRecords labels its operations through StoreFailure.labelled
3. Task 2: `746feea8` DeviceGrantRecords; `b15e70a1` ApiKeyClientRecords and ApiKeyRecords; `8157f414` SigningKeyRecords and ImpersonationRecords
4. Task 2 (record): `bdf216b2` docs(06-07): allowlist the labelled helper and its first six adopters

## Measured delta (git diff --numstat 312ab409 HEAD -- packages)

| File | + | - |
|------|---|---|
| packages/sql/src/StoreFailure.ts | 6 | 0 |
| packages/sql/test/StoreFailure.test.ts | 11 | 0 |
| six adopters (each) | 1 | 2 |

Helper plus test: +17. Six adopters: +6 / -12 (net -6). Total src: +12 / -12 (net 0); the helper pays for itself only once the ten remaining adopters (06-08) land.

## Results

- Pins and package suites (`packages/sql/test`, the four RecordOrderPins, device-authorization, api-key, jwt, admin): `Test Files 72 passed | 3 skipped`, `Tests 1028 passed | 13 skipped`; after Task 1: 12 files, 208 tests passed. StoreFailure.test.ts 13 passed (new `labelled` case green).
- RC9 SQLite `Tests 1334 passed (1334)` (run after Task 1 and after Task 2). RC9 Postgres `Tests 1346 passed (1346)` after Task 1; after Task 2 with the scaffold pins `Tests 1350 passed (1350)` (10 files). Postgres container recreated fresh before each leg; run locally on the CI image (Debian postgres:16, 16.16), CI confirmation open (no git remote).
- `shasum -a 256 -c 06-SHAPE-DTS.sha256`: 16 OK after `npx tsc -b` (both tasks). `npx tsc -p tsconfig.test.json` clean.
- Gates: `pnpm circular`, `check:transactions`, `lint` (exit 0), `format:check`, `check:error-tags` (163 internal and 137 wire, none shared), `check:contract-tests` (all 21 plugin classes) at baseline; knip filtered 0 and readme-quickstart count 3 (labelled is consumed).
- `git diff --name-only 3be32564 -- packages examples` over contract/pin/RecordsContract paths: 5 (only the five pin files). No pin, contract file or `06-SHAPE-DTS.sha256` edited.
- `export const labelled` count 1, `typeof orStoreUnavailable` count 1 in StoreFailure.ts; six `StoreFailure.labelled("` lines, zero closures of today's shape in the six files.
- No known intermittent fired; no run repeated.

## Deviations from Plan

- Task 2's verify block was run once over the five files together (not once per commit group); the three commits were made after that single green run. No behaviour difference. The five-file edit used one perl substitution rather than five hand edits.

Otherwise none - plan executed as written.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- FOUND commits: 4083d617, 32914fbf, 746feea8, b15e70a1, 8157f414, bdf216b2
- FOUND: `labelled` in packages/sql/src/StoreFailure.ts; `- 06-07:` line in 06-BASELINE.md
