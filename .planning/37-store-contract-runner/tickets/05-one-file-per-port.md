---
plan: 37-store-contract-runner
ticket: 05
title: One file per port (move only)
type: execute
wave: 2
depends_on: [04]
files_modified:
  - packages/test/src/StoreContract.ts
  - packages/test/src/internal/storeContract/fixtures.ts
  - packages/test/src/internal/storeContract/auditLog.ts
  - packages/test/src/internal/storeContract/verification.ts
  - packages/test/src/internal/storeContract/accounts.ts
  - packages/test/src/internal/storeContract/users.ts
  - packages/test/src/internal/storeContract/sessions.ts
  - packages/test/src/internal/storeContract/relayCursor.ts
autonomous: true
requirements: [REQ-EA-1583]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Each core port's cases and fixtures live in their own file under internal/storeContract/"
    - "StoreContract.<port> and StoreContract.userFieldColumns resolve to the same values as before"
    - "The memory, SQL, WAL, libSQL and sealed runs register exactly the same case names as before"
  artifacts:
    - path: "packages/test/src/internal/storeContract/sessions.ts"
      provides: "the SessionStore cases (moved from StoreContract.ts:1483-2013)"
  key_links:
    - from: "packages/test/src/StoreContract.ts"
      to: "packages/test/src/internal/storeContract/*.ts"
      via: "export { auditLog } from … (one re-export per port)"
      pattern: "from \"./internal/storeContract/"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
`packages/test/src/StoreContract.ts` is 2085 lines: six lists and their fixtures. Tickets 06–08 re-group each list by operation. Doing that inside one file serialises the work and costs each executor most of its context reading the other ports.

Purpose: locality. A port's interface and its cases are read together.

Output: six per-port files plus a fixtures file, and `StoreContract.ts` re-exporting the six lists under their current names. This is a pure move; no case changes.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§3.4)
@packages/test/src/StoreContract.ts
@packages/test/src/internal/contract.ts (from ticket 04)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: record the case-name baseline, then move</name>
    <files>packages/test/src/StoreContract.ts, packages/test/src/internal/storeContract/fixtures.ts, packages/test/src/internal/storeContract/auditLog.ts, packages/test/src/internal/storeContract/verification.ts, packages/test/src/internal/storeContract/accounts.ts, packages/test/src/internal/storeContract/users.ts, packages/test/src/internal/storeContract/sessions.ts, packages/test/src/internal/storeContract/relayCursor.ts</files>
    <read_first>packages/test/src/StoreContract.ts whole file (where each list starts and ends: auditLog section from ":78 ---- auditLog" to :376, verification :378-646, accounts :648-971, users :973-1481 with userFieldColumns at :973, sessions :1483-2013, relayCursor :2015-end; line numbers move by ticket 01's additions)</read_first>
    <action>First save the baseline. Run the memory and sql contract files with the verbose reporter and keep the sorted list of passing test names in the scratchpad. Then create packages/test/src/internal/storeContract/. Move each port's section (its type alias, fixtures, helpers and exported list) verbatim into its file: auditLog.ts, verification.ts, accounts.ts, users.ts (with userFieldColumns), sessions.ts and relayCursor.ts. Each file imports Case and race from ../contract.ts, never from StoreContract.ts, which would be a module cycle. A helper used by more than one port goes into fixtures.ts, imported by those files: at, and any other helper grep shows used across sections. Every new file gets a one-line header naming its port and plan 37. In StoreContract.ts, keep the header, the re-exports, suite, Suite, runSuite and the old run. Add one re-export line per port, keeping the names auditLog, verification, accounts, users, sessions, relayCursor and userFieldColumns. Remove the imports that no longer have a use.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm circular &amp;&amp; test "$(ls packages/test/src/internal/storeContract/*.ts | wc -l | tr -d ' ')" -eq 7</automated></verify>
    <acceptance_criteria>Seven files exist (baseline 0; the directory does not exist at HEAD). `wc -l packages/test/src/StoreContract.ts` is under 200 (baseline 2085 plus ticket 01's cases). Typecheck and circular pass.</acceptance_criteria>
    <done>Each port has its own file.</done>
  </task>

  <task type="auto">
    <name>Task 2: prove nothing moved but text</name>
    <files>(none; verification only)</files>
    <read_first>the baseline list from Task 1</read_first>
    <action>Run the same verbose commands again and diff the sorted name lists against the baseline. They must be identical. Run all five runner files.</action>
    <verify><automated>pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts packages/test/test/StoreContract.sealed.test.ts packages/test/test/StoreContract.test.ts</automated></verify>
    <acceptance_criteria>The name diff is empty; all six files pass.</acceptance_criteria>
    <done>A pure move, proven.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- 7 files under `packages/test/src/internal/storeContract/`; `StoreContract.ts` under 200 lines.
- Identical sorted test-name lists before and after on the memory and SQL runs.
- knip reports no new unused export (`.reports/` noise excepted, per IMPLEMENTING.md).
</success_criteria>

## Comments

Done (uncommitted). Seven files under `internal/storeContract/` (fixtures, auditLog, verification, accounts, users, sessions, relayCursor) plus `suite.ts`. Shared helpers in fixtures.ts: `at`, `opened`, `makeUserId`. Sorted passing-name lists on memory, SQL and sealed runs identical before and after. `StoreContract.ts` 2324 -> ~130 lines (the old `run` and `RunConfig` remain until ticket 09).
