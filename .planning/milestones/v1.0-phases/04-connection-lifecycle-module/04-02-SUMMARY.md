---
phase: 04-connection-lifecycle-module
plan: 02
subsystem: testing
tags: [bdd, failing-first, postgres, race-test, saml, oidc, domain-claims, suspended-organization]

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-01 baseline, pin matrix and the untouched-src starting point
provides:
  - four BDD scenarios under @BEH-EA-318 (REQ-EA-1569..1572), three red and one green against untouched src
  - seven SAML steps for suspension, create/rename/delete attempts and their outcomes
  - a Postgres-only race oracle (three cases), red against untouched src
  - 04-BASELINE.md sections "BDD red window" and "Wave 0 red: Postgres race"
affects: [04-03, 04-04, 04-05, 04-06, 04-09]

actuals:
  tokens: 6500
  tasks: 2
  commits: 2
plan_head_before: 5f1613189386e73df03b41f05cc21809eec9c2bb
plan_head_after: 9802322d4ebf16f7a0b755d8bf837483c5573fb0

tech-stack:
  added: []
  patterns:
    - "Race oracle: pg_sleep triggers created per case in the suite schema, dropped in Effect.ensuring; outcomes classified by _tag with StoreUnavailable counted separately; one deepStrictEqual of an observed counts object per case"

key-files:
  created:
    - packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts
  modified:
    - features/features/13-enterprise-federation/29-saml-sp.feature
    - features/step-definitions/SamlFederationSteps.ts
    - features/step-definitions/SamlWorld.ts
    - features/traceability.md
    - .planning/phases/04-connection-lifecycle-module/04-BASELINE.md

key-decisions:
  - "The suspension step uses OrganizationRecords.setSuspended (the plan's named fallback), because OrganizationDirectory is not in the SAML World's AppServices union"
  - "Race cases assert one observed-counts object per case (deepStrictEqual), so the recorded red output shows every divergent count at once"

patterns-established:
  - "A failing-first oracle is run red against untouched src and its verbatim output recorded in 04-BASELINE.md before any src change"

requirements-completed: []

duration: 25min
completed: 2026-11-14
status: complete
---

# Phase 4 Plan 02: Failing-first suspended-organization scenarios and the Postgres race oracle Summary

**Four SAML scenarios (REQ-EA-1569..1572) and a three-case Postgres race test land before any src change: the BDD suite is red by exactly the three suspended-organization rows, and the race file is red 3 of 3 on Postgres 16 (deadlock victim as StoreUnavailable, orphan connection, claim and owner rows).**

## Performance

- **Duration:** about 25 min
- **Tasks:** 2
- **Files:** 1 created, 5 modified (no `packages/*/src`, spec or changeset file)

## Accomplishments

- Scenarios under the `@BEH-EA-318` Rule after REQ-EA-1243, tags from `allocate-req-ea.py` (four new unique ids, `features/traceability.md` regenerated, 1361 ids):
  - REQ-EA-1569 suspended create refused like a missing organization: red (`'succeeded'` vs `'InvalidSamlConnectionRequest'`)
  - REQ-EA-1570 suspended update refused: red (`'succeeded'` vs `'InvalidSamlConnectionRequest'`)
  - REQ-EA-1571 suspended metadata refresh refused: red (`'refreshed'` vs `'InvalidSamlConnectionRequest'`)
  - REQ-EA-1572 suspended organization's connection can still be deleted: green (pins "no check on remove")
- SAML feature file alone: `Tests 3 failed | 106 passed (109)`. `pnpm test:bdd`: `Test Files 1 failed | 38 passed (39)`, `Tests 3 failed | 1577 passed | 44 skipped (1624)` (04-01: 1576 / 44 / 1620, so passed +1, total +4). The window closes in 04-06.
- Race oracle `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts`: skipped without `AWTHAQ_POSTGRES_URL` (exit 0, 3 skipped), `Tests 3 failed (3)` with it, run twice with identical results. A case name keeps the word `opposite`. Case 1 deadlocks (remove surfaced as `StoreUnavailable`, one connection, claim, domain and owner row left), case 2 deadlocks on opposite-order owner inserts (`StoreUnavailable` instead of `ConnectionDomainTaken`), case 3 leaves one orphan connection, claim and owner row. Which later plan turns each green is in 04-BASELINE.md (case 2: 04-03; cases 1 and 3: 04-05).
- Postgres: run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).

## Task Commits

1. **Task 1: failing-first suspended-organization scenarios and steps** - `8f738ad7` (test)
2. **Task 2: Postgres race oracle** - `9802322d` (test)

## Verification

- `npx tsc -b tsconfig.json` exit 0; `npx tsc -p tsconfig.test.json` prints no `error TS`.
- `pnpm lint` exit 0, `pnpm format:check` clean, `pnpm spec:verify:strict` `PASS: 32 FAIL: 0 SKIP: 0`.
- `git diff --quiet c683a1bc -- packages/organization/src packages/saml/src packages/scim/src packages/scim/package.json packages/scim/README.md spec .changeset examples` exits 0 at both commits.
- Not re-run in this plan (no src change, only additive tests): `pnpm test` full suite, coverage, knip, package smoke.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `SamlWorld.ts` `AppServices` widened by one type member**
- **Found during:** Task 1 (`tsc -p tsconfig.test.json`, TS2379/TS377004)
- **Issue:** the suspension step needs `OrganizationRecords.setSuspended` (the plan's named fallback; `OrganizationDirectory` is not in the World's `AppServices` union either), but `inApp` only accepts `AppServices | AuthRequestContext`.
- **Fix:** added `OrganizationRecords.OrganizationRecords` to the `AppServices` union and its import in `features/step-definitions/SamlWorld.ts` (type-only; the service is already in the runtime context, as `Saml.test.ts` shows). Not in the plan's `files_modified`; no behaviour change, no `src` file touched.
- **Files modified:** `features/step-definitions/SamlWorld.ts`
- **Commit:** `8f738ad7`

**2. [Verification wording] Race-case assertions are one observed-counts object per case**
- The plan lists the checks per case (outcome classes, zero `StoreUnavailable`, row counts); they are asserted together in one `assert.deepStrictEqual` per case so the recorded red shows every divergent count. Nothing was weakened.

## Known Stubs

None.

## Threat Flags

None. The triggers exist only in the per-suite Postgres schema (dropped per case and with the schema on the next layer build); the file is skipped without `AWTHAQ_POSTGRES_URL` (T-04-04).

## Issues Encountered

None beyond the deviation above. No known intermittent (passkey ChallengeStore, TenantMiddleware) surfaced in the runs of this plan; no re-run was needed.

## Self-Check: PASSED

Created and modified files exist; commits `8f738ad7` and `9802322d` are ancestors of HEAD.
