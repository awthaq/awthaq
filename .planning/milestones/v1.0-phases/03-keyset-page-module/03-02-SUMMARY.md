---
phase: 03-keyset-page-module
plan: 02
subsystem: testing
tags: [keyset, pagination, pin-matrix, wire-cursor, vitest]

requires:
  - phase: 03-keyset-page-module
    provides: 03-01 gate baseline and the KEY-04 golden cursor test
provides:
  - KeysetPins.test.ts, the domain pin matrix for Users.list, AdminTenants.listOrganizations and Admin.list (18 cases, memory)
  - KeysetHttp.test.ts, the organization wire cursor and the limit/cursor bounds on /admin/organizations and /admin/users (4 cases)
  - the Wave 0 head recorded in 03-BASELINE.md
affects: [03-03, 03-04, 03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 11000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Pins reach listings only through Users.list, AdminTenants.listOrganizations, Admin.list and record creation; expected order and cursor bytes are derived independently in the test"
    - "Generic walker over a list function: ids and cursor presence per page, so a wrong page count or a missing final None fails"

key-files:
  created:
    - packages/admin/test/KeysetPins.test.ts
    - packages/admin/test/KeysetHttp.test.ts
  modified:
    - .planning/phases/03-keyset-page-module/03-BASELINE.md

key-decisions:
  - "Wire pins serve with testClock: true and advance 1 ms between organization creates; app.run runs outside the test's TestClock, so TestClock.adjust inside it fails"
  - "Cursor types are named through the aliases 03-05/03-06/03-07 keep (Users.UserCursor, AdminTenants.OrganizationCursor, ImpersonationRecords.ImpersonationCursor), so the pins stay byte-unchanged"

patterns-established:
  - "Wave 0: golden, domain pins and wire pins all green on untouched src before any keyset change"

requirements-completed: []

duration: 30min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 5f30bf70402e8285305512cbe7313f023f35a933
plan_head_after: ba8bdc151254ad8685129e2ee73909a954555c94
---

# Phase 3 Plan 02: Domain and wire pin matrix Summary

**Wave 0 closes: 22 new cases pin today's caller-visible page behaviour of the three listings and the organization wire cursor against untouched src, so every later keyset plan proves it kept them.**

Requirements KEY-02, KEY-04 and KEY-06 are baselines here, not proofs; none is ticked by this plan (the orchestrator marks them after phase close).

## Performance

- **Duration:** about 30 min
- **Tasks:** 2 of 2
- **Files:** 2 created, 1 planning file modified; nothing under `packages/*/src`, `spec`, `features` or `.changeset` changed (`git diff --quiet e74a8a9a -- ...` exits 0)

## Pins added

KeysetPins.test.ts (18 tests), five shared cases run for each of `Users.list`, `AdminTenants.listOrganizations`, `Admin.list` (15 tests):
- 51 rows, no limit: [50, cursor] then [1, none]
- 201 rows: 200 and a cursor at limit 200 and at 10_000
- clamp over 3 rows: limits 0, -3, 2.5, NaN, 10_000 answer (1,true), (1,true), (2,true), (3,false), (3,false)
- 7 rows in tie groups 3, 1, 3: every limit 1..8 walks every row once in (createdAt, id code unit) order (reversed for `Admin.list`), in ceil(7/limit) pages, the last without a cursor
- exactly full: limit 5 over 5 rows gives no cursor; limit 4 gives a cursor

Plus three `Admin.list` cases: the post-page gate (`canManageEpisode` hiding `hidden`: page 1 is [shown-2] with a cursor, page 2 [shown-1] with none); `{ active: true }` skipping an ended episode inside a tie group at limits 1..4; tenant confinement (org-a walks never hold an org-b row at limits 1..4, and an org-a cursor replayed under org-b returns exactly the org-b rows strictly after it).

KeysetHttp.test.ts (4 tests): `/admin/organizations?limit=2` cursor equals `Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url")` of the second item and following it returns the third item with a null cursor; 400 for limit=0, limit=201, limit=2.5 and cursor=garbage; 403 for a non-superadmin; `/admin/users` limit=201 gives 400 and limit=200 gives 200.

## Gate results

| Check | Result |
|-------|--------|
| `npx vitest run` over KeysetHttp, KeysetPins, KeysetCursors | 3 files, 34 tests passed |
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` | no `error TS` (2 pre-existing TS377149 warnings) |
| `pnpm lint` / `pnpm format:check` | exit 0 / clean; no warning on the new files |
| forbidden-symbol grep on KeysetPins.test.ts (`pageLimit`, `listPage`, `.next`, ...) | 0 |
| `git diff --quiet e74a8a9a -- packages/{ports,sql,core,admin,organization}/src spec features .changeset` | exit 0 |
| Postgres-gated cases | not run locally (none are in these files; the Wave 0 golden's Postgres leg stays CI only) |

All 22 expectations matched today's behaviour on the first run; none was adjusted. Mutation checks: flipping the post-page gate's first-page cursor presence failed 1 case, swapping the key order of the expected organization wire cursor failed 1 case; both reverted.

## Task Commits

1. **Task 1: domain pin matrix** - `d04d6d62` (test)
2. **Task 2: wire pins and Wave 0 head in 03-BASELINE.md** - `ba8bdc15` (test)

## Deviations from Plan

None - plan executed exactly as written. Two fixes inside the plan's latitude: the first wire run failed because `TestClock.adjust` is not available inside `app.run` (the app runs on its own runtime); the harness's `testClock: true` and `app.advance` give the distinct organization instants instead. The generic walker needed an annotated lambda for the tenant walk (exactOptionalPropertyTypes inference).

## Issues Encountered

- The worktree guard refuses chained git commands; they were issued plainly.

## Known Stubs

None.

## Threat Flags

None. T-03-03 and T-03-04 mitigations are pinned (403 before paging, short page with a cursor, tenant replay, 400 bounds); these files stay byte-unchanged through the phase (checked at 03-09). No package installed (T-03-SC).

## Next Phase Readiness

Wave 0 is complete. 03-03 can start the keyset module with the baseline, golden and both pin files green on untouched src.

## Self-Check: PASSED

- FOUND: packages/admin/test/KeysetPins.test.ts, packages/admin/test/KeysetHttp.test.ts, .planning/phases/03-keyset-page-module/03-BASELINE.md
- FOUND commits d04d6d62, ba8bdc15
