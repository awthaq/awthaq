---
plan: 34-scoped-test-app
ticket: 17
title: Plugin suites onto `serve` (scim, password, oauth, magic-link)
type: execute
wave: 2
depends_on: [03]
files_modified:
  - packages/scim/test/ScimHttp.test.ts
  - packages/scim/test/ScimBddRegressions.test.ts
  - packages/password/test/AuthHttp.test.ts
  - packages/oauth/test/AuthHttp.test.ts
  - packages/magic-link/test/AuthHttp.test.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "password (27 apps, 2 disposed) and oauth (12 apps, 1 disposed) release every app through it.effect's scope"
    - "magic-link's module-level testApp becomes per-test (M3)"
    - "Test counts unchanged; wall times within +20% (R4)"
  artifacts:
    - path: packages/password/test/AuthHttp.test.ts
    - path: packages/oauth/test/AuthHttp.test.ts
  key_links:
    - from: "it.effect body"
      to: "TestAuth.serve"
      via: "M1"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Migrate the two largest under-disposing suites (password 27 apps, oauth 12) and three smaller ones (PLAN §2.4). All five are mostly `it.effect` (M1).

Purpose: 41 app sites released by construction.

Output: 0 `TestAuth.app(` in the five files.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§4.2 M1/M3, §7 R4)
@packages/test/src/TestAuth.ts (serve)
@packages/password/test/AuthHttp.test.ts
@packages/oauth/test/AuthHttp.test.ts (:92 helper, :170-180)
@packages/magic-link/test/AuthHttp.test.ts (:23 module-level, :59, :105)
@packages/scim/test/ScimHttp.test.ts (:30)
@packages/scim/test/ScimBddRegressions.test.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): password/test/AuthHttp.test.ts</name>
  <files>packages/password/test/AuthHttp.test.ts</files>
  <read_first>packages/password/test/AuthHttp.test.ts</read_first>
  <action>Record count and wall time. Apply M1 at all 27 sites: `const app = TestAuth.app(X)` becomes `const app = yield* TestAuth.serve(X)`. Delete `yield* Effect.promise(() => app.dispose())` (`:188`) and the `Promise.all([busy.dispose(), other.dispose()])` (`:213`). If a site sits outside an `Effect.gen` (a plain helper), make the helper an Effect that requires `Scope` (M4).</action>
  <verify><automated>npx vitest run packages/password/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>Count unchanged; grep -c 'TestAuth\.app(\|\.dispose()' packages/password/test/AuthHttp.test.ts returns 0 (baseline at HEAD: 29); wall time ≤ +20%.</acceptance_criteria>
  <done>The biggest suite is on serve.</done>
</task>

<task type="auto">
  <name>Task 2: oauth and magic-link</name>
  <files>packages/oauth/test/AuthHttp.test.ts, packages/magic-link/test/AuthHttp.test.ts</files>
  <read_first>both files</read_first>
  <action>oauth: M1 at 12 sites. The helper at `:92` that returns `{ app, … }` becomes an Effect that requires `Scope` (M4). Delete `:172`'s `Promise.all([flow.app.dispose(), other.dispose()])`.

magic-link: `:23` `const testApp = TestAuth.app(AppLayer)` is module level. Apply M3: acquire per test with `serve`. Delete `:105`'s dispose.</action>
  <verify><automated>npx vitest run packages/oauth/test/AuthHttp.test.ts packages/magic-link/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(\|\.dispose()' returns 0 for both (baseline at HEAD: 13, 3).</acceptance_criteria>
  <done>oauth and magic-link migrated.</done>
</task>

<task type="auto">
  <name>Task 3: scim</name>
  <files>packages/scim/test/ScimHttp.test.ts, packages/scim/test/ScimBddRegressions.test.ts</files>
  <read_first>both files</read_first>
  <action>`ScimHttp.test.ts:30` builds the app in a helper used by `it.effect` cases: M4 (an Effect that requires `Scope`). Apply M1 in `ScimBddRegressions.test.ts`.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimHttp.test.ts packages/scim/test/ScimBddRegressions.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(\|\.dispose()' returns 0 for both (baseline at HEAD: 1, 2).</acceptance_criteria>
  <done>Five suites migrated.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
0 `TestAuth.app(` and 0 hand disposes in the five files; counts unchanged; timings recorded.
</success_criteria>

## Comments

Result: all five suites on serve; 0 `TestAuth.app(` and 0 `.dispose()`. password/oauth M1 (oauth `startFlow` and scim `buildApp` now require Scope); magic-link M3 via a per-test `makeHarness` Effect. Package suites green (password 180, oauth 227, magic-link 59, scim 173); counts unchanged.
