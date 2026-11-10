---
plan: 40-residue
ticket: 16
title: "Organization and impersonation listings and admin cursor schemas adopt Keyset (gate GO only)"
type: execute
wave: 3
depends_on: [13, 14]
files_modified:
  - packages/organization/src/OrganizationRecords.ts
  - packages/admin/src/ImpersonationRecords.ts
  - packages/admin/src/AdminTenants.ts
  - packages/admin/src/AdminApi.ts
  - packages/admin/src/AdminTenantsApi.ts
autonomous: true
requirements: [REQ-EA-1613]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "OrganizationRecords (memory, SQL), ImpersonationRecords (memory, SQL) and AdminTenants page through Keyset"
    - "The three admin cursor schemas are Keyset.cursor(...) and encode the same bytes"
    - "Tickets 11 and 12's cases stay green on memory, SQLite and Postgres"
  artifacts:
    - path: packages/admin/src/ImpersonationRecords.ts
      provides: "newestFirst/isBeforeCursor/toPage/pageLimit replaced by one Keyset order"
  key_links:
    - from: packages/admin/src/AdminApi.ts
      to: packages/ports/src/Keyset.ts
      via: "CursorSchema = Keyset.cursor(Schema.Struct({ startedAt, id }))"
      pattern: "Keyset\\.cursor"
---
Status: ready-for-human
Blocked by: 13, 14 (and the Part B gate)

<objective>
The other two listings and the wire schemas stop carrying their own copy.
Purpose: PLAN §3.B.
Output: one `Keyset` order per listing; `newestFirst`, `isBeforeCursor`, `toPage`, `pageLimit` and the inline comparators deleted.
</objective>

<context>
@packages/admin/src/ImpersonationRecords.ts (:186-212, :446-460, :675-696, :760-776, plus ticket 12's pageLimit)
@packages/organization/src/OrganizationRecords.ts (:211-232, :414-439)
@packages/admin/src/AdminTenants.ts (:195-212)
@packages/admin/src/AdminApi.ts (:151-172), packages/admin/src/AdminTenantsApi.ts (:48-54)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: records and AdminTenants</name>
    <files>packages/admin/src/ImpersonationRecords.ts, packages/organization/src/OrganizationRecords.ts, packages/admin/src/AdminTenants.ts</files>
    <read_first>the ranges in context</read_first>
    <action>ImpersonationRecords: one `order = Keyset.make({ column: "startedAt", direction: "desc", position: (r) => ({ at: r.startedAt, id: r.id }) })`; memory list sorts with `order.compare`, filters with `order.follows`, pages with `order.page`; SQL listQuery's cursor condition is `order.fragment(sql, cursor)` and ORDER BY `order.orderBy(sql)` (keep the tenant and `active` conditions); `pageLimit` becomes `Keyset.limit(limit, { fallback: DEFAULT_PAGE_SIZE, max: 200 })`. Delete `newestFirst` only if `closeOrder` or other code does not use it (rg first); delete `isBeforeCursor` and `toPage`. OrganizationRecords: memory and SQL listPage over an ascending `createdAt` order (`fragment` replaces the row-value comparison; both forms are equivalent, the contract proves it). AdminTenants: `Keyset.limit` and `order.page` replace the inline assembly.</action>
    <verify><automated>npx vitest run packages/admin/test/Contract.test.ts packages/organization/test/Contract.test.ts packages/admin/test/AdminTenants.test.ts</automated></verify>
    <acceptance_criteria>`rg -n 'limit \+ 1' packages/admin/src/ImpersonationRecords.ts packages/admin/src/AdminTenants.ts` prints only doc-comment lines (baseline 6 lines: ImpersonationRecords.ts :156, :201, :459, :675, :695; AdminTenants.ts :201); `rg -c 'isBeforeCursor|const toPage' packages/admin/src/ImpersonationRecords.ts` prints nothing (baseline 3).</acceptance_criteria>
    <done>Contracts green on memory and SQLite.</done>
  </task>
  <task type="auto">
    <name>Task 2: wire cursor schemas</name>
    <files>packages/admin/src/AdminApi.ts, packages/admin/src/AdminTenantsApi.ts</files>
    <read_first>packages/admin/src/AdminApi.ts:145-175; packages/admin/src/AdminTenantsApi.ts:45-56</read_first>
    <action>`CursorSchema = Keyset.cursor(Schema.Struct({ startedAt: Schema.DateTimeUtcFromString, id: Schema.String }))`, `UserCursorSchema` and `OrganizationCursorSchema` likewise with `createdAt`; keep the names and doc comments (ESS-006/BAM-005).</action>
    <verify><automated>npx vitest run packages/admin/test packages/ports/test/Keyset.test.ts && pnpm test:pg</automated></verify>
    <acceptance_criteria>`rg -c 'StringFromBase64Url' packages/admin/src/AdminApi.ts packages/admin/src/AdminTenantsApi.ts` prints nothing (baseline 2 + 1).</acceptance_criteria>
    <done>Admin suite and Postgres green; cursor bytes unchanged (ticket 14's oracle test).</done>
  </task>
</tasks>

<threat_model>
## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-17 | Information disclosure | tenant predicate dropped while rewriting listQuery | medium | mitigate | keep `TenantScoped.predicate` in the condition list; the contract's cross-tenant case (`ImpersonationRecords.ts` contract :269) stays green |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:pg</verification>

<success_criteria>No hand-written keyset predicate or page assembly left in admin or organization src; all listing tests green on three databases.</success_criteria>

## Comments
