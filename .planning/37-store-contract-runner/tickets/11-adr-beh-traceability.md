---
plan: 37-store-contract-runner
ticket: 11
title: ADR-EA-041 rev 1.6, BEH-EA-365, rate-limiting pointers, traceability
type: execute
wave: 8
depends_on: [10, 03]
files_modified:
  - spec/decisions/041-domain-store-ports.md
  - spec/behaviors/25-testing-harness.md
  - spec/behaviors/14-rate-limiting.md
  - spec/traceability.md
autonomous: true
requirements: [REQ-EA-1586]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "ADR-EA-041 decision 6 states the verdict-keyed suites, the shared machinery, StoreContract.run's modes, runSuite and RateLimiterStore"
    - "BEH-EA-365 exists in 25-testing-harness.md, with BEH-EA-342 and BEH-EA-201 navigation updated"
    - "14-rate-limiting.md no longer points at the deleted RateLimiterStoreSql test files"
    - "spec/traceability.md names StoreContract.types.test.ts, the seven suites and BEH-EA-365"
  artifacts:
    - path: "spec/decisions/041-domain-store-ports.md"
      provides: "revision 1.6"
      contains: "rateLimiterStore"
    - path: "spec/behaviors/25-testing-harness.md"
      provides: "BEH-EA-365"
      contains: "## BEH-EA-365"
  key_links:
    - from: "spec/traceability.md"
      to: "spec/behaviors/25-testing-harness.md"
      via: "§1 file-25 row lists BEH-EA-365"
      pattern: "365"
---
Status: ready-for-agent
Blocked by: 10, 03

<objective>
Record the decision and the behaviour. ADR-EA-041 decision 6 is amended, not superseded: decision 9 already states the shape, and this plan extends it to the ports decision 6 covers. No new ADR (PLAN.md §10 Q4).

Purpose: the spec says what the code now enforces.

Output: ADR revision 1.6, BEH-EA-365, the BEH-EA-109 note, the rate-limiting implementation pointer, and traceability 1.79.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§6.1 decision text, §6.2, §6.3)
@spec/decisions/041-domain-store-ports.md
@spec/behaviors/25-testing-harness.md (Document Control, BEH-EA-336 at ~273, BEH-EA-342 at ~290 to end)
@spec/behaviors/14-rate-limiting.md (line 15, BEH-EA-109 at ~127-143)
@spec/traceability.md (line 13 history; §1 file-25 row; §4 ADR-EA-041 row at ~185; §5 rows ~198 and ~246)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: ADR-EA-041 1.6 and BEH-EA-365</name>
    <files>spec/decisions/041-domain-store-ports.md, spec/behaviors/25-testing-harness.md</files>
    <read_first>spec/decisions/041-domain-store-ports.md whole; spec/behaviors/25-testing-harness.md lines 1-15 and 286-end</read_first>
    <action>Replace decision 6's paragraph with the text in PLAN.md §6.1, fitted to the shipped names; check them in packages/test/src/StoreContract.ts. Set Revision to 1.6 and the Effective Date, and append the change-history entry from §6.1. Leave every other decision untouched; decision 3's mention of RateLimiterStore as precedent stays. In 25-testing-harness.md, add BEH-EA-365 after BEH-EA-342, in the file's format: a heading "## BEH-EA-365: Every core store port passes its StoreContract suite on every adapter", a "See: ADR-EA-041" line, a short ts block showing StoreContract.run(framework, { mode: "sql", label, client }), and a REQUIREMENT block with the text in PLAN.md §6.2. Follow it with one paragraph of rationale: the ports are atomic by contract, and the bar must name every operation. Add an *Implementation* line naming packages/test/src/StoreContract.ts, internal/storeContract/*.ts, StoreContract.test.ts, StoreContract.types.test.ts and the five runner files. Set BEH-EA-342's "Next" to BEH-EA-365, and give BEH-EA-365 Previous BEH-EA-342 and Next BEH-EA-201 (26-cli.md). Bump Document Control to 1.12 with a change-history entry.</action>
    <verify><automated>grep -q '^## BEH-EA-365' spec/behaviors/25-testing-harness.md &amp;&amp; grep -q '| Revision | 1.6 |' spec/decisions/041-domain-store-ports.md &amp;&amp; pnpm spec:verify:strict</automated></verify>
    <acceptance_criteria>Baseline: no BEH-EA-365 heading, and the ADR is at revision 1.5. After: the heading exists, the ADR is at 1.6, and spec:verify:strict passes.</acceptance_criteria>
    <done>The decision and the behaviour are recorded.</done>
  </task>

  <task type="auto">
    <name>Task 2: rate-limiting pointers and traceability</name>
    <files>spec/behaviors/14-rate-limiting.md, spec/traceability.md</files>
    <read_first>spec/behaviors/14-rate-limiting.md lines 1-16 and 127-145; spec/traceability.md lines 13, the §1 file-25 row, 185, 198, 246</read_first>
    <action>In 14-rate-limiting.md line 15, replace packages/sql/test/RateLimiterStoreSql.test.ts with "@awthaq/test's StoreContract.rateLimiterStore (run on the memory store, SQLite, a WAL file, libSQL and Postgres)". Add to BEH-EA-109 the note from PLAN.md §6.2. Bump to revision 1.6 with a change-history entry. In spec/traceability.md, add 365 to the §1 row for file 25. Rewrite the ADR-EA-041 row's decision-6 part to name StoreContract.types.test.ts, the seven suites under packages/test/src/internal/storeContract/, StoreContract.run's three modes and the two mutants in StoreContract.test.ts. Say packages/ports/test/VerificationStore.test.ts now holds the purge and pruning cases. Update the §5 prose at ~198 that lists the runner files so it matches. Add a §5 row for StoreContract.types.test.ts. Bump to 1.79 with a change-history entry citing plan 37.</action>
    <verify><automated>! grep -n 'RateLimiterStoreSql.test.ts' spec/behaviors/14-rate-limiting.md &amp;&amp; grep -q 'StoreContract.types.test.ts' spec/traceability.md &amp;&amp; pnpm spec:verify:strict</automated></verify>
    <acceptance_criteria>Baseline: 14-rate-limiting.md names RateLimiterStoreSql.test.ts once, and traceability names StoreContract.types.test.ts 0 times. After: 0 and at least 1. spec:verify:strict passes.</acceptance_criteria>
    <done>Traceability follows the tests.</done>
  </task>
</tasks>

<verification>
pnpm spec:verify:strict && pnpm check:readmes
</verification>

<success_criteria>
- ADR-EA-041 at 1.6; BEH-EA-365 present with navigation; 14-rate-limiting at 1.6; traceability at 1.79.
- `pnpm spec:verify:strict` passes.
</success_criteria>

## Comments
