---
plan: 34-scoped-test-app
ticket: 11
title: Worlds and steps onto `lazyApp`/`serve` (Saml, NextSsr, React, BearerLifecycle, RequestContext)
type: execute
wave: 3
depends_on: [04]
files_modified:
  - features/step-definitions/SamlWorld.ts
  - features/step-definitions/NextSsrWorld.ts
  - features/step-definitions/ReactWorld.ts
  - features/step-definitions/BearerLifecycleSteps.ts
  - features/step-definitions/RequestContextSteps.ts
autonomous: true
requirements: [REQ-EA-1551]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "None of the five files calls TestAuth.app or disposes by hand"
    - "RequestContextSteps never releases an app itself (no `void …dispose()`); the scenario scope does"
    - "29-saml-sp, 24-nextjs-ssr, 23-react, 22-client-effect, 09-authentication-middleware pass with unchanged counts; guard 0/0"
  artifacts:
    - path: features/step-definitions/RequestContextSteps.ts
    - path: features/step-definitions/SamlWorld.ts
  key_links:
    - from: "RequestContextSteps Given 'a composition served…'"
      to: "TestAuth.serve in the scenario scope"
      via: "M6"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Migrate the remaining five feature files that release apps with the `close` field, `acquireRelease`, `Effect.ensuring` or an unawaited `void dispose()` (PLAN §2.3 F1/F2, L4).

Purpose: the last idioms of F2 disappear from `features/`, except ticket 12's three steps files.

Output: five files on `lazyApp` (Saml) or `serve` (the rest).
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.3, §2.9 L4, §4.2 M5/M6)
@packages/test/src/TestAuth.ts (serve, lazyApp)
@features/step-definitions/SamlWorld.ts (:205-340)
@features/step-definitions/NextSsrWorld.ts (:80-135)
@features/step-definitions/ReactWorld.ts (:110-135)
@features/step-definitions/BearerLifecycleSteps.ts (:40-60)
@features/step-definitions/RequestContextSteps.ts (:1-60)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): RequestContextSteps (module cell, unawaited dispose)</name>
  <files>features/step-definitions/RequestContextSteps.ts</files>
  <read_first>features/step-definitions/RequestContextSteps.ts</read_first>
  <action>Make the Given that serves (`serve(address)`, `:37-44`) an Effect step body: `observed = { app: yield* TestAuth.serve(makeLayer(address)) }`, where `makeLayer` is today's `makeApp` minus the `TestAuth.app` call. The scenario's scope (the step's ambient `Scope.Scope`) releases it.

Delete the `void previous.dispose()` line. `appOf` stays. Keep `observed` as the cell that carries the value between steps. Type `Observed.app` as `TestAuth.App<…>` (M7).</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/03-http-layer/09-authentication-middleware.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; grep -c 'TestAuth\.app(\|dispose' features/step-definitions/RequestContextSteps.ts returns 0 (baseline at HEAD: 2).</acceptance_criteria>
  <done>L4 fixed by construction.</done>
</task>

<task type="auto">
  <name>Task 2: SamlWorld (close field + finalizer) onto lazyApp</name>
  <files>features/step-definitions/SamlWorld.ts</files>
  <read_first>features/step-definitions/SamlWorld.ts:200-345</read_first>
  <action>Apply M5: `app: TestAuth.LazyApp<…>` with `name: "SamlWorld"`. `build` does `yield* TestAuth.serve(…)` and returns the handle without `close`. Delete the `close` field and the finalizer (`:331`). Keep the World's existing configure merge as the update.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/13-enterprise-federation/29-saml-sp.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; grep -c 'TestAuth\.app(\|\.dispose()\|close: Effect' features/step-definitions/SamlWorld.ts returns 0 (baseline at HEAD: 3).</acceptance_criteria>
  <done>SamlWorld on the cell.</done>
</task>

<task type="auto">
  <name>Task 3: NextSsr, React, BearerLifecycle onto serve</name>
  <files>features/step-definitions/NextSsrWorld.ts, features/step-definitions/ReactWorld.ts, features/step-definitions/BearerLifecycleSteps.ts</files>
  <read_first>the regions named in context</read_first>
  <action>Apply M6.
- **NextSsrWorld (`:97-99`) and ReactWorld (`:122-126`).** Replace `Effect.acquireRelease(Effect.sync(() => TestAuth.app(…)), (built) => Effect.promise(() => built.dispose()))` with `yield* TestAuth.serve(…)`. Keep any extra work the release did besides dispose; ReactWorld pipes something after `built.dispose()`, so keep it as an `Effect.addFinalizer`.
- **BearerLifecycleSteps (`:54`).** Replace `Effect.ensuring(Effect.promise(app.dispose))` with `yield* TestAuth.serve(…)` inside an `Effect.scoped` that bounds the same work.

Note: NextSsrWorld's second `TestAuth.app` is built "per scenario that needs it and disposed by that scenario" (`:132`). Both become `serve` in the scenario scope.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/07-client-integration/24-nextjs-ssr.steps.test.ts features/07-client-integration/23-react.steps.test.ts features/07-client-integration/22-client-effect.steps.test.ts 2>&1 | tail -25</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; grep -c 'TestAuth\.app(\|\.dispose()' returns 0 for NextSsrWorld.ts, ReactWorld.ts and BearerLifecycleSteps.ts (baseline at HEAD: 3, 2 and 1).</acceptance_criteria>
  <done>Five more files with no hand lifetime code.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Five feature files green with unchanged counts; guard 0/0; 0 hand disposes in the five files.
</success_criteria>

## Comments
Result: guard apps=0 on 29, 24, 23, 22, 09. Deviation: NextSsrSteps.ts joined (`yield* makeSecureDomainApp`, hand dispose deleted). SamlWorld keeps its config/preference/meeting Refs and their "configure before first request" guards; only the app lifetime moved onto lazyApp.
