---
phase: 03-keyset-page-module
plan: 09
subsystem: testing
tags: [keyset, phase-close, gate-comparison, allowlist, key-07, open-ci-confirmations]

requires:
  - phase: 03-keyset-page-module
    provides: 03-01 baseline and golden, 03-02 pins, 03-03..03-07 Keyset/KeysetSql and the three adopters, 03-08 spec and changeset
provides:
  - Structural close evidence (allowlist, KEY-07 empty diff, KEY-06 grep, increment and seek census, oracle integrity)
  - Gate-by-gate comparison against 03-BASELINE.md (no regression; counts only grew)
  - The Postgres confirmations CI still owes, listed as open items
affects: []

actuals:
  tokens: 6000
  tasks: 2
  commits: 0

tech-stack:
  added: []
  patterns:
    - "Phase close as read-only checks run from a script, output pasted verbatim, no source edit"

key-files:
  created:
    - .planning/phases/03-keyset-page-module/03-09-SUMMARY.md
  modified: []

key-decisions:
  - "Postgres confirmations recorded as open CI items, never passes; GATE-04's 'record not run locally' is satisfied by this record while the CI pass remains outstanding"
  - "requirements.mark-complete not run; the orchestrator decides requirement states at phase close"

requirements-completed: []

duration: 25min
completed: 2026-11-14
status: complete
commits: 0
plan_head_before: 76cfa0b5645486c03c528ad6d2b393a825af4313
plan_head_after: 76cfa0b5645486c03c528ad6d2b393a825af4313
---

# Phase 3 Plan 09: Phase close Summary

**Every local gate matches or improves on the Wave 0 baseline (files 411 to 417, tests 6491 to 6593, coverage up on all four axes), the phase diff stays inside its allowlist with the KEY-07 paths untouched, the clamp copies and hand-written seeks are gone, and every Postgres confirmation is listed as an open CI item rather than a pass.**

No source file changed in this plan. `git rev-list --count 76cfa0b5..HEAD` at SUMMARY time is 0 (verification only), so `commits: 0` is the measured, legitimate docs-only value; the plan metadata commit follows this file.

## Structural close

Phase base `e74a8a9a`, HEAD at the start of this plan `76cfa0b5`. Precondition held: `git status --short -- packages spec features .changeset` printed nothing. Commands were run from one script (outputs below are verbatim; `wc` leading spaces trimmed).

| # | Command (abbreviated) | Output | Expected | Verdict |
|---|---|---|---|---|
| 1 | `git diff --name-only e74a8a9a HEAD \| grep -cvE '<allowlist regex of the plan>'` | `0` (49 paths changed in total) | 0 | pass |
| 2 | `git diff --quiet e74a8a9a HEAD -- knip.json` | exit `0` | 0 | pass |
| 3 | `git diff --name-only --diff-filter=A e74a8a9a HEAD \| grep -cE '\.(cjs\|mjs)$'` | `0` | 0 | pass |
| 4 | `git diff --stat e74a8a9a HEAD -- <the 13 KEY-07 paths>` | (empty, 0 lines) | empty | pass |
| 5 | `grep -rEn 'pageLimit\|listLimit\|MAX_PAGE_SIZE\|DEFAULT_PAGE_SIZE\|MAX_LIST_LIMIT\|DEFAULT_LIST_LIMIT' packages/{core,admin,organization,ports,sql}/src` | 0 lines (16 at the base) | 0 | pass |
| 6 | `grep -n 'MAX_PAGE_SIZE\|DEFAULT_PAGE' packages/webhooks/src/WebhooksApi.ts packages/webhooks/src/Webhooks.ts` | the four baseline lines, unchanged (below) | present, intentional | pass |
| 7 | non-comment `limit + 1` over the six listing files | `0` (5 at the base) | 0 | pass |
| 8 | non-comment `+ 1` in `packages/ports/src/Keyset.ts`, counted by match | `1` (the file exists) | 1 | pass |
| 9 | expanded-OR and hand-spelled keyset `ORDER BY` over UserStoreSql, ImpersonationRecords, OrganizationRecords | `0` (5 at the base) | 0 | pass |
| 10 | `Keyset.paginate` over the four adapter files; `KeysetSql.make` over the three SQL adapters | `12` and `3` | >=6 and >=3 | pass (see note) |
| 11 | golden: `grep -oE 'eyJ[A-Za-z0-9_-]{100,}' KeysetCursors.test.ts \| sort -u \| wc -l`; removed lines since its add commit `667e9918` | `8`; `0` removed (`84 insertions(+)`, 0 deletions) | 8; 0 | pass |
| 12 | `git diff --quiet <add commit> HEAD` for KeysetPins.test.ts (`d04d6d62`) and KeysetHttp.test.ts (`ba8bdc15`) | exit `0` and exit `0` | 0 | pass |
| 13 | `npx tsc -b tsconfig.json && npx vitest run KeysetCursors KeysetPins KeysetHttp` | tsc exit 0; Test Files 3 passed (3), Tests 36 passed (36) | green | pass |

Row 6 verbatim (the webhooks survivor, outside the scoped trees by decision; deliveries keep their own clamp):

```text
packages/webhooks/src/WebhooksApi.ts:138:export const MAX_PAGE_SIZE = 200;
packages/webhooks/src/WebhooksApi.ts:146:      Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
packages/webhooks/src/Webhooks.ts:183:const DEFAULT_PAGE = 50;
packages/webhooks/src/Webhooks.ts:760:            limit: query.limit ?? DEFAULT_PAGE,
```

Note on row 10: the plan's census says "6 times" and its verify asserts `>= 6`. The raw `grep -c` counts 12 because six matches are comments naming `Keyset.paginate`; the six code call sites are `UserStore.ts:377`, `UserStoreSql.ts:488`, `OrganizationRecords.ts:245` and `:450`, `ImpersonationRecords.ts:440` and `:753`. `KeysetSql.make` is 3 (one per SQL adapter).

Oracle disclosure (T-03-16):

- Wave 0 oracle files: `KeysetCursors.test.ts` was edited once after 03-01, by `b5bc1360` (03-06), and only by appending: the two `ORG_N1`/`ORG_N2` records-level literals, the organization records layers and the two organization cases (84 insertions, 0 deletions; 6 literals became 8). The six original literals and the two schema pins were never edited. `KeysetPins.test.ts` and `KeysetHttp.test.ts` are byte-unchanged since the commits that added them.
- KEY-07: the empty `git diff --stat` above covers `MembershipRecords.ts`, `Organization.ts`, `OrganizationHandlers.ts`, `OrganizationApi.ts`, `SessionStore.ts`, `AccountStore.ts`, `AuditLogStore.ts`, `SessionStoreSql.ts`, `AuditLogStoreSql.ts`, `RelayCursorStoreSql.ts`, `packages/scim`, `packages/webhooks`, `packages/saml`. Membership offset paging stays by decision (KEY-F1 deferred).
- One port-visible contract change: the `UserStore.listPage` page field `next` became `nextCursor`, `listPage` takes a `Keyset.Request`, and `UserStore.byCreation` is replaced by `UserStore.pageOrder` with `Keyset.window`. It is declared in `.changeset/keyset-page-module.md` (six packages `minor`) with its `Migration:` paragraph (03-08).

## Gate comparison

Run from the worktree root in the plan's order, each as its own command, output kept outside the repo. Baseline is `03-BASELINE.md`.

| Gate | Baseline | Phase close | Verdict |
|---|---|---|---|
| `npx tsc -b tsconfig.json` | 0, no output | 0, no output | match |
| `npx tsc -p tsconfig.test.json` | 0, 0 `error TS`, 2 pre-existing `warning TS377149` | 0, 0 `error TS`, the same 2 `warning TS377149` (`TestingHarnessSteps.ts` 851, 853) | match |
| `pnpm circular` | 0, no findings | 0, no findings | match |
| `pnpm check:error-tags` | 0, 163 internal / 137 wire, none shared | 0, 163 internal / 137 wire, none shared | identical |
| `pnpm check:transactions` | 0 | 0 | match |
| `pnpm check:contract-tests` | 0, all 21 plugin classes | 0, all 21 plugin classes; `@awthaq/test` stays dev-only | identical |
| `pnpm lint` | 0, warnings only (87 under `.claude/`, 7 in `RequestContextSteps.ts`) | 0, same 87 and 7, 0 lines under `packages/` | match |
| `pnpm format:check` | 0, 1210 files | 0, 1218 files | match (+8 files, the new Keyset modules and tests) |
| `pnpm check:readmes` | 0 | 0 | match |
| `pnpm workspace:check` | 0, 29 packages and 3 examples | 0, 29 packages and 3 examples | match |
| `pnpm test:bdd` | 0, 39 files; 1576 passed, 44 skipped (1620) | 0, 39 files; 1576 passed, 44 skipped (1620) | match |
| `pnpm test` | 0, 411 passed + 4 skipped (415); 6491 passed, 1 expected fail, 15 skipped (6507) | run 1 exit 1 (known passkey intermittent only, below); run 2 exit 0, 417 passed + 4 skipped (421); 6593 passed, 1 expected fail, 15 skipped (6609) | match, +6 files +102 tests |
| `pnpm coverage` | 0, 91.66 / 85.08 / 86.93 / 92.18 (floors 89 / 83 / 84 / 90) | 0, 91.71 / 85.21 / 86.97 / 92.24; 417 + 4 skipped files, 6593 passed, 1 expected fail, 15 skipped | match, above floors, up on all four |
| `pnpm spec:verify:strict` | 0, PASS 32 FAIL 0 | 0, `PASS: 32   FAIL: 0   SKIP: 0` | match |
| `pnpm knip` (filtered) | 1 (pre-existing): banner, `Unused files (39)` all under `.claude/`, `Unlisted dependencies (3)`, three `readme-quickstart.ts` rows | 1 (pre-existing): the same banner, 39 `.claude/` rows, the three `readme-quickstart.ts` rows (`@awthaq/core`, `@awthaq/password`, `@awthaq/server`); residue under packages/examples/features/scripts/spec beyond the three = 0 | match |
| StoreContract, 5 modes | 0, 5 files, 457 tests | 0, 5 files, 491 tests | match, +34 (KEY-05 page-order cases, 5 modes) |
| records contracts (admin, organization) | 0, 2 files, 641 tests | 0, 2 files, 651 tests | match, +10 (new impersonation and organization cases) |
| listing domain and HTTP | 0, 5 files, 79 tests | 0, 5 files, 79 tests | match |
| SQL adapters (`UserStoreSql`, `CoreStoresSql`) | 0, 2 files, 14 tests | 0, 2 files, 14 tests | match |
| new pins (`Keyset.test.ts`, `Keyset.types.test.ts`, `KeysetSql.test.ts`) | n/a | 0, 3 files, 22 tests | pass |
| `pnpm clean`, `pnpm build` | n/a | 0, 0 | pass |
| `pnpm package:smoke` | 0, 30 PASS | 0, 30 `package:smoke: PASS`, 0 other lines besides the npm env-config warnings | match |
| `git diff --stat knip.json`, working tree | empty; only untracked `.claude/**` and `.planning/state.json` | empty; the same untracked entries only | match |

Count deltas explained: the six new test files are `Keyset.test.ts`, `Keyset.types.test.ts` (ports), `KeysetSql.test.ts` (sql), `KeysetCursors.test.ts`, `KeysetPins.test.ts`, `KeysetHttp.test.ts` (admin) = 6 files and 22 + 14 + 18 + 4 = 58 tests, plus 34 StoreContract cases and 10 records-contract cases inside existing files = 102 tests. 411 + 6 = 417 files, 6491 + 102 = 6593 tests exactly. Skipped counts unchanged (15 unit, 44 bdd). No file or test disappeared.
Known intermittent: the first `pnpm test` run failed in `packages/passkey/test/Contract.test.ts` > `RecordsContract: passkey` > `ChallengeStore (memory)` > `consume [atomic]: false for any other value, a tampered one included` (`AssertionError: expected true to be false` at `contract/ChallengeStore.ts:101`), with `1 failed | 416 passed | 4 skipped (421)` and `1 failed | 6592 passed`. It was the only failure, in a file outside this phase's allowlist. Re-run once per the baseline rule: exit 0, `417 passed | 4 skipped (421)`, `6593 passed | 1 expected fail | 15 skipped`. `pnpm coverage` and `pnpm test:bdd` were green the first time. Both runs recorded; cause still not investigated (out of scope).

## Open CI confirmations (not run locally)

Postgres was not available: the docker daemon is down and `AWTHAQ_POSTGRES_URL` is unset, as at the Wave 0 capture (03-BASELINE.md "Postgres"). Postgres-gated cases are skipped inside the counts above; the SQL legs ran on SQLite `:memory:`. GATE-04's "record not run locally" is satisfied by this record; the CI pass itself remains outstanding. The items below are open and must not be counted as passes by the phase verification:

- [ ] (1) CI `pnpm check` on the phase head with `AWTHAQ_POSTGRES_URL` against the `postgres:16` service (`.github/workflows/check.yml`) is green.
- [ ] (2) The users `StoreContract` KEY-05 cases on Postgres: the mixed-case self-consistency case, the canonical uuidV7 exact-parity case, the sub-millisecond tie case and the whole-millisecond SQL cases (03-05).
- [ ] (3) The admin and organization `RecordsContract` sql mode on Postgres: the `KeysetSql` row-value seek binding a `Date` against `timestamptz` (03-RESEARCH.md A4), descending order with the tenant and active predicates, ceil page counts, and the replayed cross-tenant cursor (03-06, 03-07).
- [ ] (4) `packages/sql/test/KeysetSql.test.ts` on Postgres: the `$n` placeholders and the agreement sweep (03-04).
- [ ] (5) The golden's SQL legs on Postgres: users, impersonations and organizations, both through TestAuth SQL records and at the records level (`TestSql.layer` under `AWTHAQ_POSTGRES_URL`; 03-01, 03-05, 03-06, 03-07).
- [ ] (6) The collation rule: if the canonical-id parity case fails on Postgres, that is the drift BEH-EA-036 names; the fallback is `COLLATE "C"` on the id columns (`admin_impersonation` needs an index migration) and it is a follow-up, never a test edit. Local `pnpm test:pg` (`scripts/test-pg.sh`) runs `postgres:16-alpine`, whose C-like collation hides the drift; only CI's Debian `postgres:16` (glibc `en_US.utf8`) reproduces it (03-RESEARCH.md A3).

## Task Commits

1. **Task 1: structural phase close** - no source commit (read-only checks), recorded in "Structural close".
2. **Task 2: gate comparison and open CI confirmations** - no source commit (read-only gate runs), recorded in "Gate comparison" and "Open CI confirmations".

The plan metadata commit follows this SUMMARY.

## Deviations from Plan

None - plan executed exactly as written. Process notes: the checks ran from two scripts kept in the scratchpad (outside the repo); the plan-head ledger for 0c is `76cfa0b5` (HEAD at start); one stray scratch file written outside the scratchpad was removed immediately and never touched the repo.

## Issues Encountered

The known passkey ChallengeStore intermittent (above), one recorded re-run, green.

## Known Stubs

None. This plan wrote no code; a scan of the files 03-03..03-08 changed is covered by their own summaries.

## Threat Flags

None. T-03-16 mitigated: allowlist residue 0, KEY-07 diff empty, `knip.json` unchanged, golden append-only, pin files unchanged since added, every gate compared with the baseline, Postgres listed as open CI items. T-03-SC accepted: no package installed or bumped; clean build and `package:smoke` confirm the published shape.

## Self-Check: PASSED

- FOUND: `.planning/phases/03-keyset-page-module/03-09-SUMMARY.md` (sections "Structural close", "Gate comparison", "Open CI confirmations (not run locally)")
- FOUND: `packages/ports/src/Keyset.ts`, `packages/admin/test/KeysetCursors.test.ts`, `packages/admin/test/KeysetPins.test.ts`, `packages/admin/test/KeysetHttp.test.ts`
- FOUND commits `667e9918`, `d04d6d62`, `ba8bdc15`, `b5bc1360`, `41ad11f1` in the history of HEAD
