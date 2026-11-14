---
phase: 04-connection-lifecycle-module
plan: 09
subsystem: verification
tags: [phase-close, gates, baseline, postgres, scim-exclusion]
status: complete

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-01 baseline and Wave 0 oracles; 04-02..04-08 the lifecycle module, both stores over it, DomainClaims boundary, specs and changeset
provides:
  - "04-BASELINE.md 'Phase close' section: allowlist, SCIM proofs, structural census, oracle integrity, gate table against the baseline, Postgres records, comparison-rule verdicts"
affects: []

actuals:
  tokens: 9000
  tasks: 2
  commits: 1
plan_head_before: fa29e41f493441859e7090bab7cb71be33a87a83
plan_head_after: 2828b9c6f8dd08ced2e8cc56a20209bbe0661dbc

tech-stack:
  added: []
  patterns:
    - "Phase-close comparison: every gate recorded next to its 04-01 baseline row with a verdict per comparison-rule item"

key-files:
  created: []
  modified:
    - .planning/phases/04-connection-lifecycle-module/04-BASELINE.md

key-decisions:
  - "Both tasks produce one record and one commit: the 04-BASELINE.md Phase close section (the plan says Task 1 does not commit and Task 2 commits the section alone)"

requirements-completed: []
---

# Phase 4 Plan 09: Phase-close gate Summary

**The phase meets every 04-01 baseline gate on SQLite and on the CI Postgres image: allowlist clean, SCIM untouched except the characterization test, census at its expected end state, no oracle edited; CI confirmation stays open (no git remote).**

## What was done

- Task 1 (structural close): `git diff --name-only c683a1bc HEAD` lists 57 paths, none outside the allowlist. SCIM src, package.json and README are byte-identical to c683a1bc; the only SCIM change is `A packages/scim/test/ScimConnectionOrphan.test.ts`. Census: `withClaim`/`withRelease` 9 -> 0; `DomainClaims` outside organization 2 -> 0; `const DOMAIN = ` 2 -> 1 (`OrganizationConnectionLifecycle.ts:64`); `directory.find(` 1 -> 0; `SqlStore.atomically` in DomainClaims.ts 0 -> 4; no-SAML grep still the two comment lines; root `DomainClaims` export 1 -> 0. Each Wave 0 oracle has exactly one commit since c683a1bc; the DomainClaims contract file numstat is `112 0`. F-04-01 and CONN-F1 are in 04-FINDINGS.md.
- Task 2 (gates): every gate on the baseline's terms (table in 04-BASELINE.md). Unit 420 passed + 6 skipped files, 6648 tests (baseline 417+4 / 6593); bdd 1580 passed, 44 skipped, 0 failed; coverage 91.73 / 85.22 / 87.03 / 92.25 (floors 89/83/84/90); spec 32/0/0; error tags 163/137; contract tests 21; knip exit 1 with filtered output identical to the baseline; package smoke 30 PASS. Postgres (Debian postgres:16, run locally on the CI image, CI confirmation open (no git remote)): baseline legs 774 passed, phase files plus the race oracle 590 passed, full `pnpm test` 6690 passed after one re-run of the known passkey intermittent, full `pnpm test:bdd` 1580 passed.

## Task Commits

1. Tasks 1 and 2 (one record, per the plan): `2828b9c6` docs(04-09): record the phase-close census, SCIM proofs and gate comparison against the baseline

## Deviations from Plan

None - plan executed as written. Notes, not deviations:

- The plan's verify blocks were run as their component commands (the worktree guard refuses chained git forms); each value was compared against the same expectation.
- knip: the baseline's filtered block was compared by hand (identical), as the plan allows when extraction is not exact.
- Known intermittent: Postgres full `pnpm test` run 1 failed once on the passkey ChallengeStore "consume [atomic]" case (the only failure); the single re-run was green. Recorded in 04-BASELINE.md. SQLite `pnpm test` and `pnpm coverage` were green first time.

## Known Stubs

None. No src file changed.

## Threat Flags

None.

## Issues Encountered

None. CI confirmation of the Postgres results remains open because the repo has no git remote.

## Self-Check: PASSED

- 04-BASELINE.md contains the "Phase close" section and the line `CI confirmation open (no git remote)`.
- Commit `2828b9c6` is an ancestor of HEAD.
