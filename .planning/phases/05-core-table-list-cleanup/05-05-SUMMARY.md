---
phase: 05-core-table-list-cleanup
plan: 05
subsystem: docs
status: complete
tags: [core-tables, catalogue, spec, traceability, readme, changeset]

requires:
  - phase: 05-core-table-list-cleanup
    provides: 05-03 CoreTables catalogue; 05-04 consumers projecting from it
provides:
  - spec names the CoreTables catalogue (28-tenancy BEH-EA-231/233/328, overview package map, traceability rows)
  - packages/sql README documents the catalogue and its two classified exclusions
  - the phase's one changeset with its Migration paragraph
affects: [05-06]

actuals:
  tokens: 6000
  tasks: 2
  commits: 2
plan_head_before: 597b5adcada5b62d377951e2390999c3f7298db0
plan_head_after: 5c34401f6903316a301c830f74c08e130e59d693

tech-stack:
  added: []
  patterns:
    - "Spec Revision and Change History bumped in the same edit (check 14)"

key-files:
  created:
    - .changeset/core-table-catalogue.md
  modified:
    - spec/behaviors/28-tenancy.md
    - spec/overview.md
    - spec/traceability.md
    - packages/sql/README.md

key-decisions:
  - "No BEH/REQ id allocated; BEH-EA-037 not cited; LaggingReplica row cites ADR-EA-024 / RRC-008 only"

requirements-completed: []

duration: 10min
completed: 2026-11-14
---

# Phase 5 Plan 05: Spec, README and changeset for the CoreTables catalogue Summary

The spec, traceability matrix and sql README now name the `CoreTables` catalogue where they list core tables, and `.changeset/core-table-catalogue.md` (sql minor, test and core patch) carries the `Migration:` paragraph for the `TenantScope` list type change.

## Commits

- `6e073820` docs(05-05): spec names the CoreTables catalogue (28-tenancy 1.15 -> 1.16, overview 1.18 -> 1.19, traceability 1.93 -> 1.94, each with its Change History entry)
- `5c34401f` docs(05-05): sql README and changeset for the CoreTables catalogue

## Verification

- `pnpm spec:verify:strict`: PASS 32, FAIL 0, SKIP 0 (equals baseline)
- `pnpm format:check`: all matched files use the correct format; `pnpm check:readmes`: passes
- `pnpm knip` filtered: only the three baseline `readme-quickstart.ts` rows under packages/
- Only docs files changed since 05-04 (no source or test change)

## Deviations from Plan

None - plan executed exactly as written. `npx oxfmt` reports "no target files" for the md files (md is ignored), as the notes anticipated.

## Known Stubs

None.

## Self-Check: PASSED
