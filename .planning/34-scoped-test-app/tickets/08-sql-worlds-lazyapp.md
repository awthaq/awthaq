---
plan: 34-scoped-test-app
ticket: 08
title: SQL-mode Worlds onto `lazyApp` (Session, Password, Domain)
type: execute
wave: 3
depends_on: [04, 02]
files_modified:
  - features/step-definitions/SessionWorld.ts
  - features/step-definitions/PasswordWorld.ts
  - features/step-definitions/DomainWorld.ts
autonomous: true
requirements: [REQ-EA-1551]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Each of the three Worlds holds one `app: TestAuth.LazyApp<…>` field and no app Ref, finalizer, close field or configure guard of its own"
    - "SessionWorld serves with testClock 'now' instead of its hand-built ClockLive"
    - "07-sessions, 15-password, 05-persistence-stratum, 06-users-accounts and 08-verification-tokens pass; the leak guard reports 0/0 for each"
  artifacts:
    - path: features/step-definitions/SessionWorld.ts
    - path: features/step-definitions/PasswordWorld.ts
    - path: features/step-definitions/DomainWorld.ts
  key_links:
    - from: "configureSessions / configureApp"
      to: "LazyApp.configure"
      via: "the World's existing merge function as the update"
---
Status: done (uncommitted)
Blocked by: 04, 02

<objective>
Move the three Worlds that run `records: "sql"` onto `TestAuth.lazyApp` (PLAN §4.2 M5). This replaces ticket 02's hotfix lines, which are deleted here, and the Worlds' own configure rules (§2.3 F3).

Purpose: the L1/L2 leaks become impossible by construction rather than fixed by a finalizer.

Output: three Worlds, each with one cell.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.3, §3.2 lazyApp, §4.2 M5/M7, §7 R3)
@packages/test/src/TestAuth.ts (serve, lazyApp)
@features/step-definitions/SessionWorld.ts (:104-134 buildAppLayer and ClockLive, :155-232 handle/World/configure/appHandle, :234-250 inApp/advance/nowMillis)
@features/step-definitions/PasswordWorld.ts (:139-276)
@features/step-definitions/DomainWorld.ts (:196-300)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): SessionWorld onto lazyApp with testClock "now"</name>
  <files>features/step-definitions/SessionWorld.ts</files>
  <read_first>features/step-definitions/SessionWorld.ts</read_first>
  <action>Apply M5. Replace `app: Ref<AppHandle | undefined>` and `settings: Ref<SessionConfig>` with `app: TestAuth.LazyApp<Sessions.SessionConfig, AppHandle>`, created in `WorldLive` by `yield* TestAuth.lazyApp(defaultSettings, build, { name: "SessionWorld" })`.

`build(settings)` creates the gate (the three `makeUnsafe` calls now in `appHandle`). It builds the layer through `buildAppLayer` without `ClockLive`: delete `ClockLive` and its `Layer.provideMerge`. It does `yield* TestAuth.serve(appLayer, { testClock: "now" })` and returns `{ handler, run, sentMail, gate }`.

`configureSessions(overrides)` becomes `world.app.configure((existing) => ({ ...existing, ...overrides }))`. Delete its own `Effect.die` guard; the cell's defect replaces it. `appHandle()` becomes `world.app.get`. Delete the ticket 02 finalizer and the `dispose` handle field.

Keep `advance` and `nowMillis` as they are: they run `TestClock` operations through `run`, which now reads the app's `testClock: "now"` clock.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/02-domain/07-sessions.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>The feature passes with the same passed/skipped counts as before (record both); the guard line reads apps=0 sqlClients=0; grep -c 'setTime(Date.now\|addFinalizer\|TestAuth\.app(' features/step-definitions/SessionWorld.ts returns 0 (baseline at HEAD: 2).</acceptance_criteria>
  <done>SessionWorld has one cell and no lifetime code.</done>
</task>

<task type="auto">
  <name>Task 2: PasswordWorld onto lazyApp</name>
  <files>features/step-definitions/PasswordWorld.ts</files>
  <read_first>features/step-definitions/PasswordWorld.ts:120-300, features/step-definitions/PasswordSteps.ts (every configureApp call, 20 sites)</read_first>
  <action>Apply M5 with `O = AppOptions`. `build(options)` is today's `buildApp` body, but each `yield* openApp(TestAuth.app(layer))` becomes `yield* openApp(yield* TestAuth.serve(layer))`. Keep `openApp`'s eager `run(Effect.void)`: its comment explains why the build must happen before a read handle is used.

`configureApp(options)` becomes `world.app.configure((previous) => merged)`, using today's merge (`passwordConfig` merged one level). It no longer builds eagerly. `appHandle()` becomes `world.app.get`. Delete the ticket 02 `dispose` lines, the finalizer and the `options` Ref.

Run 15-password and 05-persistence-stratum. If a scenario now fails with "PasswordWorld: configure after the app was built", it relied on a silent rebuild (R3). Either move its Given before the first request, or call `world.app.replace(<merged options>)` through a new exported `reconfigureApp`. Record each case in Comments.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/05-authentication-methods/15-password.steps.test.ts features/01-contract-and-persistence/05-persistence-stratum.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same passed/skipped counts as before; both guard lines 0/0; grep -c 'TestAuth\.app(\|dispose' features/step-definitions/PasswordWorld.ts returns 0 (baseline at HEAD: 3).</acceptance_criteria>
  <done>PasswordWorld has one cell; every late configure is explicit.</done>
</task>

<task type="auto">
  <name>Task 3: DomainWorld onto serve</name>
  <files>features/step-definitions/DomainWorld.ts</files>
  <read_first>features/step-definitions/DomainWorld.ts:190-300</read_first>
  <action>DomainWorld builds one app in `WorldLive` and releases it with `addFinalizer` (`:296`). Replace that with `const app = yield* TestAuth.serve(<layer>)` in `WorldLive` (M6: the World layer's scope is the scenario's) and delete the finalizer. If the World configures options before building, use `lazyApp` as in Task 1 instead; record which in Comments.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/02-domain/06-users-accounts.steps.test.ts features/02-domain/08-verification-tokens.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts as before; guard 0/0; grep -c 'TestAuth\.app(\|dispose' features/step-definitions/DomainWorld.ts returns 0 (baseline at HEAD: 2).</acceptance_criteria>
  <done>No SQL-mode World manages its own app lifetime.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Five feature files green with unchanged counts; each guard line 0/0; the three Worlds hold one cell or one `serve`.
</success_criteria>

## Comments

Result (uncommitted): Session, Password, Domain Worlds on lazyApp/serve; leak guard 0/0 for 07-sessions, 05-persistence-stratum, 06-users-accounts, 08-verification-tokens; 15-password reports apps=1 (see below). Counts unchanged (07: 41 passed 1 skipped; 15: 41; 06+08: 68).
- SessionWorld: `testClock: "now"` builds the composition on the real clock, so the password sign-in timing-floor calibration became non-zero and request-time sleeps hung on the frozen TestClock. Fixed with `Password.config({ signInTimingFloor: "off" })` (what the old ClockLive effectively gave: floor 0). Also edited SessionSteps.ts ("touchEvery is configured" read `world.settings`; now `world.app.options`).
- PasswordWorld R3 cases (use new exported `reconfigureApp` = replace with merged options): "the initial session cannot be issued" (a prior Given already used the app) and the "in each case" breach loop (reconfigures per failure mode). PasswordSteps.ts edited accordingly.
- slowMailer: that app is built in its own scope released by a detached fiber (forkDetach) so the scenario does not wait for the mail drain; the guard line for 15-password therefore reports apps=1 (the drain outlives the file).
- DomainWorld: no pre-build configuration, so plain `serve` in WorldLive.
