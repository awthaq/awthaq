---
plan: 37-store-contract-runner
ticket: 09
title: StoreContract.run(framework, mode) owns memory, SQL and sealed
type: tdd
wave: 6
depends_on: [08]
files_modified:
  - packages/test/src/StoreContract.ts
  - packages/test/test/support/storeContract.ts
  - packages/test/test/StoreContract.memory.test.ts
  - packages/test/test/StoreContract.sql.test.ts
  - packages/test/test/StoreContract.file.test.ts
  - packages/test/test/StoreContract.libsql.test.ts
  - packages/test/test/StoreContract.sealed.test.ts
  - packages/test/test/StoreContract.test.ts
  - packages/test/test/StoreContract.types.test.ts
autonomous: true
requirements: [REQ-EA-1584]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "StoreContract.run(framework, { mode: \"memory\" }) runs every suite on Persistence.memory, a fresh bundle and a TestClock per case"
    - "StoreContract.run(framework, { mode: \"sql\", label, client }) runs every suite and its sql cases on CoreStoresSql.layer() over the client, migrated, with TestEncryption and the three user-field columns"
    - "StoreContract.run(framework, { mode: \"sealed\", label, client }) runs the users and sessions suites on CoreStoresSql.layer({ encryptPii: true })"
    - "In memory mode one test checks that every core store Persistence.memory provides has a suite"
    - "Each runner test file is one StoreContract.run call; the support file keeps only framework, walFileClient and libsqlFileClient"
    - "The old StoreContract.run(framework, { adapter, layer, cases }) is gone"
  artifacts:
    - path: "packages/test/src/StoreContract.ts"
      provides: "Suites, suites, Mode, run"
      exports: ["run", "suites", "runSuite", "suite"]
    - path: "packages/test/test/support/storeContract.ts"
      provides: "framework, walFileClient, libsqlFileClient"
  key_links:
    - from: "packages/test/test/StoreContract.sql.test.ts"
      to: "packages/test/src/StoreContract.ts"
      via: "StoreContract.run(framework, { mode: \"sql\", label: \"SQL\", client: TestSql.layer(\"store_contract\") })"
      pattern: "mode: \"sql\""
    - from: "packages/test/src/StoreContract.ts"
      to: "packages/test/src/TestEncryption.ts"
      via: "the SQL base provides TestEncryption.layer (replacing the support file's copy)"
      pattern: "TestEncryption\\.layer"
---
Status: done (uncommitted)
Blocked by: 08

<objective>
The depth of the contract is in a test-only file. `packages/test/test/support/storeContract.ts` (201 lines at HEAD) builds the fixed-key `Encryption` as a copy of `TestEncryption.layer`, adds the three user-field columns, migrates core, hand-assembles per-port memory layers instead of `Persistence.memory`, and chooses the sealed bundle. The exported `StoreContract.run` only loops.

Purpose: move the modes behind one exported call, so a runner is one line and the bar is the shipped bundles, not hand-built layers. This is the second risk point after the tracer. It moves code that runs today and adds `TestClock` (PLAN.md F8, F11).

Output: `StoreContract.run(framework, mode)`, `Suites` and `suites`; the five runner files at one call each; the support file reduced to the two file-backed clients and `framework`.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§3.3 run table, §7 risks 1-2, §10 Q5 Q8)
@packages/test/test/support/storeContract.ts
@packages/test/src/StoreContract.ts
@packages/test/src/RecordsContract.ts (recordsBase, migratedClient, runClosed, the coverage it at ~:280-295)
@packages/test/src/TestEncryption.ts
@packages/test/src/internal/foundation.ts (TestClock.layer() use)
@packages/core/src/Persistence.ts (memory, lines 30-46)
@packages/sql/src/CoreStoresSql.ts (Options, layer, lines 30-70)
</context>

<tasks>
  <task type="tdd">
    <name>Task 1 (RED): the runner's self-test and the Suites key test</name>
    <files>packages/test/test/StoreContract.test.ts, packages/test/test/StoreContract.types.test.ts</files>
    <read_first>packages/test/test/StoreContract.test.ts; packages/test/test/StoreContract.types.test.ts</read_first>
    <behavior>
      - describe("StoreContract.run"), replacing the two tests of the old signature that ticket 04 kept: "memory mode registers every suite's entries and the coverage check, and all pass". Under the recording framework, passed contains a name including "has a suite", failed is empty, and passed.length is at least the sum of the suites' entries lengths. "sql mode over :memory: SQLite also runs the suites' sql cases". Same shape, with client SqliteClient.layer({ filename: ":memory:" }); failed is empty. "sealed mode registers only the users and sessions suites". Every passed name contains "UserStore" or "SessionStore".
      - StoreContract.types.test.ts: a Suites value with a key holding a suite for another port is an error (@ts-expect-error), and the exported suites satisfies Suites.
    </behavior>
    <action>Delete the two StoreContract.run tests written against the cases signature: "builds a fresh layer for every case…" and "reports a failing case…". Ticket 04's runSuite tests already cover both assertions. Add the tests above. Use a recording framework whose describe runs its body and whose it collects promises, as the file already defines. They fail now: run has the old signature, and there are no Suites or suites.</action>
    <verify><automated>! pnpm exec vitest run packages/test/test/StoreContract.test.ts   # RED until Task 2</automated></verify>
    <acceptance_criteria>The new tests fail for missing exports or the wrong signature.</acceptance_criteria>
    <done>The mode runner is specified.</done>
  </task>

  <task type="tdd">
    <name>Task 2 (GREEN): Suites, suites, Mode, run in src</name>
    <files>packages/test/src/StoreContract.ts</files>
    <read_first>packages/test/test/support/storeContract.ts lines 40-90 (EncryptionLive, addUserFieldColumns, sqlStores); packages/test/src/RecordsContract.ts migratedClient, runClosed and the coverage it; packages/core/src/Persistence.ts; packages/sql/src/CoreStoresSql.ts</read_first>
    <action>Delete the old run (adapter, layer, cases). Add a Suites interface with six keys: auditLog, verification, accounts, users, sessions and relayCursor. Ticket 10 adds rateLimiterStore. Each key holds the Suite of its port. Add suites, an object of the six re-exported suites written with satisfies Suites, not a type annotation. Add Mode as in PLAN.md §3.3: memory, or sql or sealed with a label and a client of type Layer of SqlClient.SqlClient with unknown error. Add run(framework, mode).

    Memory mode: the bundle per case is Persistence.memory. For every suite, call framework.describe with "StoreContract: <PortName> (Ref)"; take PortName from the suite's store key after the last slash. Register its entries and exemptions as runSuite does: reuse a private helper both share, not a copy. Then register one it named "every core store Persistence.memory provides has a suite". It builds Persistence.memory scoped, reads the context's keys (Context's mapUnsafe keys, as RecordsContract's keysOf does), removes SqlTransaction.SqlTransaction.key, and fails, naming the keys, if the key set differs from the suites' store keys.

    SQL mode: the per-case bundle is CoreStoresSql.layer() over a base. The base is the client, with core migrations run (Migrator.make({}) with loader CoreMigrations.coreMigrations), then the three ALTER TABLE users ADD COLUMN statements for contract_text, contract_real and contract_flag, with the dialect types the support file uses. Move that function as is, next to userFieldColumns' re-export. TestEncryption.layer is provided beneath the bundle, and SqlClient stays in the output so sql cases can read it. Register every suite's entries and its sql cases under "StoreContract: <PortName> (<label>)".

    Sealed mode: the same base with CoreStoresSql.layer({ encryptPii: true }), running only users and sessions. Write the pair as one constant with a comment saying these are the ports encryptPii changes (CoreStoresSql.ts:58-62).

    Every case in every mode gets TestClock.layer() through the helper it shares with runSuite (ticket 04).

    No as, no return-type annotations on Effect or Layer consts. Update the file header: StoreContract owns its runner (plan 37); a third party runs one suite on its own adapter with runSuite.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.test.ts packages/test/test/StoreContract.types.test.ts</automated></verify>
    <acceptance_criteria>Task 1's tests pass. `grep -c 'ALTER TABLE users ADD COLUMN' packages/test/src/StoreContract.ts` is 3 (baseline 0). `grep -c 'TestEncryption.layer' packages/test/src/StoreContract.ts` is at least 1 (baseline 0).</acceptance_criteria>
    <done>The modes live in src.</done>
  </task>

  <task type="auto">
    <name>Task 3: one call per runner file; support reduced</name>
    <files>packages/test/test/support/storeContract.ts, packages/test/test/StoreContract.memory.test.ts, packages/test/test/StoreContract.sql.test.ts, packages/test/test/StoreContract.file.test.ts, packages/test/test/StoreContract.libsql.test.ts, packages/test/test/StoreContract.sealed.test.ts</files>
    <read_first>the five runner files; packages/test/test/support/storeContract.ts</read_first>
    <action>In the support file, delete EncryptionLive, addUserFieldColumns, sqlStores, runOnMemory, runOnSql and runSealedOnSql, and every import they alone used. Export framework, which is the existing framework const with the 60 s it timeout, and keep walFileClient and libsqlFileClient. Rewrite the header: the vitest TestFramework and the two file-backed clients the runner files pass to StoreContract.run. Each runner file becomes one StoreContract.run call with its existing header comment kept. memory: { mode: "memory" }. sql: { mode: "sql", label: "SQL", client: TestSql.layer("store_contract") }. file: { mode: "sql", label: "SQLite WAL file", client: walFileClient }. libsql: { mode: "sql", label: "libSQL file", client: libsqlFileClient }. sealed: { mode: "sealed", label: "SQL", client: TestSql.layer("store_contract_sealed") }. The test names keep their "StoreContract: <Port> (<label>)" prefix, and the sealed ones become "(SQL)" under the sealed file. Record the before and after describe titles in Comments.</action>
    <verify><automated>pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts packages/test/test/StoreContract.sealed.test.ts packages/test/test/StoreContract.test.ts &amp;&amp; test "$(grep -rlE 'runOnMemory|runOnSql|runSealedOnSql' packages/test/test | wc -l | tr -d ' ')" -eq 0 &amp;&amp; test "$(wc -l &lt; packages/test/test/support/storeContract.ts)" -le 70</automated></verify>
    <acceptance_criteria>Files naming the old runners: 6 → 0. Support file lines: 201 → 70 or fewer. All six files pass, and the memory run counts at least the cases it counted after ticket 08, plus 1 (the coverage it).</acceptance_criteria>
    <done>A runner is one line; the bar is the shipped bundle.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
If a Postgres is reachable: pnpm test:pg packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.sealed.test.ts (TestClock with TestSql; PLAN.md §7 risk 1). Otherwise report Postgres unavailable.
</verification>

<success_criteria>
- `StoreContract.run(framework, mode)` is the only runner; `runSuite` is the one-adapter form.
- Support file ≤ 70 lines (201 at HEAD); 0 files name the old runners (6 at HEAD).
- The coverage test passes in memory mode.
- If a core case breaks under `TestClock`, fall back per PLAN.md §7 risk 1 and record it in the plan's Decisions taken.
</success_criteria>

## Comments

Done (uncommitted). `StoreContract.run(framework, mode)` (memory | sql | sealed) lives in `src/StoreContract.ts` with `Suites`, `suites`, `Mode`; `runSuite` and `run` share one private `registerSuite`/`registerCase`. Old `run(adapter, layer, cases)` and `RunConfig` removed. Support file 201 -> 45 lines (`framework`, `walFileClient`, `libsqlFileClient`); the five runner files are one `run` call each; files naming `runOnMemory|runOnSql|runSealedOnSql`: 6 -> 0. Describe titles: memory unchanged ("X (Ref)"); SQL unchanged; sealed "UserStore (SQL, encryptPii)" -> "UserStore (SQL)". Memory mode uses `Persistence.memory` (bundle, not per-port layers) plus a coverage `it`. Deviations: (a) coverage excludes `Layer.CurrentMemoMap` as well as `SqlTransaction`; (b) cases run on `Layer.provideMerge(layer, TestClock.layer())` so the bundle builds under TestClock (needed in ticket 10 so the SQL sweeper sees it); (c) a Registrable shape is used for the runners since `Suite` is invariant. Q5/Q7/Q8 defaults taken. Typecheck, tsconfig.test and the six StoreContract test files green. Postgres (test:pg) not run.
