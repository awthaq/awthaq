---
plan: 40-residue
ticket: 12
title: "Impersonation and organization listings normalise limit like Users.list"
type: tdd
wave: 0
depends_on: [11]
files_modified:
  - packages/admin/src/ImpersonationRecords.ts
  - packages/admin/src/AdminTenants.ts
  - packages/admin/test/contract/ImpersonationRecords.ts
  - packages/admin/test/AdminTenants.test.ts
  - .changeset/admin-listing-limit.md
autonomous: true
requirements: [REQ-EA-1614]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "ImpersonationRecords.list on memory and SQL, and AdminTenants.listOrganizations, normalise limit: truncated, clamped to 1..200, 50 when absent or non-finite"
    - "limit 0 answers one item and a cursor when more rows exist; 2.5 answers two; -3 answers one; NaN answers up to 50; 10_000 answers at most 200 — identically on memory and SQL"
    - "No adapter ever issues LIMIT with a negative or fractional value"
  artifacts:
    - path: packages/admin/src/ImpersonationRecords.ts
      provides: "one pageLimit rule used by both adapters"
  key_links:
    - from: packages/admin/src/ImpersonationRecords.ts
      to: packages/admin/src/AdminApi.ts
      via: "MAX_PAGE_SIZE (200) is the clamp"
      pattern: "MAX_PAGE_SIZE"
---
Status: ready-for-agent
Blocked by: 11 (shares the impersonation contract file and AdminTenants.test.ts)

<objective>
Fix B-F1 and B-F2 (PLAN §2.B.3): two listings take an in-process `limit` unvalidated.
Purpose: the interface says "never loads more than `limit + 1` rows" (`ImpersonationRecords.ts:156`) and `UserStore` says "the domain validates it"; `Users.list` does (`Users.ts:558-561`), these two do not. Wave 0: it does not depend on the module.
Output: one limit rule per package, red tests first.
</objective>

<context>
@packages/admin/src/ImpersonationRecords.ts (:107 DEFAULT_PAGE_SIZE, :150-165 interface, :446-460 memory list, :675-696 listQuery, :760-776 SQL list)
@packages/admin/src/AdminTenants.ts (:168 DEFAULT_PAGE_SIZE, :195-212)
@packages/admin/src/AdminApi.ts (:160 MAX_PAGE_SIZE)
@packages/core/src/Users.ts (:556-561 listLimit, the rule to copy)
</context>

<tasks>
  <task type="tdd">
    <name>Task 1: red limit cases</name>
    <files>packages/admin/test/contract/ImpersonationRecords.ts, packages/admin/test/AdminTenants.test.ts</files>
    <read_first>the list cases added by ticket 11</read_first>
    <behavior>
      - Impersonation contract (memory and SQL): seed 3 rows; list({ limit: 0 }) → 1 item, cursor Some; list({ limit: -3 }) → 1 item; list({ limit: 2.5 }) → 2 items, cursor Some; list({ limit: Number.NaN }) → 3 items, cursor None; list({ limit: 10_000 }) → 3 items, cursor None.
      - AdminTenants (memory): same five cases through listOrganizations with 3 organizations.
    </behavior>
    <action>Add one contract `read` case "ESS-006: an in-process limit is normalised like Users.list" and one AdminTenants case with the table above. Run: limit 0 fails on both adapters (empty page, no cursor), 2.5 fails on SQL (`Schema.Int` request), -3 fails on SQL. These are the red tests; commit them together with task 2 so the tree is never red.</action>
    <verify><automated>npx vitest run packages/admin/test/Contract.test.ts packages/admin/test/AdminTenants.test.ts 2>&1 | tail -5   # RED before task 2</automated></verify>
    <done>Red cases written.</done>
  </task>
  <task type="auto">
    <name>Task 2: the limit rule</name>
    <files>packages/admin/src/ImpersonationRecords.ts, packages/admin/src/AdminTenants.ts, .changeset/admin-listing-limit.md</files>
    <read_first>packages/core/src/Users.ts:556-561</read_first>
    <action>In ImpersonationRecords.ts add a module-level `pageLimit = (limit: number | undefined): number` with Users.list's rule (undefined or non-finite → DEFAULT_PAGE_SIZE; otherwise `Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE)`), importing `MAX_PAGE_SIZE` from `./AdminApi.ts` (if that import makes `pnpm circular` fail, declare `const MAX_PAGE_SIZE = 200` locally with a one-line comment naming AdminApi's constant). Use it at :451 and :761 in place of `input?.limit ?? DEFAULT_PAGE_SIZE`. In AdminTenants.ts use the same rule at :198 (local helper, same import rule). Changeset: `"@awthaq/admin": patch`; body: in-process `limit` outside 1..200 is normalised instead of answering an empty page or a store failure; `Migration: none.`</action>
    <verify><automated>npx vitest run packages/admin/test/Contract.test.ts packages/admin/test/AdminTenants.test.ts && pnpm circular</automated></verify>
    <acceptance_criteria>`rg -n 'input\?\.limit \?\? DEFAULT_PAGE_SIZE' packages/admin/src` prints nothing (baseline 3: ImpersonationRecords.ts:451, :761, AdminTenants.ts:198).</acceptance_criteria>
    <done>Limit cases green on memory and SQLite; `pnpm test:pg` green.</done>
  </task>
</tasks>

<threat_model>
## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-14 | Denial of service | SQLite reading a negative LIMIT as unbounded (`ImpersonationRecords.list`) | low | mitigate | clamp to 1..200 before the statement; in-process only (the wire bounds 1..200 already) |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:pg</verification>

<success_criteria>B-F1, B-F2 closed: five limit cases green on both adapters; 3 unvalidated sites → 0.</success_criteria>

## Comments
