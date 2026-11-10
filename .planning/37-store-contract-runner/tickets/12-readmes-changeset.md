---
plan: 37-store-contract-runner
ticket: 12
title: READMEs and the shape-change changeset
type: execute
wave: 8
depends_on: [10, 03]
files_modified:
  - packages/test/README.md
  - packages/sql/README.md
  - .changeset/test-store-contract-suites.md
autonomous: true
requirements: [REQ-EA-1586]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "packages/test/README.md describes StoreContract's suites, run(framework, mode) and runSuite"
    - "packages/sql/README.md says the contract covers RateLimiterStore"
    - "A changeset records the @awthaq/test shape change with a Migration line"
  artifacts:
    - path: ".changeset/test-store-contract-suites.md"
      provides: "\"@awthaq/test\": minor, with Migration:"
      contains: "Migration:"
  key_links:
    - from: "packages/test/README.md"
      to: "packages/test/src/StoreContract.ts"
      via: "the StoreContract entry names run, runSuite and the seven suites"
      pattern: "StoreContract"
---
Status: ready-for-agent
Blocked by: 10, 03

<objective>
The package docs and the release note. `StoreContract.<port>` changed from an array to a suite, and `StoreContract.run`'s signature changed. `@awthaq/test` is private but versioned (`.changeset/config.json` `privatePackages.version: true`), so the change gets a changeset with a `Migration:` line.

Purpose: a reader of the package finds the contract's interface without reading the source.

Output: two README edits and one changeset.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§6.5, §6.6)
@packages/test/README.md
@packages/sql/README.md (lines 28-34, 224-232)
@.changeset/test-records-contract-pending-removed.md (format)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: READMEs</name>
    <files>packages/test/README.md, packages/sql/README.md</files>
    <read_first>packages/test/README.md; packages/sql/README.md lines 28-34 and 224-232</read_first>
    <action>In packages/test/README.md, add or replace the StoreContract entry beside the RecordsContract one. StoreContract is the core store contract (ADR-EA-041 decision 6). It holds one suite per port: auditLog, verification, accounts, users, sessions, relayCursor and rateLimiterStore. Each operation is classified as in RecordsContract, through the same machinery. StoreContract.run(framework, { mode }) runs every suite on the shipped memory bundle, on the SQL bundle over a given client, or on the sealed bundle. StoreContract.runSuite(framework, { adapter, suite, layer }) runs one suite on any other adapter of its port, such as a KV SessionStore. The cases live in src/internal/storeContract/. In packages/sql/README.md:229, change "holds each port's cases as data" to say it holds one suite per port, RateLimiterStore included, and runs them on the Ref adapters, :memory: SQLite, a WAL file, libSQL and Postgres. Line 32 (the libSQL row) stays true.</action>
    <verify><automated>pnpm check:readmes &amp;&amp; grep -q 'runSuite' packages/test/README.md &amp;&amp; grep -q 'RateLimiterStore' packages/sql/README.md</automated></verify>
    <acceptance_criteria>Baseline: `grep -c 'runSuite' packages/test/README.md` is 0. After: at least 1. check:readmes passes.</acceptance_criteria>
    <done>The docs match the interface.</done>
  </task>

  <task type="auto">
    <name>Task 2: changeset</name>
    <files>.changeset/test-store-contract-suites.md</files>
    <read_first>.changeset/test-records-contract-pending-removed.md</read_first>
    <action>Front matter: "@awthaq/test": minor. Body: StoreContract takes RecordsContract's shape (plan 37, ADR-EA-041 rev 1.6). Every core store port is a suite whose operations carry verdicts. StoreContract.run(framework, mode) owns the memory, SQL and sealed modes. RateLimiterStore joins as rateLimiterStore. Add a Migration paragraph: StoreContract.<port> is a Suite, not a ReadonlyArray of cases. StoreContract.run(framework, { adapter, layer, cases }) is now StoreContract.runSuite(framework, { adapter, suite, layer }). A caller that ran the core contract on its own adapter passes the port's suite.</action>
    <verify><automated>grep -q '"@awthaq/test": minor' .changeset/test-store-contract-suites.md &amp;&amp; grep -q '^Migration:' .changeset/test-store-contract-suites.md</automated></verify>
    <acceptance_criteria>The file exists with both lines.</acceptance_criteria>
    <done>The release note is ready.</done>
  </task>
</tasks>

<verification>
pnpm check
pnpm test:pg packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.sealed.test.ts when a Postgres is reachable; otherwise report Postgres unavailable (the plan gate, PLAN.md §9 last item).
</verification>

<success_criteria>
- `pnpm check` green on the finished plan.
- Changeset present with `Migration:`.
</success_criteria>

## Comments
