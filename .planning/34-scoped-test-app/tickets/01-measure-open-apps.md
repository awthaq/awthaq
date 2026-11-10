---
plan: 34-scoped-test-app
ticket: 01
title: Measure open apps and SQL clients per feature file
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/test/src/TestSql.ts
  - packages/test/src/TestAuth.ts
  - packages/test/test/TestAuthLifetime.test.ts
  - features/step-definitions/shared/LeakGuard.ts
  - features/vitest.config.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "TestSql.openClients() counts SqlClient layers built by TestSql.layer and not yet released, on SQLite and on Postgres alike"
    - "TestAuth.openApps() counts TestAuth.app instances created and not yet disposed"
    - "After every feature file, pnpm test:bdd prints one '[leak-guard] <file> apps=<n> sqlClients=<m>' line to stderr and does not fail (report mode)"
    - "The baseline per feature file is recorded in this ticket's Comments"
  artifacts:
    - path: packages/test/src/TestSql.ts
      provides: "export const openClients"
    - path: packages/test/src/TestAuth.ts
      provides: "export const openApps"
    - path: features/step-definitions/shared/LeakGuard.ts
      provides: "afterAll reporter; enforce when AWTHAQ_LEAK_GUARD=enforce"
    - path: packages/test/test/TestAuthLifetime.test.ts
  key_links:
    - from: features/vitest.config.ts
      to: features/step-definitions/shared/LeakGuard.ts
      via: "test.setupFiles"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Turn the suspected leak (PLAN §2.5, L1–L3) into numbers before anything changes. Add two process-local counters: open `TestSql` clients (dialect-independent, so SQLite reproduces the Postgres pool leak's shape) and open `TestAuth.app` instances (memory mode too). Add a `features` setup file that reports both after every feature file.

Purpose: decide Q8 (ship hotfix 02 or not) on evidence, and give ticket 21 the guard it switches to enforcing.

Output: two counters, one package test proving them, one report-mode guard, and the recorded baseline.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.5, §3.2 openApps/openClients, §5.3)
@packages/test/src/TestSql.ts (layer at :129-134, postgres at :60-84)
@packages/test/src/TestAuth.ts (app at :616-746, dispose at :734-738)
@packages/test/test/TestAuthApp.test.ts (style of an app test)
@features/vitest.config.ts
@features/node_modules/@effect-cucumber/vitest/README.md (:93-105, per-scenario layer scope)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: counters in TestSql and TestAuth, proved by a package test</name>
  <files>packages/test/src/TestSql.ts, packages/test/src/TestAuth.ts, packages/test/test/TestAuthLifetime.test.ts</files>
  <read_first>packages/test/src/TestSql.ts, packages/test/src/TestAuth.ts:607-746</read_first>
  <behavior>
    - Test A: openClients() is k before; after one POST through TestAuth.app(TestAuth.layer(Auth.make([Pins]), { records: "sql", suite: "test_lifetime" })) it is k+1; after await app.dispose() it is k again.
    - Test B: openApps() is k before TestAuth.app(...), k+1 after, k after dispose.
  </behavior>
  <action>Write the test file first, red, using the `Pins` fixture from `packages/test/test/support/Pins.ts` and async `it` with try/finally like `TestAuthApp.test.ts`. Read the counters before and after rather than asserting absolute values, because other tests in the same file may hold apps.

In `TestSql.ts`, keep a module-level `let open = 0`. Export `openClients`, a function of no arguments returning `open`. Make `layer(suite)` merge its client layer with a fresh `Layer.effectDiscard(Effect.acquireRelease(Effect.sync(() => { open++ }), () => Effect.sync(() => { open-- })))`, created inside `layer` so that every build counts once. `layer`'s output type must stay `Layer.Layer<SqlClient.SqlClient, …>`: use `Layer.merge` and keep `asSqlClient`.

In `TestAuth.ts`, keep a module-level `let openAppCount = 0`. Export `openApps`, a function returning it. Increment in `app()` right after the scope is created, and decrement at the end of `dispose`.

Comment each counter in one line: measurement for the leak guard (plan 34). No other behaviour changes.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthLifetime.test.ts</automated></verify>
  <acceptance_criteria>grep -c 'export const openClients' packages/test/src/TestSql.ts returns 1 (baseline at HEAD: 0); grep -c 'export const openApps' packages/test/src/TestAuth.ts returns 1 (baseline: 0); both tests pass.</acceptance_criteria>
  <done>Both counters exist and the test proves they return to their prior value after dispose.</done>
</task>

<task type="auto">
  <name>Task 2: the report-mode leak guard for features</name>
  <files>features/step-definitions/shared/LeakGuard.ts, features/vitest.config.ts</files>
  <read_first>features/vitest.config.ts, features/step-definitions/shared/Harness.ts (import style)</read_first>
  <action>Create `LeakGuard.ts` as a vitest setup file. It imports `afterAll` from `vitest` and `TestAuth` and `TestSql` from `@awthaq/test`. It registers one `afterAll` whose listener takes the vitest arguments (context, suite). It reads the file name from `suite.file.filepath`, relative to `process.cwd()`, and reads `TestAuth.openApps()` and `TestSql.openClients()`. It then writes exactly one line, `[leak-guard] <file> apps=<n> sqlClients=<m>`, to `process.stderr`.

When `process.env["AWTHAQ_LEAK_GUARD"] === "enforce"` and either count is above 0, it throws an Error carrying the same text. Ticket 21 makes enforce the default.

Add `setupFiles: ["./step-definitions/shared/LeakGuard.ts"]` to `test` in `features/vitest.config.ts`, with a one-line comment naming plan 34. Do not change `include`, `testTimeout` or `tags`.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/02-domain/07-sessions.steps.test.ts 2>&1 | grep -c '\[leak-guard\]'</automated></verify>
  <acceptance_criteria>The command prints 1. The run stays green. grep -c 'setupFiles' features/vitest.config.ts returns 1 (baseline at HEAD: 0).</acceptance_criteria>
  <done>Every feature file reports its open apps and SQL clients, and nothing fails.</done>
</task>

<task type="auto">
  <name>Task 3: record the baseline (and the Postgres view when reachable)</name>
  <files>(none: Comments of this ticket)</files>
  <read_first>.planning/34-scoped-test-app/PLAN.md §2.5, §5.4</read_first>
  <action>Run `pnpm test:bdd 2>&1 | grep '\[leak-guard\]' | sort` and paste the lines with a non-zero count into this ticket's Comments as a table: file, apps, sqlClients. Record the wall time of `pnpm test:bdd`. Also record the wall time of `npx vitest run packages/password/test/AuthHttp.test.ts packages/oauth/test/AuthHttp.test.ts packages/organization/test/AuthHttp.test.ts`. These are R4's baselines.

If a Postgres server is reachable (do not start one; never edit `scripts/test-pg.sh`), run `AWTHAQ_POSTGRES_URL=<url> pnpm --filter @awthaq/features exec vitest run features/02-domain/07-sessions.steps.test.ts`. While it runs, and just before the worker exits (add a temporary `console.error` only in your shell session, not in a commit), take `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()`. Record the counts. If none is reachable, write "Postgres: not measured; CI's pnpm check is the evidence".

Then answer Q8 in Comments. Ticket 02 is needed if `07-sessions` or `15-password` shows sqlClients ≥ 1.</action>
  <verify><automated>pnpm test:bdd 2>&1 | grep -c '\[leak-guard\]'</automated></verify>
  <acceptance_criteria>The count equals the number of `*.steps.test.ts` files that ran (one line each); the Comments table exists with every non-zero row.</acceptance_criteria>
  <done>Baseline recorded; Q8 answered with the numbers.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
- Two exported counters, each covered by a passing test.
- `pnpm test:bdd` green, with one guard line per feature file.
- Baseline table and Q8 answer in Comments.
</success_criteria>

## Comments

Baseline at HEAD (apps / sqlClients left open after the file; SQLite): 04-contract-stratum 5/0; 05-persistence-stratum 1/1; 07-sessions 30/30; 09-authentication-middleware 2/0; 11-http-error-mapping 22/0; 15-password 47/3; 17-passkey 63/0; 27-admin-impersonation 37/0; 35-organization 68/0; 36-jwt 6/0; 34-webhooks 3/0. All others 0/0. `pnpm test:bdd` wall time about 9 s here either way. Postgres: not measured. Q8: ticket 02 is needed (07-sessions and 15-password have sqlClients >= 1).
