---
phase: 03-keyset-page-module
plan: 06
subsystem: organization, admin
tags: [keyset, pagination, organizations, records-contract, golden]
requires:
  - phase: 03-keyset-page-module
    provides: 03-03 Keyset module, 03-04 KeysetSql, 03-05 users adoption, 03-01/03-02 golden and pins (the oracle)
provides:
  - "OrganizationRecords.listPage over Keyset.Request / Keyset.Page, one declaration (pageOrder) for memory and SQL"
  - "OrganizationDirectory.listPage passes the page through; OrganizationCursor / OrganizationPage types live there"
  - "AdminTenants.listOrganizations = gate.collection then directory page, no clamp, increment or trim"
  - "Organization RecordsContract: exactly-full page and normalised-limit cases, ceil(7 / limit) page sweep"
  - "Golden append: records-level ORG_N1 / ORG_N2 on memory and SQL"
affects: [03-07, 03-08, 03-09]
actuals:
  tokens: 12000
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - "A records store owns its page: module-level pageOrder declaration, memory = paginate over window, SQL = paginate over KeysetSql.make(pageOrder); callers pass the request through"
key-files:
  created: []
  modified:
    - packages/organization/src/OrganizationRecords.ts
    - packages/organization/src/OrganizationDirectory.ts
    - packages/admin/src/AdminTenants.ts
    - packages/organization/test/contract/OrganizationRecords.ts
    - packages/admin/test/KeysetCursors.test.ts
key-decisions:
  - "OrganizationCursor is defined in OrganizationRecords and aliased by OrganizationDirectory and AdminTenants (names kept at every reader)"
  - "The post-page admin gate stays in the caller: gate.collection is still the first statement of listOrganizations"
requirements-completed: []
duration: 25min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: 9922327457281c649e6db8f7c44b07b1b21c0666
plan_head_after: b5bc1360d351e210b241a4877d37963f24b6c943
---

# Phase 3 Plan 06: Organizations adopt Keyset Summary

**Organizations page through one declaration (`pageOrder`) and one `Keyset.paginate` per adapter, with `limit + 1` applied once inside the store, the directory passing the page through, AdminTenants reduced to its gate, and cursor bytes unchanged (golden, pins and HTTP pins green unedited).**

KEY-02, KEY-03, KEY-04, KEY-05 and KEY-06 work for organizations is delivered here. No requirement is ticked by this plan (the orchestrator marks them at phase close); `requirements.mark-complete` was not run.

## Accomplishments

- Task 1 (one atomic commit, four files): `OrganizationRecords` gains `OrganizationCursor`, a module-level `pageOrder` (createdAt asc via `DateTime.Order`, id asc via `Order.String`) and a module-level `seek = KeysetSql.make(pageOrder)`. Memory `listPage` is `Keyset.paginate` over `Keyset.window` (inline sort/filter and `toEpochMillis` deleted); SQL `listPage` is one `SELECT ... WHERE <sql.and of the optional seek> ORDER BY <seek.orderBy> LIMIT take` inside `Keyset.paginate`, still behind `TenantScoped.liftOn(sql, grant)` and `unavailable("listPage")` (the row-value literal and the hand-spelled ORDER BY are gone). `OrganizationDirectory.listPage` takes `Keyset.Request` and answers the page; `AdminTenants.listOrganizations` is `gate.collection` then `directory.listPage({ after, limit: input?.limit })`, and its now-unused `ImpersonationRecords` import is removed. The contract's crossTenant probe, read case and tie sweep follow the page (`items`, `nextCursor`, every non-final page holds exactly `limit`, `pages === Math.ceil(7 / limit)`).
- Task 2: two RecordsContract read cases (exactly-full final page with and without a following row; limits 0, -3, 2.5, NaN, 10_000 giving (1,true), (1,true), (2,true), (3,false), (3,false)), and an appended "organizations, records level" describe in the golden: the seven seeded ids equal the research list and the limit-3 walk gives [a,b,c] + ORG_N1, [d,e,f] + ORG_N2, [g] + None on `layerMemory` and `layerSql` (each literal also checked against the independent base64url derivation).

## Task Commits

1. **Task 1: organizations adopt Keyset atomically** - `de923576` (feat)
2. **Task 2: organization contract cases and ORG_N1/ORG_N2 golden append** - `b5bc1360` (test)

## Gate results

| Gate | Result |
|---|---|
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` (after each task) | no `error TS` (two pre-existing TS377149 warnings in TestingHarnessSteps.ts) |
| Task 1 vitest list (KeysetCursors, KeysetPins, KeysetHttp unedited; AdminTenants, organization Contract, OrganizationDirectory, OrganizationConnections) | 7 files, 595 tests passed |
| `pnpm test:bdd` | 39 files passed; 1576 passed, 44 skipped (baseline counts) |
| Task 2: organization Contract + KeysetCursors | 2 files, 542 tests passed; both records-level legs (memory, sql) listed as run |
| distinct `eyJ...` literals in KeysetCursors.test.ts | 8 (6 after 03-01) |
| golden append-only guard (`git diff <add commit>` removed lines) | 0 |
| non-comment `limit + 1` / `pageLimit` / `.slice(` in AdminTenants.ts | 0 (was 3) |
| `("createdAt", id) >` / `ORDER BY "createdAt"` in OrganizationRecords.ts | 0 (was 3) |
| `toEpochMillis` in OrganizationRecords.ts | 0 (was 3) |
| `gate.collection(caller, "listOrganizations")` in AdminTenants.ts | 1 (guard) |
| `Math.floor(7 / limit) + 1` in the contract | 0 (was 1); `Math.ceil(7 / limit)` 1 |
| `Keyset.paginate` / `KeysetSql.make` in OrganizationRecords.ts | 4 (two calls plus doc mentions) / 1 |
| `pnpm circular`, `pnpm format:check`, `pnpm check:contract-tests` | exit 0 / all matched files correct / `all 21 plugin classes run the contract suite` |
| `pnpm lint` | no finding under `packages/`; warnings only in `.claude/` and pre-existing `features/step-definitions` |
| `as` / `any` added | 0 |

**KEY-06 grep after this plan** (the baseline command over core, admin, organization, ports, sql): 9 lines (was 10 after 03-05, 16 baseline): `ImpersonationRecords.ts` 7 and `AdminApi.ts` 2, owned by 03-07. Remaining non-comment `limit + 1` sites: `ImpersonationRecords.ts:466,702` (plus the `Keyset.ts` paginate site; `RateLimiter.ts:206` is unrelated).

**Postgres: not run locally** (docker daemon down, `AWTHAQ_POSTGRES_URL` unset). For CI under `AWTHAQ_POSTGRES_URL`: the organization RecordsContract `listPage` cases (including the two new ones) in sql mode, and the golden's `organizations, records level (sql)` leg on Postgres (mixed-case ids self-consistent only; exact code-unit order only for canonical uuidV7 ids). Open CI confirmations, not passes.

## Deviations from Plan

None - plan executed exactly as written. Notes that are not deviations:

- `ImpersonationRecords` import in AdminTenants.ts became unused (tsc TS6133) and was removed in Task 1, as the plan anticipated.
- The golden gained two import lines (`@awthaq/organization/records`, `TenantScoped` from `@awthaq/sql`); additions only, no existing line touched.
- As in earlier plans, no per-plan head-ledger file exists in the linked worktree's git dir; `plan_head_before` is the start-of-run HEAD `99223274` and `commits: 2` was measured with `git rev-list --count 99223274..HEAD`.

## Known Stubs

None.

## Threat Flags

None. T-03-11 (cross-tenant read): `gate.collection` is still the first statement, the read stays behind the `CrossTenant` witness and `TenantScoped.liftOn`, KeysetHttp 403 pin and AdminTenants tests green. T-03-12 (increment twice or never): AdminTenants lost the increment and trim in the same commit the store gained `paginate`; the sweep asserts full non-final pages and `ceil(7 / limit)` pages, the exactly-full case asserts no cursor, and the 50/200 pins stayed green unedited.

## Next Phase Readiness

03-07 repeats the pattern for impersonations (the remaining KEY-06 grep lines and the last two hand-written `limit + 1` sites).

## Self-Check: PASSED

- FOUND: the five modified files, working tree clean of tracked changes after commit
- FOUND commits de923576, b5bc1360 (ancestors of HEAD)
