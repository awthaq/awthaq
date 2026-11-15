---
phase: 06-record-store-scaffolding
plan: 02
subsystem: spec
tags: [adr, adr-ea-041, adr-ea-046, plan-24, track-a, rec-01]

requires:
  - phase: 06-record-store-scaffolding
    provides: 06-BASELINE.md (spec:verify:strict PASS 32 / FAIL 0 / SKIP 0, path allowlist)
provides:
  - ADR-EA-041 Revision 1.7 (Track A closure note, alternative (e), ADR-EA-046 released)
  - .planning annotations of the ADR-EA-046 reservation and the plan 24 banner
  - REC-04 wording that freezes today's per-module Ref count
affects: [06-03]

actuals:
  tokens: 4000
  tasks: 2
  commits: 2
plan_head_before: 3b6c54749569c74902e57b2b89ee4c112e1909e7
plan_head_after: cfdc3645264e6455c4362e81a481d89f6fb583cd

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - spec/decisions/041-domain-store-ports.md
    - .planning/README.md
    - .planning/24-memory-records-over-sqlite/PLAN.md
    - .planning/REQUIREMENTS.md

key-decisions:
  - "ADR-EA-046 is released, not used: Track A closure is recorded in ADR-EA-041 Revision 1.7 (revision note plus alternative (e)); no 046 file, no index.yaml row, no traceability change, no new id"

requirements-progressed: [REC-01]

duration: 15min
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 02: ADR-EA-041 Revision 1.7 closes Track A Summary

**ADR-EA-041 is Revision 1.7: a revision note and alternative (e) record plan 24 Track A (SQLite as the memory adapter) closed and ADR-EA-046 released, with decision text unchanged.**

## Tasks

1. ADR-EA-041 Revision 1.7 (`c9a629ca`): Revision, Effective Date and the `<br> 1.7 (` Change History entry changed in one edit; "Revision note (1.7)" paragraph between Negative and Alternatives; alternative (e) directly after (d). The only removed lines are the three Document Control lines.
2. Planning annotations (`cfdc3645`): both ADR-EA-046 rows in `.planning/README.md` say released and name ADR-EA-041 rev 1.7; plan 24 carries a "Track A closed" banner line; the REC-04 line in `.planning/REQUIREMENTS.md` now says every `layerMemory` keeps today's `Ref` count (checkbox left unticked, traceability row untouched).

## Verification

- `pnpm spec:verify:strict`: PASS 32 / FAIL 0 / SKIP 0 (equal to the 06-BASELINE.md figure; checks 10 and 14 pass).
- `pnpm check:readmes`: exit 0. `python3 features/scripts/allocate-req-ea.py --check`: exit 0 (manifest current).
- Structural greps and awk ordering check of Task 1, grep checks of Task 2: all pass.
- `git diff --name-only 3be32564 HEAD` lists only `spec/decisions/041-domain-store-ports.md` and `.planning/` paths (allowlist holds). `index.yaml`, `traceability.md`, packages, features, examples, docs, `.changeset` unchanged; no `spec/decisions/046-*` file.

## For the orchestrator

ROADMAP.md line 166 (Phase 6 success criterion 3) carries the old clause "Every `layerMemory` stays one `Ref<State>`". It was not edited (the orchestrator owns ROADMAP.md); align it with the new REC-04 wording ("keeps today's `Ref` count: one `Ref<State>` per store, `ImpersonationRecords` two `Ref`s and a `Semaphore`").

## Deviations from Plan

None - plan executed as written. One no-op Edit call (identical old and new string) was rejected by the tool and had no effect.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Files modified exist; commits `c9a629ca` and `cfdc3645` are on `architecture/deepening-batch-3`.
