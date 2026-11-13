---
plan: 34-scoped-test-app
ticket: 10
title: Worlds onto `lazyApp`/`serve` (Admin, HttpError, Passkey, Webhooks, ContractStratum)
type: execute
wave: 3
depends_on: [04]
files_modified:
  - features/step-definitions/AdminWorld.ts
  - features/step-definitions/HttpErrorWorld.ts
  - features/step-definitions/PasskeyWorld.ts
  - features/step-definitions/WebhooksWorld.ts
  - features/step-definitions/ContractStratumWorld.ts
autonomous: true
requirements: [REQ-EA-1551]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "None of the five files calls TestAuth.app; every app they build is released with its scenario"
    - "PasskeyWorld's 'replace' mode is LazyApp.replace (it releases the previous app); 'merge' is configure"
    - "27-admin-impersonation, 11-http-error-mapping, 17-passkey, 34-webhooks, 04-contract-stratum pass with unchanged counts; guard 0/0"
  artifacts:
    - path: features/step-definitions/PasskeyWorld.ts
      provides: "app: TestAuth.LazyApp<AppOptions, AppHandle>"
  key_links:
    - from: "PasskeySteps.ts:1146 configureApp(…, 'replace')"
      to: "LazyApp.replace"
      via: "PasskeyWorld.configureApp mode"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Migrate the five files in `features/` that never release a `TestAuth.app` (PLAN §2.3 F1, except Session and Password in ticket 08). Worlds with a cell take M5; Worlds that build per step take M6.

Purpose: close five of the seven never-dispose sites.

Output: five files with no `TestAuth.app` and no hand lifetime code.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.3 F1/F3, §4.2 M5/M6/M7)
@packages/test/src/TestAuth.ts (serve, lazyApp)
@features/step-definitions/AdminWorld.ts (:125-170)
@features/step-definitions/HttpErrorWorld.ts (:145-210; makeRuntimeAndRouted :203-207 stays: plan-08 exemption)
@features/step-definitions/PasskeyWorld.ts (:185-245)
@features/step-definitions/PasskeySteps.ts (:1120-1150, the "replace" caller)
@features/step-definitions/WebhooksWorld.ts (:255-340)
@features/step-definitions/ContractStratumWorld.ts (:160-195)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): PasskeyWorld, the one World that rebuilds on purpose</name>
  <files>features/step-definitions/PasskeyWorld.ts</files>
  <read_first>features/step-definitions/PasskeyWorld.ts:185-260, features/step-definitions/PasskeySteps.ts:1120-1150</read_first>
  <action>Apply M5 with `O = AppOptions`. `build(merged)` creates `webAuthnBehavior` and `verifyCalls` (today's `Ref.makeUnsafe` calls). It does `yield* TestAuth.serve(buildAppLayer(merged, …), { baseUrl: ORIGIN })` and returns `{ app, webAuthnBehavior, verifyCalls }`.

`configureApp(options, mode)`:
- `mode === "merge"` calls `world.app.configure((current) => ({ ...current, ...options }))`;
- `mode === "replace"` calls `world.app.replace(options)`. It releases the previous app, which today leaks.

`appHandle()` becomes `world.app.get`. `overrideWebAuthnBehavior` keeps working through `get`. Delete `appOptions` and the `app` Ref.

If a "merge" configure now arrives after a build (17 call sites in PasskeySteps), the defect names PasskeyWorld. Fix it as in R3, record it in Comments, and keep counts.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/05-authentication-methods/17-passkey.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same passed/skipped counts as before; guard 0/0; grep -c 'TestAuth\.app(' features/step-definitions/PasskeyWorld.ts returns 0 (baseline at HEAD: 1).</acceptance_criteria>
  <done>Passkey's explicit rebuild releases what it replaces.</done>
</task>

<task type="auto">
  <name>Task 2: AdminWorld and WebhooksWorld (one fixed app per scenario)</name>
  <files>features/step-definitions/AdminWorld.ts, features/step-definitions/WebhooksWorld.ts</files>
  <read_first>features/step-definitions/AdminWorld.ts:125-175, features/step-definitions/WebhooksWorld.ts:255-345</read_first>
  <action>AdminWorld builds lazily from options (`AdminWorld.ts:148` cell; `configureApp` in AdminSteps, 17 calls). WebhooksWorld builds from an `options` Ref (`:332-333`). Apply M5 to both: `build` does `yield* TestAuth.serve(…, { baseUrl: ORIGIN })` and returns today's handle.

`AdminWorld.ts:130` types a field as `TestAuth.App<AppServices>`; keep it (M7). Late configures follow R3.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/09-admin-and-impersonation/27-admin-impersonation.steps.test.ts features/15-webhooks/34-webhooks.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; grep -c 'TestAuth\.app(' returns 0 for both (baseline at HEAD: 1 and 1).</acceptance_criteria>
  <done>Admin and Webhooks on the cell.</done>
</task>

<task type="auto">
  <name>Task 3: HttpErrorWorld and ContractStratumWorld (per-step apps)</name>
  <files>features/step-definitions/HttpErrorWorld.ts, features/step-definitions/ContractStratumWorld.ts</files>
  <read_first>features/step-definitions/HttpErrorWorld.ts:145-215, features/step-definitions/ContractStratumWorld.ts:160-200</read_first>
  <action>Apply M6.
- **HttpErrorWorld.** `makeApp(appLayer)` (`:151-170`) becomes an Effect that requires `Scope`: `Effect.map(TestAuth.serve(appLayer), (app) => ({ …today's fields }))`. Its callers in `HttpErrorSteps.ts`/`HttpErrorWorld.ts` `yield*` it inside the step, so the scenario scope releases it. Leave `makeRuntimeAndRouted` (`:203-207`) unchanged: it is a plan-08 exemption (ManagedRuntime plus router on one memo map), and a non-goal here.
- **ContractStratumWorld.** Make `buildPasswordApp` and `buildCoreOnlyApp` Effects over `TestAuth.serve` in the same way, and `yield*` them where they are called.

If a caller in a steps file must change its call shape (`yield*` instead of a plain call), that steps file joins this ticket only if the ticket stays at ≤ 5 files. Otherwise wrap the Effect at the World boundary so that callers stay unchanged, and note the choice in Comments.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/03-http-layer/11-http-error-mapping.steps.test.ts features/01-contract-and-persistence/04-contract-stratum.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; grep -c 'TestAuth\.app(' returns 0 for both files (baseline at HEAD: 1 and 2).</acceptance_criteria>
  <done>No never-dispose site remains among these five.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Five feature files green with unchanged counts; guard 0/0 each; 0 `TestAuth.app(` in the five files.
</success_criteria>

## Comments
Result: Passkey/Admin/Webhooks/HttpError/ContractStratum migrated; guard apps=0 on 17, 27, 34, 11, 04. Deviations: HttpErrorSteps.ts (callers now `yield*` the app Effects) and PasskeyRegistrationSteps.ts (read `app.options` instead of the `appOptions` Ref) joined; PasskeySteps `registrationOptionsUnder` now uses `"replace"` (it rebuilt after use, an R3 defect). WebhooksWorld: only the HTTP app used `TestAuth.app`; it is `serve`d into the World scope (no lazyApp: two apps share one options Ref).
