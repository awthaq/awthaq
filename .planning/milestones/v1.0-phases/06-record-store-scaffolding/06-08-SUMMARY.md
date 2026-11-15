---
phase: 06-record-store-scaffolding
plan: 08
subsystem: sql
tags: [store-failure, labelled, rec-04, adoption, organization, saml, scim, webhooks]

requires:
  - phase: 06-record-store-scaffolding
    provides: StoreFailure.labelled and its first six adopters (06-07), Wave 0 pins, 06-SHAPE-DTS.sha256
provides:
  - "the remaining ten records modules (seven organization, SamlRecords, ScimRecords, WebhookRecords) bind their closure through StoreFailure.labelled, one line each"
  - "all 16 closures replaced (census 0 / 16 / 154)"
  - "ADOPTION-DELTA unavailable-label and the 06-08 allowlist line in 06-BASELINE.md"
affects: [06-09, 06-10, 06-11, 06-12]

requirements-completed: []

actuals:
  tokens: 1500
  tasks: 3
  commits: 4
commits: 4
plan_head_before: 40658c77e9938d6f7f598bc723e436d3d07660e5
plan_head_after: b20a4f55e8e7f24a6744be4bd38c15010827d561

tech-stack:
  added: []
  patterns: ["const unavailable = StoreFailure.labelled(\"<Store>\"); WebhookRecords keeps `failing`"]

key-files:
  created: []
  modified:
    - packages/organization/src/ActiveContextRecords.ts
    - packages/organization/src/ConnectionRecords.ts
    - packages/organization/src/InvitationRecords.ts
    - packages/organization/src/MembershipRecords.ts
    - packages/organization/src/OrganizationRecords.ts
    - packages/organization/src/OrgRoleRecords.ts
    - packages/organization/src/TeamRecords.ts
    - packages/saml/src/SamlRecords.ts
    - packages/scim/src/ScimRecords.ts
    - packages/webhooks/src/WebhookRecords.ts
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "No new decision: the adoption is the spelling the plan prescribed; ActiveContextRecords' two non-literal `unavailable(operation)` calls needed no change because labelled returns typeof orStoreUnavailable"

duration: ~25m
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 08: label helper adoption in organization, saml, scim and webhooks Summary

The last ten records modules replace their two-line `unavailable` (one-line `failing` in WebhookRecords) closure with `StoreFailure.labelled("<Store>")`; all 16 modules now use the helper, every label, lock key and Ref/Semaphore count is byte-identical and the 154 binding calls are untouched.

## Task Commits

1. Task 1: `f3e39d23` refactor(06-08): organization records (ActiveContext, Connection, Invitation, Membership)
2. Task 2: `4964f026` refactor(06-08): organization records (Organization, OrgRole, Team)
3. Task 3: `4df927bc` refactor(06-08): saml, scim and webhooks records; `b20a4f55` docs(06-08): the label helper's delta and the allowlist line

## Measurements

Census over the 16 files (F16): today's template-closure shape 0, `StoreFailure.labelled("` 16, `(unavailable|failing)("` calls 154. 16 declaration hashes OK after `npx tsc -b`.

```
ADOPTION-DELTA unavailable-label: removed=31 added=33 net=-2
```

(`git diff --numstat 312ab409 HEAD -- packages`: 15 adopters 1/2, WebhookRecords 1/1, StoreFailure.ts 6/0, StoreFailure.test.ts 11/0.) Spike: removed=31 added=30 net=1; sites match exactly (31 removed, 16 added), the helper is 6 lines instead of 4 and its test 11 instead of 10 (explicit return type, formatter breaks). Recorded in 06-BASELINE.md, not gated.

## Verification

- SQLite: `tsc -b`, `tsc -p tsconfig.test.json` clean (pre-existing TS377149 warnings in `features/` only); task 1 vitest (sql pins + organization + three RecordOrderPins) 1089 passed | 8 skipped; task 2 (pins + organization) 1073 passed | 8 skipped; task 3 (`packages/sql/test`, organization pins, saml, scim, webhooks) 1050 passed | 13 skipped; RC9 `Tests 1334 passed (1334)`.
- Postgres (`postgres://postgres:pw@localhost:55433/awthaq`, container `awthaq-p3-pg`, Debian postgres:16, 16.16): tasks 1 and 2 organization contract + pins 550 passed each. Full RC9 + 26 pins leg: run 1 (fresh container) and run 2 (same container) each had one failure, the known intermittent 3 `ImpersonationRecords (sql) create [atomic]` 5005 ms timeout (1371/1372); run 3 on a freshly recreated container: `Tests 1372 passed (1372)`. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).
- Gates: `pnpm circular`, `check:transactions`, `lint` (exit 0; warnings only in untracked `.claude/hooks`), `format:check`, `check:error-tags` (163 internal and 137 wire, none shared), `check:contract-tests` (all 21 plugin classes) at baseline; knip filtered output 0 lines, 3 `readme-quickstart.ts` lines (baseline).

## Deviations from Plan

None - plan executed exactly as written. (The re-runs of intermittent 3 are recorded above: 3 runs in all, within the allowance.)

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Commits f3e39d23, 4964f026, 4df927bc, b20a4f55 are ancestors of HEAD; the ten source files and 06-BASELINE.md contain the changes; the Wave 0 pins, contract files and 06-SHAPE-DTS.sha256 are unedited.
