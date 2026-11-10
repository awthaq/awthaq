---
plan: 37-store-contract-runner
ticket: 06
title: TRACER — relayCursor and auditLog as verdict suites on all five adapters
type: tdd
wave: 3
depends_on: [05]
files_modified:
  - packages/test/src/internal/storeContract/relayCursor.ts
  - packages/test/src/internal/storeContract/auditLog.ts
  - packages/test/test/support/storeContract.ts
autonomous: true
requirements: [REQ-EA-1583]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "StoreContract.relayCursor and StoreContract.auditLog are Suites built by StoreContract.suite, with a verdict for each of their 2 and 5 operations"
    - "Every atomic verdict carries at least one race case"
    - "The two suites run on the Ref adapters, SQLite, a WAL file, libSQL and (under test:pg) Postgres through StoreContract.runSuite"
    - "No case was lost: the set of case names, with the '<operation> [<verdict>]: ' prefix stripped, equals the set before"
  artifacts:
    - path: "packages/test/src/internal/storeContract/relayCursor.ts"
      provides: "relayCursor = suite(RelayCursorStore.RelayCursorStore, { operations: { get, advance } })"
    - path: "packages/test/src/internal/storeContract/auditLog.ts"
      provides: "auditLog = suite(AuditLogStore.AuditLogStore, { operations: { append, select, pageAfter, rewriteReferencing, deleteBefore } })"
  key_links:
    - from: "packages/test/test/support/storeContract.ts"
      to: "packages/test/src/StoreContract.ts"
      via: "StoreContract.runSuite(framework, { adapter, suite: StoreContract.relayCursor, layer })"
      pattern: "runSuite\\("
---
Status: done (uncommitted)
Blocked by: 05

<objective>
The tracer. It takes the two smallest ports (RelayCursorStore: 2 operations, 6 cases; AuditLogStore: 5 operations, 13 cases) through the new shape end to end: verdict-keyed suite, then `runSuite`, then every runner file and adapter. Only then are the other 70 cases converted. If the suite shape, the erased case types or the runner fail on a real SQL adapter, this ticket shows it.

Purpose: prove the deepened contract on real adapters before converting the bulk.

Output: two suites; the support file runs them through `runSuite`; the other four ports still run through the old `run`.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§2.3 verdict audit, §3.3)
@packages/ports/src/RelayCursorStore.ts (the shape: get, advance)
@packages/ports/src/AuditLogStore.ts (lines 55-110: append, select, pageAfter, rewriteReferencing, deleteBefore)
@packages/test/src/internal/storeContract/relayCursor.ts
@packages/test/src/internal/storeContract/auditLog.ts
@packages/test/test/support/storeContract.ts
@packages/organization/test/contract/TeamRecords.ts (a converted RecordsContract suite, for style)
</context>

<tasks>
  <task type="tdd">
    <name>Task 1: baseline names, then relayCursor as a suite</name>
    <files>packages/test/src/internal/storeContract/relayCursor.ts, packages/test/test/support/storeContract.ts</files>
    <read_first>packages/test/src/internal/storeContract/relayCursor.ts; packages/ports/src/RelayCursorStore.ts; packages/test/test/support/storeContract.ts runOnMemory and runOnSql</read_first>
    <behavior>
      - get [read]: "get is None for a name that was never advanced"
      - advance [atomic]: the four non-concurrent advance cases ("stores the first position…", "names are independent…", "never moves a position backwards…", "compares ids as bytes…")
      - advance [race]: "advance under concurrency: 8 racing advances of one name leave the largest id"
    </behavior>
    <action>First save the baseline. Run the memory and sql runner files with the verbose reporter and keep the sorted list of passing test names. Then turn the relayCursor array into an exported const built by suite over RelayCursorStore.RelayCursorStore, with operations get and advance carrying the verdicts above. Keep each case's name and body; only regroup them. In the support file, replace the two blocks that call StoreContract.run with adapter "RelayCursorStore (Ref)" and "RelayCursorStore (<label>)" with StoreContract.runSuite, passing suite: StoreContract.relayCursor and the same adapter name and layer.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts</automated></verify>
    <acceptance_criteria>The relay cursor tests appear as "get [read]: …", "advance [atomic]: …" and "advance [race]: …", 6 in total per adapter.</acceptance_criteria>
    <done>The first suite runs through runSuite on memory and SQLite.</done>
  </task>

  <task type="tdd">
    <name>Task 2: auditLog as a suite</name>
    <files>packages/test/src/internal/storeContract/auditLog.ts, packages/test/test/support/storeContract.ts</files>
    <read_first>packages/test/src/internal/storeContract/auditLog.ts; packages/ports/src/AuditLogStore.ts lines 55-110</read_first>
    <behavior>
      - append [atomic]: "append is idempotent on id…", "append stamps the ambient tenant…", "append returns the payload byte for byte"; append [race]: "append is idempotent under concurrency…"
      - select [read]: "select is newest first…", "select applies the filter in the store…"
      - pageAfter [read]: "pageAfter pages in ascending byte order of id…", "pageAfter filters by tag before it limits"
      - rewriteReferencing [write]: the three rewriteReferencing cases (its "all-or-nothing" is failure atomicity, not a race; the port's interface does not ask for concurrent callers)
      - deleteBefore [write]: the two deleteBefore cases
    </behavior>
    <action>Regroup the auditLog array the same way, using suite over AuditLogStore.AuditLogStore. In the support file, replace the AuditLogStore blocks (Ref and SQL) with runSuite. If a case proves two operations, list it under the operation its name starts with. If that leaves another operation with no case, split the case into two. Do not list one case under two operations.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts</automated></verify>
    <acceptance_criteria>The four files pass. The AuditLogStore tests are prefixed by operation and verdict. Removing any operation key from the auditLog operations object breaks typecheck: check one by hand and revert.</acceptance_criteria>
    <done>Two ports converted end to end.</done>
  </task>

  <task type="auto">
    <name>Task 3: prove no case was lost</name>
    <files>(none; verification only)</files>
    <read_first>the baseline list from Task 1</read_first>
    <action>Run the memory and sql files verbose again. Strip the prefix that matches an operation name, a space, a bracketed verdict (read, write, atomic or race) and ": ". Sort and diff against the baseline. The lists must be identical. Record the per-port counts in Comments.</action>
    <verify><automated>pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts --reporter=verbose 2&gt;&amp;1 | grep -cE 'RelayCursorStore \(Ref\) &gt; (get|advance) \[(read|atomic|race)\]'</automated></verify>
    <acceptance_criteria>The stripped name diff is empty. The command above prints 6 (baseline 0: no case carries a verdict prefix at HEAD).</acceptance_criteria>
    <done>The tracer is green and complete.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
If a Postgres is reachable: pnpm test:pg packages/test/test/StoreContract.sql.test.ts (after ticket 02), or report it unavailable.
</verification>

<success_criteria>
- 7 of 46 operations carry verdicts (relayCursor 2, auditLog 5).
- Stripped case-name lists identical before and after.
- All five runner files green.
</success_criteria>

## Comments

Done (uncommitted). relayCursor (2 ops) and auditLog (5 ops) are `suite`s run through `runSuite` on Ref, SQLite; WAL and libSQL files also green. Stripped name lists identical. 6 `RelayCursorStore (Ref) > get|advance [verdict]` rows. `TestClock` on every case broke nothing (Q5 default kept). Regrouping done with a scratchpad script, no case bodies edited. Postgres not run.
