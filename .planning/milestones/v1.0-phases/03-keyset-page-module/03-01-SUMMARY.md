---
phase: 03-keyset-page-module
plan: 01
subsystem: testing
tags: [keyset, cursor, golden-test, gate-baseline, base64url, vitest]

requires:
  - phase: 02-split-testauth
    provides: gate baseline format and the Wave 0 pin discipline
provides:
  - 03-BASELINE.md, the Phase 3 gate baseline with keyset structural baselines, KEY-07 path list, Postgres record and phase-close comparison rule
  - KeysetCursors.test.ts, the KEY-04 golden pinning the three cursor wire encodings against today's code (memory and SQL)
affects: [03-02, 03-03, 03-04, 03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 8700
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Golden cursor oracle: pinned base64url literals, each also checked against an independent Buffer derivation, length 112, no padding, key order"
    - "Seeded xorshift SecureRandom, built fresh per layer, so memory and SQL legs mint identical ids"

key-files:
  created:
    - .planning/phases/03-keyset-page-module/03-BASELINE.md
    - packages/admin/test/KeysetCursors.test.ts
  modified: []

key-decisions:
  - "Ledger for the plan HEAD base written to the scratchpad instead of the worktree git-dir (the git-dir resolves under the other checkout's .git)"
  - "Wave 0 golden asserts whole pages (ids plus encoded cursor or null) in one deepStrictEqual per traversal, so a wrong page count or a missing final None fails the case"

patterns-established:
  - "Wave 0: baseline and golden land green on untouched src before any keyset change"

requirements-completed: [KEY-04, GATE-04, KEY-06, KEY-07]

duration: 35min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 241554c6ec4611419f5b8dd064caacaea2244b13
plan_head_after: 667e9918fb1e0291c04792949780b43bf8bac0d3
---

# Phase 3 Plan 01: Gate baseline and KEY-04 golden cursor test Summary

**Phase 3 gate baseline measured on an untouched tree, plus a 12-case golden test that pins all three keyset cursor wire encodings (users and organizations createdAt, impersonations startedAt) byte for byte on memory and SQL.**

## Performance

- **Duration:** about 35 min (the gate run about 14 min of it)
- **Tasks:** 2 of 2
- **Files:** 2 created, 0 modified; nothing under `packages/*/src`, `spec`, `features` or `.changeset` changed

## Baseline numbers (HEAD 241554c6, `git diff --quiet e74a8a9a -- packages spec features .changeset knip.json scripts` exit 0)

| Gate | Exit | Result |
|------|------|--------|
| tsc -b / tsc -p tsconfig.test.json | 0 / 0 | 0 `error TS` (2 pre-existing TS377149 warnings) |
| circular, check:error-tags, check:transactions, check:contract-tests | 0 | error-tags 163 internal / 137 wire; 21 plugin classes |
| lint / format:check / check:readmes / workspace:check | 0 | warnings only (87 `.claude/`, 7 `RequestContextSteps.ts`); 1210 files formatted; 29 packages + 3 examples |
| pnpm test:bdd | 0 | 39 files; 1576 passed, 44 skipped |
| pnpm test | 0 | 411 files passed, 4 skipped; 6491 passed, 1 expected fail, 15 skipped |
| pnpm coverage | 0 | 91.66 / 85.08 / 86.93 / 92.18 (floors 89/83/84/90) |
| spec:verify:strict | 0 | PASS 32 FAIL 0 |
| knip | 1 (pre-existing) | 39 `.claude/` unused files + 3 readme-quickstart unlisted deps, identical to Phase 2 |
| package:smoke | 0 | 30 PASS |
| StoreContract (5 files) | 0 | 457 passed |
| records contracts (admin, organization) | 0 | 641 passed |
| listing domain and HTTP (5 files) | 0 | 79 passed |
| SQL adapters (2 files) | 0 | 14 passed |

Structural keyset baselines: KEY-06 scoped grep prints 16 lines (Users.ts 6, ImpersonationRecords.ts 7, AdminApi.ts 2, AdminTenants.ts 1); webhooks' `MAX_PAGE_SIZE`/`DEFAULT_PAGE` survivors recorded as intentional; add-one sites 5; expanded-OR 1 + 1; keyset ORDER BY 2 / 1 / 2; users page-field reads 12. The KEY-07 untouched-path list, the Postgres record (`test:pg` and every Postgres-gated case "not run locally"; docker CLI 29.1.3 installed, daemon down, `AWTHAQ_POSTGRES_URL` unset; CI path `.github/workflows/check.yml` running `pnpm check` against a `postgres:16` service) and the phase-close comparison rule are in 03-BASELINE.md. Numbers were measured, not copied from the research.

The passkey ChallengeStore intermittent did not occur; no re-run was needed.

## Golden literals pinned (KeysetCursors.test.ts, 12 tests, 6 distinct literals)

- Schema level (fixed id `018f0000-0000-7000-8000-000000000002`, T0+2 ms): one literal shared by `AdminApi.UserCursorSchema` and `AdminTenantsApi.OrganizationCursorSchema`, one for `AdminApi.CursorSchema`.
- Users (memory and SQL): limit 2 walks [1,2] [3,4] [5] with the `…001Z/…0002` and `…005Z/…0004` cursors; limit 4 and limit 5 (exactly full, no cursor) pinned too.
- Impersonations (memory and SQL): the seeded generator mints the seven research ids in order; limit 3 walks the three research pages with the two startedAt literals.
- Organizations (memory and SQL records, through `AdminTenants.listOrganizations`): pages of 3, 3, 1; wire cursors equal to the independent derivation from the last kept item; the walk equals the (createdAt, code unit id) sort.
- Every literal: equals the `Buffer` base64url derivation, 112 characters, no `=`, first key `createdAt`/`startedAt`, second key `id`.
- Mutation check: one character changed in the users `…005Z/…0004` literal made 4 cases fail; reverted, 12 pass.

All literals matched today's code on the first run; none was edited to fit.

## Task Commits

1. **Task 1: gate baseline and structural keyset baselines** - `809e1370` (docs)
2. **Task 2: KEY-04 golden cursor test and Wave 0 golden note** - `667e9918` (test)

## Deviations from Plan

None - plan executed exactly as written. Two small judgement calls inside the plan's latitude: tuple tables in the test are typed constants rather than `as` casts (the no-`as` rule), and the phase allowlist line in the comparison rule uses the exact regex content from 03-09-PLAN.md.

## Issues Encountered

- The worktree guard rejects chained or complex git commands; they were issued plainly.
- The first `tsc` run flagged a generic `R` on the organization case helper (`it.effect` needs `R = never`); fixed by typing the layer as `Layer.Layer<..., unknown>`.

## Known Stubs

None.

## Threat Flags

None. 03-BASELINE.md holds gate summaries, knip file lists, `git status --short`, `git diff --stat knip.json`, grep lines and the first docker status line only (T-03-01); the golden literals match the research capture, are cross-checked by independent derivation, and a mutation was seen to fail (T-03-02). No package installed (T-03-SC).

## Next Phase Readiness

Plan 03-02 can start: baseline and golden are committed and green on untouched src. `git diff e74a8a9a HEAD` over `packages/{ports,sql,core,admin,organization,test}/src`, `spec`, `features` and `.changeset` is empty. Postgres legs remain CI-only.

## Self-Check: PASSED

- FOUND: .planning/phases/03-keyset-page-module/03-BASELINE.md, packages/admin/test/KeysetCursors.test.ts
- FOUND commits 809e1370, 667e9918
