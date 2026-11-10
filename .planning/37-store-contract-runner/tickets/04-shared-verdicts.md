---
plan: 37-store-contract-runner
ticket: 04
title: One verdict machinery — StoreContract.suite and runSuite, RecordsContract on top
type: tdd
wave: 1
depends_on: [01]
files_modified:
  - packages/test/src/internal/contract.ts
  - packages/test/src/RecordsContract.ts
  - packages/test/src/StoreContract.ts
  - packages/test/test/StoreContract.test.ts
  - packages/test/test/StoreContract.types.test.ts
autonomous: true
requirements: [REQ-EA-1583]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Case, race, CONCURRENCY, Verdict, Operations, Entry and the verdict loop live in one module that both contracts import"
    - "Every RecordsContract export keeps its name and meaning; RecordsContract.test.ts and RecordsContract.types.test.ts pass unedited"
    - "StoreContract.suite(Port, { operations }) does not compile when an operation of Port's interface has no verdict"
    - "StoreContract.runSuite runs a suite's entries on a layer built afresh per case and reports a failing case"
  artifacts:
    - path: "packages/test/src/internal/contract.ts"
      provides: "Case, CONCURRENCY, race, Verdict, Operations, Entry, classify"
      exports: ["CONCURRENCY", "race", "classify"]
    - path: "packages/test/test/StoreContract.types.test.ts"
      provides: "an unclassified operation and a suite under the wrong port are errors"
  key_links:
    - from: "packages/test/src/RecordsContract.ts"
      to: "packages/test/src/internal/contract.ts"
      via: "suite() calls classify(definition.operations)"
      pattern: "classify\\("
    - from: "packages/test/src/StoreContract.ts"
      to: "packages/test/src/internal/contract.ts"
      via: "suite() calls classify; Case/race/CONCURRENCY re-exported"
      pattern: "internal/contract"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
`RecordsContract` owns the verdict machinery (`Verdict` at `RecordsContract.ts:53`, `Operations` at `:67`, `Entry` at `:78`, the loop inside `suite` at `:140-160`). It imports `Case`, `race` and `CONCURRENCY` from `StoreContract` (`:34`, `:40-42`), so `StoreContract` cannot import `RecordsContract` back without a module cycle.

Purpose: one machinery that both contracts use, so the core bar and the plugin bar cannot drift. Give `StoreContract` the `suite` builder and a runner for one suite on any adapter (`runSuite`).

Output: `internal/contract.ts`; `RecordsContract.suite` built on `classify`; `StoreContract.suite`, `Suite<Id>`, `runSuite`; a types test.

The six port lists are not converted here, and the old `StoreContract.run(framework, { adapter, layer, cases })` stays: the support file still uses it until ticket 09.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§3.2, §3.3, §3.6)
@packages/test/src/RecordsContract.ts (lines 1-190)
@packages/test/src/StoreContract.ts (lines 1-77)
@packages/test/test/StoreContract.test.ts
@packages/test/test/RecordsContract.types.test.ts (style of a compile-time test)
@packages/test/src/TestFramework.ts
</context>

<tasks>
  <task type="tdd">
    <name>Task 1 (RED): types test and runSuite self-test</name>
    <files>packages/test/test/StoreContract.types.test.ts, packages/test/test/StoreContract.test.ts</files>
    <read_first>packages/test/test/RecordsContract.types.test.ts lines 1-80; packages/test/test/StoreContract.test.ts</read_first>
    <behavior>
      - StoreContract.types.test.ts: (1) a builder that calls StoreContract.suite(RelayCursorStore.RelayCursorStore, { operations: { advance: { atomic: [c], race: [c] } } }) with a @ts-expect-error on the missing get verdict; (2) a Suite built for RelayCursorStore is not assignable to Suite of AuditLogStore (@ts-expect-error on an assignment); (3) one token runtime it so the file is a suite. Builders are never called, as in RecordsContract.types.test.ts.
      - StoreContract.test.ts, describe("StoreContract.runSuite"): "builds a fresh layer for every case and runs every entry" (the Counter fixture, a suite over Counter with one operation get carrying two read cases; assert both passed and seen equals [1, 1]); "reports a failing case rather than swallowing it" (a write case failing with NotAtomic; failed has one entry including "not atomic"); "names a case <operation> [<verdict>]: <case>"; "an exemption registers a passing test naming the reason".
    </behavior>
    <action>Write both files' new tests against the interface in PLAN.md §3.3: StoreContract.suite(store, { operations, sql? }) returns Suite<Id> with store, entries, exempt and sql; StoreContract.runSuite(framework, { adapter, suite, layer }). The Counter fixture in StoreContract.test.ts is a Context.Service whose shape is a Ref, so give the suite tests a small service class with a get operation (an Effect-valued function) built over the same Ref. Keep the existing StoreContract.run tests and the race test unchanged. Run typecheck and the test file: both must fail, because suite and runSuite do not exist yet.</action>
    <verify><automated>! pnpm exec vitest run packages/test/test/StoreContract.test.ts   # RED until Task 2</automated></verify>
    <acceptance_criteria>The new tests fail for the missing exports; the existing tests in the file are untouched.</acceptance_criteria>
    <done>The interface is pinned before it exists.</done>
  </task>

  <task type="tdd">
    <name>Task 2 (GREEN): internal/contract.ts, RecordsContract on classify</name>
    <files>packages/test/src/internal/contract.ts, packages/test/src/RecordsContract.ts</files>
    <read_first>packages/test/src/RecordsContract.ts lines 1-190; packages/test/src/StoreContract.ts lines 38-56</read_first>
    <action>Create packages/test/src/internal/contract.ts with a header comment. It says this is the verdict machinery StoreContract and RecordsContract share (ADR-EA-041 decisions 6 and 9, plan 37), so the core bar and the plugin bar are one bar. Move into it, unchanged in meaning: the Case interface and CONCURRENCY and race (from StoreContract.ts:41-55); the NonEmpty helper type, Verdict, Operations and Entry (from RecordsContract.ts:46-82); and a classify function. classify takes the operations record and returns { entries, exempt }, holding exactly the loop now inside RecordsContract.suite (the add helper and the for loop at :140-160, including the "<operation> [<verdict>]: <name>" naming). In RecordsContract.ts, delete the moved definitions and import them from ./internal/contract.ts. Re-export Verdict, Operations and Entry as types and Case, race and CONCURRENCY under their current names, so every caller compiles unchanged (46 uses of RecordsContract.CONCURRENCY and 28 of RecordsContract.race across plugin suites). Make suite call classify. Keep everything else in RecordsContract.ts as is. No type assertions; no return-type annotations on new consts.</action>
    <verify><automated>pnpm exec vitest run packages/test/test/RecordsContract.test.ts packages/test/test/RecordsContract.types.test.ts packages/organization/test/Contract.test.ts &amp;&amp; pnpm circular</automated></verify>
    <acceptance_criteria>`git diff --stat packages/test/test/RecordsContract*.ts` is empty (they pass unedited). `grep -c 'const add = (' packages/test/src/RecordsContract.ts` is 0 (baseline 1). pnpm circular passes.</acceptance_criteria>
    <done>One machinery; the plugin contract is unchanged from the outside.</done>
  </task>

  <task type="tdd">
    <name>Task 3 (GREEN): StoreContract.suite, Suite, runSuite</name>
    <files>packages/test/src/StoreContract.ts</files>
    <read_first>packages/test/src/StoreContract.ts lines 1-77; packages/test/src/RecordsContract.ts runClosed (~:204-206)</read_first>
    <action>In StoreContract.ts, replace the local Case, CONCURRENCY and race definitions with re-exports from ./internal/contract.ts, keeping the names. Add the Suite interface, invariant in Id as RecordsContract.Suite is: store, entries, exempt, and sql, whose cases are erased to Case of unknown as in RecordsContract's SuiteData. Add suite: its operations are keyed by Operations of NoInfer of Shape and each carries a Verdict over Id plus R. Its optional sql cases may also read SqlClient.SqlClient. It calls classify, and sql defaults to an empty array. Add runSuite(framework, { adapter, suite, layer }). It runs inside framework.describe titled "StoreContract: <adapter>". For each entry's case it registers framework.it, which runs the case scoped and provided with layer merged with TestClock.layer(), both built afresh per case, through Effect.exit. Cases are written under a TestClock, as RecordsContract's are (PLAN.md F8, F11). On failure it calls framework.fail with the adapter, the case name and Cause.pretty. For each exemption it registers a passing it named "<operation> is exempt: <reason>". Run closed over an empty context the way RecordsContract's runClosed does (Effect.runPromiseWith with Context.makeUnsafe of an empty Map), because the layer is typed with unknown requirements. runSuite does not run a suite's sql cases: those read the shipped schema (PLAN.md §10 Q7). Leave the existing run export and the six case lists untouched. Update the file header with one paragraph saying cases are grouped by operation with a verdict, as RecordsContract's are (plan 37).</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.test.ts packages/test/test/StoreContract.types.test.ts packages/test/test/StoreContract.memory.test.ts</automated></verify>
    <acceptance_criteria>All Task 1 tests pass. The types test's @ts-expect-error lines are each needed: removing one makes typecheck fail. Spot-check one by hand and revert. The memory contract still counts 89 or more.</acceptance_criteria>
    <done>StoreContract can describe a port as a verdict-keyed suite and run it on any adapter.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- `RecordsContract*.test.ts` unchanged and green; every plugin `Contract.test.ts` green (they run in `pnpm test`).
- `StoreContract.types.test.ts` holds 2 @ts-expect-error lines that are each load-bearing.
- No module cycle in `packages/test/src` (`pnpm circular`).
</success_criteria>

## Comments

Done (uncommitted). `internal/contract.ts` holds Case, CONCURRENCY, race, NonEmpty, Verdict, Operations, Entry, classify; `RecordsContract.ts` re-exports the same public names and `suite` calls `classify`; RecordsContract tests untouched and green. `StoreContract.suite/Suite/runSuite` added, `StoreContract.types.test.ts` has 2 load-bearing `@ts-expect-error` (the second needs an `@effect-diagnostics-next-line missingEffectContext:off`, as `RecordsContract.types.test.ts:72` does). 3 runSuite self-tests added (fresh layer + names, failing case + exemption, TestClock). Deviation: the tests were written together with the code, not observed RED first. Deviation (ticket 05 follow-on): `suite`/`Suite` live in `internal/storeContract/suite.ts` and `StoreContract.ts` re-exports them, because per-port files cannot import `StoreContract.ts` (it re-exports them: ESM cycle).
