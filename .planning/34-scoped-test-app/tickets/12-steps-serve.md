---
plan: 34-scoped-test-app
ticket: 12
title: Steps onto `serve` (Composition, TestingHarnessCompose, UserAgent)
type: execute
wave: 2
depends_on: [03]
files_modified:
  - features/step-definitions/CompositionSteps.ts
  - features/step-definitions/TestingHarnessComposeSteps.ts
  - features/step-definitions/UserAgentSteps.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "The three steps files build every TestAuth app with TestAuth.serve (Effect step bodies) or TestAuth.withApp (async callbacks); none disposes by hand"
    - "02-plugin-composition-validate, 25-testing-harness, 24-nextjs-ssr pass with unchanged counts; guard 0/0"
  artifacts:
    - path: features/step-definitions/TestingHarnessComposeSteps.ts
  key_links:
    - from: "step body"
      to: "scenario scope"
      via: "M6"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Migrate the three steps files that build apps inline and release them inline (PLAN §2.3 F2: `CompositionSteps.ts:896`, `TestingHarnessComposeSteps.ts:107,129,167-168,203`, `UserAgentSteps.ts:43,85`). Recipe M6 for Effect step bodies, M2 for code that is a plain `async` callback.

Purpose: the inline idiom disappears; the scenario scope owns every app.

Output: three files with 0 `TestAuth.app(` and 0 `app.dispose()`.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§4.2 M2/M6)
@packages/test/src/TestAuth.ts (serve, withApp)
@features/step-definitions/CompositionSteps.ts (:855-900)
@features/step-definitions/TestingHarnessComposeSteps.ts (:35-210)
@features/step-definitions/UserAgentSteps.ts (:25-90; :160-180 is a hand toWebHandler, out of scope)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): TestingHarnessComposeSteps (10 sites)</name>
  <files>features/step-definitions/TestingHarnessComposeSteps.ts</files>
  <read_first>features/step-definitions/TestingHarnessComposeSteps.ts:35-210</read_first>
  <action>Each step that does `const app = TestAuth.app(…)` … `yield* Effect.promise(() => app.dispose())` becomes `const app = yield* TestAuth.serve(…)` with the dispose deleted (M6). The memory/sql pair at `:160-168` becomes two `serve`s.

The helper typed `Pick<ReturnType<typeof TestAuth.app>, "signIn">` (`:42`) becomes `Pick<TestAuth.App<…>, "signIn">`. Keep the step texts unchanged.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/08-tooling/25-testing-harness.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; grep -c 'TestAuth\.app\b\|\.dispose()' features/step-definitions/TestingHarnessComposeSteps.ts returns 0, excluding the line-2 header comment, which must be reworded to name `TestAuth.serve` (baseline at HEAD: 12, including the header comment and the `:42` type use).</acceptance_criteria>
  <done>The harness feature's own steps use the scoped form.</done>
</task>

<task type="auto">
  <name>Task 2: CompositionSteps and UserAgentSteps</name>
  <files>features/step-definitions/CompositionSteps.ts, features/step-definitions/UserAgentSteps.ts</files>
  <read_first>features/step-definitions/CompositionSteps.ts:855-900, features/step-definitions/UserAgentSteps.ts:25-90</read_first>
  <action>`CompositionSteps.ts:865-896` uses `await app.dispose()` inside an async block. If the enclosing step body is an Effect generator, use M6. If it is an async callback (`Effect.promise(async () => …)`), use M2: `await TestAuth.withApp(layer, undefined, async (app) => …)`.

`UserAgentSteps.ts:43,85`: same choice. Leave the hand `HttpRouter.toWebHandler(ActionLayer)` at `:164-179` unchanged (non-goal, PLAN §1.3). Do not touch the raw `toWebHandler` sites in `CompositionSteps.ts:229,237,455,477`.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/00-foundations/02-plugin-composition-validate.steps.test.ts features/07-client-integration/24-nextjs-ssr.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; grep -c 'TestAuth\.app(\|app\.dispose()' returns 0 for both files (baseline at HEAD: CompositionSteps 2, UserAgentSteps 4).</acceptance_criteria>
  <done>No inline lifetime idiom remains in features for TestAuth apps.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Three feature files green with unchanged counts; guard 0/0.
</success_criteria>

## Comments
Result: guard apps=0 on 25, 02, 24; no TestAuth.app or app.dispose left in the three files (UserAgentSteps' hand toWebHandler untouched).
