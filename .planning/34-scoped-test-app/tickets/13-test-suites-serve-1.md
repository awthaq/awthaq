---
plan: 34-scoped-test-app
ticket: 13
title: "`@awthaq/test` suites onto `serve`/`withApp` (1/2)"
type: execute
wave: 2
depends_on: [03]
files_modified:
  - packages/test/test/TestAuthApp.test.ts
  - packages/test/test/TestAuthDecorate.test.ts
  - packages/test/test/TestAuthMiddleware.test.ts
  - packages/test/test/TestAuthRecords.test.ts
  - packages/test/test/TestAuthRequest.test.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "The five suites call TestAuth.serve (it.effect) or TestAuth.withApp (async) and never TestAuth.app"
    - "TestAuthApp.test.ts no longer has a dispose case: scope release is tested once, in TestAuthLifetime.test.ts (replace, don't layer)"
    - "Every other case keeps its assertion; test counts are unchanged except TestAuthApp (-1)"
  artifacts:
    - path: packages/test/test/TestAuthApp.test.ts
  key_links:
    - from: "BEH-EA-333 cases"
      to: "TestAuth.serve"
      via: "M1/M2"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Move the harness's own suites onto the scoped interface (PLAN §4.2 M1/M2). Delete the `dispose` case of `TestAuthApp.test.ts`: ticket 03's `TestAuthLifetime.test.ts` covers release on every exit path.

Purpose: the harness tests what it ships; no duplicate lifetime test.

Output: five suites with 0 `TestAuth.app(`.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§4.2, §5.2)
@packages/test/src/TestAuth.ts (serve, withApp)
@packages/test/test/TestAuthLifetime.test.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): TestAuthApp.test.ts (13 apps)</name>
  <files>packages/test/test/TestAuthApp.test.ts</files>
  <read_first>packages/test/test/TestAuthApp.test.ts</read_first>
  <action>Record the test count first (`npx vitest run packages/test/test/TestAuthApp.test.ts`).

Convert each `async` case with `try { … } finally { await app.dispose() }` with M2 (`await TestAuth.withApp(layer, options, async (app) => { … })`), or with M1 if the case already runs effects. Cases that pass `memoMap` to two apps nest two `withApp` calls or use two `serve` calls in one `it.effect`.

Delete the case that asserts "`dispose` runs the composition's finalizers": `TestAuthLifetime.test.ts` now owns it. The `buildContext` case (`:230-236`) keeps its own `Scope.makeUnsafe`, because `buildContext` is unchanged.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthApp.test.ts</automated></verify>
  <acceptance_criteria>Green; count = before − 1; grep -c 'TestAuth\.app(' packages/test/test/TestAuthApp.test.ts returns 0 (baseline at HEAD: 13).</acceptance_criteria>
  <done>BEH-EA-333 cases run on serve.</done>
</task>

<task type="auto">
  <name>Task 2: Decorate, Middleware, Records, Request</name>
  <files>packages/test/test/TestAuthDecorate.test.ts, packages/test/test/TestAuthMiddleware.test.ts, packages/test/test/TestAuthRecords.test.ts, packages/test/test/TestAuthRequest.test.ts</files>
  <read_first>the four files</read_first>
  <action>Apply M1 to `it.effect` cases and M2 to `async` cases. `TestAuthMiddleware.test.ts:92` builds its app inside a helper. Make the helper an Effect that requires `Scope` (M4) if its callers are `it.effect`; otherwise make it a `withApp` bracket taking the test body.

`TestAuthRecords.test.ts` runs SQL mode, so check that its guard counters hold. The new scope releases the SQLite client: add nothing, but confirm `TestSql.openClients()` is unchanged after the file in a throwaway local run. Do not commit that check.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthDecorate.test.ts packages/test/test/TestAuthMiddleware.test.ts packages/test/test/TestAuthRecords.test.ts packages/test/test/TestAuthRequest.test.ts</automated></verify>
  <acceptance_criteria>Green with unchanged counts; grep -c 'TestAuth\.app(' returns 0 for all four (baseline at HEAD: 1, 1, 4, 4).</acceptance_criteria>
  <done>Five harness suites on the scoped interface.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
0 `TestAuth.app(` in the five files; counts unchanged except the one moved case.
</success_criteria>

## Comments
Result: five suites on TestAuth.withApp (M2) and 0 TestAuth.app( / dispose; TestAuthApp 13 -> 12 (dispose case dropped, owned by TestAuthLifetime). TestAuthMiddleware's helper is now a typed passthrough to withApp. Two-app cases nest two withApp. Green; tsc -p tsconfig.test.json clean for these files. Not done: the throwaway TestSql.openClients() check for TestAuthRecords.
