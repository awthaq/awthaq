---
plan: 40-residue
ticket: 15
title: "UserStore (memory, SQL) and Users.list adopt Keyset (gate GO only)"
type: execute
wave: 3
depends_on: [14]
files_modified:
  - packages/ports/src/UserStore.ts
  - packages/sql/src/UserStoreSql.ts
  - packages/core/src/Users.ts
autonomous: true
requirements: [REQ-EA-1613]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "UserStore memory and SQL listPage use one Keyset order over (createdAt, id) ascending"
    - "Users.list uses Keyset.limit; listLimit is deleted"
    - "StoreContract's listPage case stays green on memory, SQLite and Postgres"
  artifacts:
    - path: packages/ports/src/UserStore.ts
      provides: "byCreation and the memory listPage over Keyset"
  key_links:
    - from: packages/sql/src/UserStoreSql.ts
      to: packages/ports/src/Keyset.ts
      via: "usersPage uses fragment/orderBy; listPage uses page"
      pattern: "Keyset\\."
---
Status: ready-for-human
Blocked by: 14 (and the Part B gate, as for 14)

<objective>
Users stop carrying their own copy of the keyset recipe.
Purpose: PLAN §3.B; the users copy is the reference shape.
Output: memory and SQL `listPage` and `Users.list` over `Keyset`.
</objective>

<context>
@packages/ports/src/UserStore.ts (:183-186, :359-380)
@packages/sql/src/UserStoreSql.ts (:176-192, :473-491)
@packages/core/src/Users.ts (:381, :556-561, :815-826)
@packages/ports/src/Keyset.ts (after 14)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: adapters</name>
    <files>packages/ports/src/UserStore.ts, packages/sql/src/UserStoreSql.ts</files>
    <read_first>the ranges in context</read_first>
    <action>Define `const order = Keyset.make({ column: "createdAt", direction: "asc", position: (u) => ({ at: u.createdAt, id: u.id }) })` once in UserStore.ts and export it as `UserStore.order` (or keep `byCreation` = `order.compare` if other code imports `byCreation`; check with rg). Memory listPage: sort with `order.compare`, filter with `order.follows`, `order.page(following.slice(0, limit + 1), limit, (u) => ({ createdAt: u.createdAt, id: u.id }))`. SQL `usersPage`: the WHERE uses `order.fragment(sql, after)` and ORDER BY `order.orderBy(sql)`; listPage uses `order.page` on the mapped rows. Keep `traced`/`read` wrappers in place.</action>
    <verify><automated>npx vitest run packages/sql/test/UserStoreSql.test.ts packages/sql/test/CoreStoresSql.test.ts packages/core/test/Users.test.ts</automated></verify>
    <acceptance_criteria>`rg -c 'limit \+ 1' packages/ports/src/UserStore.ts packages/sql/src/UserStoreSql.ts` prints nothing (baseline: UserStoreSql.ts 2 lines + the doc comment; adjust the doc comment wording so the gate measures code).</acceptance_criteria>
    <done>Store contract green on memory and SQLite.</done>
  </task>
  <task type="auto">
    <name>Task 2: Users.list limit</name>
    <files>packages/core/src/Users.ts</files>
    <read_first>packages/core/src/Users.ts:375-385, :550-565, :810-830</read_first>
    <action>Replace `listLimit(input?.limit)` with `Keyset.limit(input?.limit, { fallback: DEFAULT_LIST_LIMIT, max: MAX_LIST_LIMIT })` and delete `listLimit`.</action>
    <verify><automated>npx vitest run packages/core/test/Users.test.ts && pnpm typecheck && pnpm test:pg</automated></verify>
    <done>Users tests green; Postgres green.</done>
  </task>
</tasks>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:pg</verification>

<success_criteria>Users' keyset copy removed; StoreContract listPage green on all three databases.</success_criteria>

## Comments
