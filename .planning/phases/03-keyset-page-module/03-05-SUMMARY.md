---
phase: 03-keyset-page-module
plan: 05
subsystem: ports, sql, core
tags: [keyset, pagination, users, store-contract, rename]
requires:
  - phase: 03-keyset-page-module
    provides: 03-03 Keyset module, 03-04 KeysetSql, 03-01/03-02 golden and pins (the oracle)
provides:
  - "UserStore.pageOrder (one declared order) and UserStore.listPage over Keyset.Request / Keyset.Page"
  - "UserStoreSql users page from KeysetSql.make(UserStore.pageOrder) through Keyset.paginate"
  - "Users.list with no clamp of its own; page field nextCursor at every reader"
  - "7 KEY-05 users StoreContract cases (6 on every runner, 1 SQL-only)"
affects: [03-06, 03-07, 03-08, 03-09]
actuals:
  tokens: 14000
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - "A store port's listing takes Keyset.Request and answers Keyset.Page; the adapter supplies only a fetch of `take` rows after the cursor"
key-files:
  created: []
  modified:
    - packages/ports/src/UserStore.ts
    - packages/sql/src/UserStoreSql.ts
    - packages/core/src/Users.ts
    - packages/test/src/internal/storeContract/users.ts
    - packages/sql/test/CoreStoresSql.test.ts
    - features/step-definitions/PersistenceMigrationSteps.ts
key-decisions:
  - "Users.UserCursor and Users.UsersPage kept as names, now aliases of UserStore.UserCursor and Keyset.Page<UserRecord, UserCursor>"
  - "The usersPage request field is `take`; its execute is one template using sql.and over an optional seek, so the two-template branch is gone"
requirements-completed: []
duration: 20min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 095379d356e9223fdbec709e4231ff3ccb03bbf4
plan_head_after: f1dedb8b3d56124f386a80c6b1d2a45ceee9270a
---

# Phase 3 Plan 05: Users adopt Keyset Summary

**Users page through one declaration (`UserStore.pageOrder`), one `Keyset.paginate` and one page contract on memory and SQL, with cursor bytes unchanged (golden green), core's clamp deleted, and the page field renamed `nextCursor` everywhere; the users StoreContract suite gains the KEY-05 page-order cases.**

KEY-02, KEY-03, KEY-05 and KEY-06 work for users is delivered here. No requirement is ticked by this plan (the orchestrator marks them at phase close); `requirements.mark-complete` was not run.

## Accomplishments

- Task 1 (one atomic commit, six files): `UserStore.pageOrder` (createdAt asc via `DateTime.Order`, id asc via `Order.String`, `cursorOf`) replaces the old `byCreation` comparator; memory `listPage` is `Keyset.paginate` over `Keyset.window`; `UserStoreSql` has a module-level `KeysetSql.make(UserStore.pageOrder)`, one `SELECT ... WHERE <sql.and of the optional seek> ORDER BY <seek.orderBy> LIMIT take`, and a `listPage` that is `Keyset.paginate` plus `traced`/`read` with no slice or cursor derivation of its own; `Users.list` passes `{ after, limit: input?.limit }` and maps `page.nextCursor`; the default constant, the maximum constant and the clamp helper are deleted.
- Rename `next` to `nextCursor` at the 12 readers (users StoreContract case, CoreStoresSql.test.ts, PersistenceMigrationSteps.ts). `IdentityColumns.next` (UserStore.ts) untouched; PersistenceTypeGates.ts still fails to compile the offset call (no TS2578).
- Task 2: `newUser` gains an optional exact `createdAt`; seven cases under `listPage` and the SQL-only whole-millisecond case. Expected orders are computed in the cases from local code-unit comparison, not from `pageOrder`.

## Task Commits

1. **Task 1: users adopt Keyset atomically** - `9291135f` (feat)
2. **Task 2: KEY-05 page-order cases in the users StoreContract suite** - `f1dedb8b` (test)

## Gate results

| Gate | Result |
|---|---|
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` (after each task) | no `error TS` |
| Task 1 vitest list (KeysetCursors, KeysetPins, KeysetHttp unedited; five StoreContract runners; Users, UserStoreSql, CoreStoresSql, Admin, AdminUsers) | 13 files, 562 tests passed |
| `pnpm test:bdd` | 39 files passed; 1576 passed, 44 skipped (baseline counts) |
| five StoreContract runners after Task 2 | 5 files, 491 tests passed (457 baseline + 34 new: 6 on memory, 7 on each of SQLite, file, libSQL, sealed) |
| `pnpm check:contract-tests` | `all 21 plugin classes run the contract suite` (baseline) |
| `pnpm check:error-tags` | 163 internal and 137 wire, none shared (baseline) |
| `pnpm circular`, `pnpm format:check` | exit 0 / all matched files correct |
| `pnpm lint` | no finding under `packages/` or `features/step-definitions/PersistenceMigrationSteps.ts` (warnings only in `.claude/`) |
| old page-field reads in the four reader files | 0 (was 12) |
| KEY-06 core clamp grep in Users.ts | 0 (was 6) |
| non-comment `limit + 1` in UserStoreSql.ts | 0 (was 2) |
| `OR ("createdAt"` / `ORDER BY "createdAt"` in UserStoreSql.ts | 0 (was 3) |
| `byCreation` in UserStore.ts | 0 (was 2) |
| `readonly next: IdentityColumns` in UserStore.ts | 1 (guard) |
| `as` / `any` outside comments and imports in the three source files | 0 |
| `pageOrder` in the users contract suite | 0 |

**KEY-06 grep after this plan** (the baseline command over core, admin, organization, ports, sql): 10 lines (was 16): `Users.ts` 6 removed; the remaining 10 are `ImpersonationRecords.ts` 7, `AdminApi.ts` 2, `AdminTenants.ts` 1, owned by 03-06 and 03-07. Remaining non-comment `limit + 1` sites: `AdminTenants.ts:202`, `ImpersonationRecords.ts:466,702` (plus the `Keyset.ts` paginate site).

**Postgres: not run locally** (docker daemon down, `AWTHAQ_POSTGRES_URL` unset). For CI under `AWTHAQ_POSTGRES_URL`: the six `listPage` cases through `StoreContract.sql` (mixed-case self-consistency; canonical ids in code-unit order on the Debian `en_US.utf8` image), the SQL-only `extract(microseconds ...) % 1000 = 0` whole-millisecond case, and the Date-against-timestamptz bind of the seek (RESEARCH A4). Open CI confirmations, not passes.

## Deviations from Plan

None - plan executed exactly as written. Notes that are not deviations:

- `sed -E '\b'` is a no-op on BSD sed; the rename was applied with `perl -pi` (same pattern), and `tsc -b` then compiled clean.
- As in 03-03 and 03-04 the linked worktree's git dir is under the other checkout, so no per-plan head ledger file was written; `plan_head_before` is the start-of-run HEAD `095379d3` and `commits: 2` was measured with `git rev-list --count 095379d3..HEAD`.
- The SQL-only case's two dialect queries alias different columns (`rest`, `stored`), and the assertion branches on which is present; it is not exercised on Postgres locally.
- The Postgres leg of the golden cursor test (KeysetCursors) also remains a CI confirmation (from 03-01).

## Known Stubs

None.

## Threat Flags

None. T-03-09 (clamp now only in the store): the normalised-limit case runs on every adapter and the KeysetPins 51/201/10_000 cases stayed green unedited. T-03-10 (skips or repeats): tie sweep, exactly-full page, mixed-case self-consistency and canonical-id parity pass on five runners; the golden proves cursor bytes unchanged.

## Next Phase Readiness

03-06 and 03-07 repeat the pattern for impersonations and organizations: `Keyset.Declaration` next to the port, `KeysetSql.make`, `Keyset.paginate`, delete the clamp and the hand-written `limit + 1`.

## Self-Check: PASSED

- FOUND: the six modified files, `git diff --stat` clean after commit
- FOUND commits 9291135f, f1dedb8b (ancestors of HEAD)
