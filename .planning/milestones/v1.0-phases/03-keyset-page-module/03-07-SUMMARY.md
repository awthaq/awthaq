---
phase: 03-keyset-page-module
plan: 07
subsystem: admin
tags: [keyset, pagination, impersonation, records-contract, descending-seek]
requires:
  - phase: 03-keyset-page-module
    provides: 03-03 Keyset module, 03-04 KeysetSql, 03-05/03-06 adoption shape, 03-01/03-02 golden and pins (the oracle)
provides:
  - "ImpersonationRecords.list over Keyset.paginate, one pageOrder declaration (startedAt desc, id desc) for memory and SQL"
  - "AdminApi.LimitSchema bounded by Keyset.MIN_LIMIT / Keyset.MAX_LIMIT"
  - "KEY-06 scoped grep at 0"
  - "Impersonation RecordsContract: active-filter paging, tenant-confined paging, replayed cross-tenant cursor"
affects: [03-08, 03-09]
actuals:
  tokens: 14000
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - "Descending keyset seek composes inside the same sql.and as the tenant predicate and the active filter"
key-files:
  created: []
  modified:
    - packages/admin/src/ImpersonationRecords.ts
    - packages/admin/src/AdminApi.ts
    - packages/admin/test/contract/ImpersonationRecords.ts
key-decisions:
  - "ImpersonationPage is now a type alias of Keyset.Page<ImpersonationRecord, ImpersonationCursor> (name kept; Admin.ts imports unchanged)"
  - "AdminApi imports @awthaq/ports for the Keyset bounds (no stratum problem reported by tsc or circular)"
requirements-completed: []
duration: 20min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 57e0c0076e0ba3e2b143626dfdd2cda20fcaf315
plan_head_after: 421a0568fe75eb29124c7513af3dae0e1a3672c2
---

# Phase 3 Plan 07: Impersonations adopt Keyset Summary

**Impersonation history pages through one declaration (`startedAt` desc / `id` desc) and one `Keyset.paginate` per adapter, the wire `limit` bound is the module's own constants, the last clamp copies are gone (KEY-06 scoped grep 0), and cursor bytes are unchanged (golden IMP_N1/IMP_N2, pins and HTTP pins green unedited).**

No requirement is ticked by this plan (`requirements.mark-complete` was not run; the orchestrator marks them at phase close).

## Accomplishments

- Task 1 (`d3c1583d`, two files): `ImpersonationRecords` gains a module-level `pageOrder` and `seek = KeysetSql.make(pageOrder)`. Memory `list` is `Keyset.paginate` over `Keyset.window` after the tenant and active filter; SQL `list` is `Keyset.paginate` over `listQuery`, whose conditions are `TenantScoped.predicate`, the active filter and `seek.after(...)` in one `sql.and`, ordered by `seek.orderBy`, `LIMIT take`. The exported default page-size constant, clamp helper, sort, cursor predicate, page builder and the `./AdminApi.ts` import were deleted. `AdminApi.LimitSchema` uses `Keyset.MIN_LIMIT`/`Keyset.MAX_LIMIT`; the exported wire page-size constant is gone.
- Task 2 (`421a0568`, one file): three `ESS-006` list cases in the impersonation RecordsContract (plus `walk` and `newestFirst` helpers computed locally): active-only paging across a startedAt tie at limits 1..4 (never an ended row, ceil(4/limit) pages), per-tenant paging at limits 1..4 for org-a and org-b (never a foreign row), and an org-a cursor replayed under org-b (only org-b rows after it, no cursor).

## Gate results

| Gate | Result |
|---|---|
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` (each task) | no `error TS` (pre-existing TS377149 warnings in TestingHarnessSteps.ts only) |
| Task 1 vitest list (KeysetCursors, KeysetPins, KeysetHttp unedited; Contract, Admin, AuthHttp, AdminTenants, AdminUsers) | 8 files, 199 tests passed |
| `pnpm test:bdd` | 39 files passed; 1576 passed, 44 skipped (baseline counts) |
| Task 2 admin Contract (memory and sql legs on SQLite) | 123 tests passed; 14 ESS-006 cases ran |
| `pnpm circular`, `pnpm format:check`, `pnpm check:error-tags` | exit 0 / correct format / 163 internal, 137 wire, none shared |
| `pnpm check:contract-tests` | `all 21 plugin classes run the contract suite` |
| `pnpm lint` | no finding under `packages/` (warnings only in `.claude/`, pre-existing) |
| scoped KEY-06 grep (core, admin, organization, ports, sql src) | 0 lines (16 baseline, 9 after 03-06) |
| non-comment `limit + 1` in ImpersonationRecords.ts | 0 (was 2) |
| `OR ("startedAt"` / `ORDER BY "startedAt"` | 0 (was 2) |
| `newestFirst\|isBeforeCursor\|toPage` in src | 0 (was 7) |
| `toEpochMillis(a\|b\|record\|cursor.startedAt)` in src | 0 (was 3) |
| `Keyset.(MIN\|MAX)_LIMIT` distinct in AdminApi.ts | 2 |
| `Keyset.paginate` in ImpersonationRecords.ts | 4 (two calls plus doc mentions) |
| `gate.visibleEpisodes` in Admin.ts | 1 (guard, post-page gate untouched) |
| contract file: `name: "ESS-006` / `withTenant("org-b")` / `active: true` | 7 / 13 / 2 (was 4 / 5 / 1) |
| `as` / `any` added | 0 (one `as const` removed before commit) |

**Postgres: not run locally** (docker daemon down, `AWTHAQ_POSTGRES_URL` unset); admin RecordsContract sql mode ran on SQLite. Open CI confirmations for `AWTHAQ_POSTGRES_URL`: the three new impersonation list cases and the golden's IMP_N1/IMP_N2 sql leg, including the Date-against-timestamptz bind in a descending seek (`startedAt < $cursor`). Mixed-case ids are self-consistent only; exact code-unit order only for canonical uuidV7 ids.

## Deviations from Plan

None - plan executed exactly as written. Notes that are not deviations:

- `packages/webhooks/src/WebhooksApi.ts` still carries its own `MAX_PAGE_SIZE`: an intentional survivor outside the five scoped trees.
- The git guard refused the chained ledger command (`git rev-parse HEAD > "$(git rev-parse --git-dir)/..."`), so no per-plan ledger file exists; `plan_head_before` is the start-of-run HEAD `57e0c007` and `commits: 2` was measured with `git rev-list --count 57e0c007..HEAD`.

## Known Stubs

None.

## Threat Flags

None. T-03-13 (tenant confinement under a replayed cursor): the seek sits inside one `sql.and` with the tenant predicate (no top-level OR), memory filters by tenant before windowing, and the new contract case proves an org-a cursor under org-b returns no org-a row (Postgres leg pending CI). T-03-14 (wire limit bound): LimitSchema references both Keyset bounds and the KeysetHttp/AuthHttp 400 pins pass unedited.

## Next Phase Readiness

All three listings (users, organizations, impersonations) page through Keyset; KEY-06's scoped grep is 0.

## Self-Check: PASSED

- FOUND: the three modified files, tracked tree clean after commits
- FOUND commits d3c1583d, 421a0568 (ancestors of HEAD)
