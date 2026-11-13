---
plan: 40-residue
ticket: 14
title: "Keyset module in @awthaq/ports (only if Part B's gate is GO)"
type: tdd
wave: 2
depends_on: [11]
files_modified:
  - packages/ports/src/Keyset.ts
  - packages/ports/src/index.ts
  - packages/ports/test/Keyset.test.ts
autonomous: false
requirements: [REQ-EA-1613]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "Keyset.make({ column, direction, position }) gives compare, follows, fragment, orderBy and page that agree with each other at ties in both directions"
    - "Keyset.limit implements Users.list's rule"
    - "Keyset.cursor(Schema.Struct({ createdAt|startedAt: DateTimeUtcFromString, id: String })) encodes byte-identically to AdminApi.CursorSchema, AdminApi.UserCursorSchema and AdminTenantsApi.OrganizationCursorSchema"
  artifacts:
    - path: packages/ports/src/Keyset.ts
      provides: "the keyset order module"
      exports: ["make", "limit", "cursor", "Position", "Order"]
  key_links:
    - from: packages/ports/src/index.ts
      to: packages/ports/src/Keyset.ts
      via: "export * as Keyset"
      pattern: "export \\* as Keyset"
---
Status: ready-for-human
Blocked by: 11, and the Part B gate. A human sets ready-for-agent only if PLAN.md "Decisions taken" records "Part B gate: GO" (ticket 11 found an order drift) or overrides Q4 to GO.

<objective>
One module for the keyset order: comparison, follows predicate, SQL fragment and ORDER BY, `limit + 1` page assembly, limit rule, cursor codec.
Purpose: PLAN §3.B. Only built if the copies are shown to drift.
Output: `Keyset` exported from `@awthaq/ports` with unit tests; no adopter yet.
</objective>

<context>
@.planning/40-residue/PLAN.md §3.B (interface sketch)
@packages/ports/src/SqlTransaction.ts (ports already imports effect/sql)
@packages/sql/src/TenantScoped.ts (:89-105 predicate: the fragment style to follow)
@packages/ports/src/UserStore.ts (:183-186 byCreation, :359-380 memory listPage)
@packages/admin/src/ImpersonationRecords.ts (:186-212 newestFirst, isBeforeCursor, toPage)
@packages/admin/src/AdminApi.ts (:151-172), packages/admin/src/AdminTenantsApi.ts (:48-54)
</context>

<tasks>
  <task type="tdd">
    <name>Task 1: unit tests first</name>
    <files>packages/ports/test/Keyset.test.ts</files>
    <read_first>packages/ports/test (an existing test for style); PLAN §3.B</read_first>
    <behavior>
      - asc order over rows {at, id}: compare sorts by at then id code unit; follows(row, after) is true exactly for rows that sort after `after`; desc mirrors both.
      - page(rows, limit, cursorOf): rows.length ≤ limit → all items, next None; rows.length = limit + 1 → limit items, next = cursorOf(last kept item).
      - limit: undefined → 50, NaN → 50, Infinity → 50, 0 → 1, -3 → 1, 2.5 → 2, 10_000 → 200.
      - fragment/orderBy compiled with a SQLite SqlClient (use the test helper other ports/sql tests use) produce `("createdAt" > ? OR ("createdAt" = ? AND id > ?))` for asc and the `<` form for desc, and `ORDER BY "createdAt" ASC, id ASC` / `DESC, id DESC`.
      - cursor codec: for a fixed `{ createdAt, id }` (and `{ startedAt, id }`) the encoded string equals what today's three admin schemas produce (copy their definitions into the test as the oracle).
    </behavior>
    <action>Write the tests against the interface sketched in PLAN §3.B; they fail to compile (red).</action>
    <verify><automated>npx vitest run packages/ports/test/Keyset.test.ts 2>&1 | tail -3   # RED</automated></verify>
    <done>Red.</done>
  </task>
  <task type="auto">
    <name>Task 2: implement</name>
    <files>packages/ports/src/Keyset.ts, packages/ports/src/index.ts</files>
    <read_first>packages/sql/src/TenantScoped.ts:85-110</read_first>
    <action>Implement `Keyset.ts` per PLAN §3.B: `Position`, `Order<Row>`, `make`, `limit`, `cursor`. `compare` uses epoch millis then code-unit id, negated for "desc"; `follows` is `compare(row, after) > 0` expressed on positions; `fragment(sql, after)` uses `sql(column)` identifiers and bound values, never string concatenation; `page` slices `limit` and builds `next` only when `rows.length > limit`. `cursor(fields)` is `Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(fields)))`. No `as`; no return annotation on Effect consts (there are none: all are plain functions). Export from index.ts as `export * as Keyset from "./Keyset.ts"` with a one-line header comment.</action>
    <verify><automated>npx vitest run packages/ports/test/Keyset.test.ts && pnpm typecheck && pnpm knip</automated></verify>
    <done>Unit tests green; knip may report `Keyset` unused until ticket 15 (acceptable only between 14 and 15 if they land in one PR; otherwise land 14 with 15).</done>
  </task>
</tasks>

<threat_model>
## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-15 | Tampering | SQL fragment built from a cursor | medium | mitigate | values bound as parameters, column via `sql(identifier)`; test asserts placeholders |
| T-40-16 | Tampering | cursor codec | low | mitigate | Schema decode at the wire, byte-identical to today's schemas |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>`Keyset` exported; its unit tests green; cursor bytes identical to the three existing schemas.</success_criteria>

## Comments
