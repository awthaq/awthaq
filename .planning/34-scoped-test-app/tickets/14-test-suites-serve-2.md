---
plan: 34-scoped-test-app
ticket: 14
title: "`@awthaq/test` suites and examples onto `serve`/`withApp` (2/2)"
type: execute
wave: 2
depends_on: [03]
files_modified:
  - packages/test/test/TestAuthServices.test.ts
  - packages/test/test/TestAuthHost.test.ts
  - examples/plugin-template/test/Template.test.ts
  - examples/sql-server/test/smoke.test.ts
  - examples/memory-server/test/smoke.test.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "The five files call TestAuth.serve or withApp, never TestAuth.app"
    - "examples/memory-server's module-level app becomes per-test (M3)"
    - "Test counts unchanged; wall time of the memory-server smoke ≤ +20% (R4)"
  artifacts:
    - path: examples/plugin-template/test/Template.test.ts
      provides: "the worked example docs/plugin-authoring.md points to, on the scoped interface"
  key_links:
    - from: "docs/plugin-authoring.md (ticket 22)"
      to: "examples/plugin-template/test/Template.test.ts"
      via: "the documented pattern"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Finish the harness's suites and move the three example suites (PLAN §4.2 M1–M3). The plugin template is what plugin authors copy, so it shows the scoped form.

Purpose: the worked example teaches the new lifetime.

Output: five files with 0 `TestAuth.app(`.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§4.2 M1–M3, §7 R4)
@packages/test/src/TestAuth.ts (serve, withApp)
@examples/plugin-template/test/Template.test.ts (:84-110)
@examples/sql-server/test/smoke.test.ts (:55-100)
@examples/memory-server/test/smoke.test.ts (:40-80; module-level app at :48)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): plugin template (SQL + memory loop)</name>
  <files>examples/plugin-template/test/Template.test.ts, packages/test/test/TestAuthServices.test.ts, packages/test/test/TestAuthHost.test.ts</files>
  <read_first>the three files</read_first>
  <action>`Template.test.ts:89-110` builds an app per record mode in a `for (const records of TestAuth.recordModes)` loop and disposes it. Use M1 where the case is `it.effect` and M2 where it is `async`; keep the loop.

Do the same in `TestAuthServices.test.ts` and `TestAuthHost.test.ts`. `TestAuthHost.test.ts` runs under `pnpm test:pg` (listed in `scripts/test-pg.sh`; do not edit that file).</action>
  <verify><automated>npx vitest run examples/plugin-template/test/Template.test.ts packages/test/test/TestAuthServices.test.ts packages/test/test/TestAuthHost.test.ts</automated></verify>
  <acceptance_criteria>Green, counts unchanged; grep -c 'TestAuth\.app(' returns 0 for all three (baseline at HEAD: 2, 2, 2).</acceptance_criteria>
  <done>The template shows the scoped form.</done>
</task>

<task type="auto">
  <name>Task 2: example smoke tests (one module-level app)</name>
  <files>examples/sql-server/test/smoke.test.ts, examples/memory-server/test/smoke.test.ts</files>
  <read_first>both files</read_first>
  <action>Record each file's wall time first (`time npx vitest run <file>`).

`memory-server/test/smoke.test.ts:48` keeps one app at module level for every test. Apply M3: each test acquires its own (M2 `withApp`, or M1). If a test depended on state another test left, make it arrange that state, and say so in Comments.

`sql-server/test/smoke.test.ts:60` builds its app inside a helper with try/finally; apply M2. Its other `.dispose()` calls belong to non-TestAuth handles (check): leave those.</action>
  <verify><automated>npx vitest run examples/sql-server/test/smoke.test.ts examples/memory-server/test/smoke.test.ts</automated></verify>
  <acceptance_criteria>Green, counts unchanged; grep -c 'TestAuth\.app(' returns 0 for both (baseline at HEAD: 1, 1); wall time recorded before and after in Comments, ≤ +20%.</acceptance_criteria>
  <done>No module-level app in the examples.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
0 `TestAuth.app(` in the five files; counts unchanged; timing within R4.
</success_criteria>

## Comments
Result: Services, Host, Template, sql-server and memory-server smoke on withApp (M2/M3); 0 TestAuth.app( / dispose. memory-server's module-level app is now per test (no state dependence found; tests use distinct emails). Template's three describe-level apps are per case. sql-server's boot() is now a bracket boot(env, use). Green (memory-server 5, sql-server 4). Wall time before/after NOT recorded (files were converted before timing; after: memory-server ~1.7s, sql-server ~1.4s total vitest duration). Helper also fixed "Template.test.ts" formatting with oxfmt.
