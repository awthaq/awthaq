---
plan: 34-scoped-test-app
ticket: 02
title: "Hotfix: SessionWorld and PasswordWorld release their apps"
type: execute
wave: 0
depends_on: [01]
files_modified:
  - features/step-definitions/SessionWorld.ts
  - features/step-definitions/PasswordWorld.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "After 07-sessions, the leak guard reports apps=0 sqlClients=0"
    - "After 15-password and 05-persistence-stratum, the leak guard reports apps=0 sqlClients=0"
    - "No other behaviour of either World changes"
  artifacts:
    - path: features/step-definitions/SessionWorld.ts
      provides: "WorldLive finalizer that disposes the built app"
    - path: features/step-definitions/PasswordWorld.ts
      provides: "configureApp disposes the replaced app; WorldLive finalizer disposes the last"
  key_links:
    - from: "SessionWorld WorldLive (per-scenario layer)"
      to: "TestAuth.app dispose"
      via: "Effect.addFinalizer"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Stop the two SQL-mode Worlds from leaking a pool per scenario (PLAN §2.9, L1 and L2). This is the smallest fix that ships ahead of the refactor and does not depend on it. Ticket 08 later replaces both fixes with `TestAuth.lazyApp` and deletes these lines.

Purpose: on CI Postgres, `07-sessions` holds up to ~32 idle connections in one worker until it exits.

Output: two Worlds whose scenario scope releases every app they built.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.3 F1/F3, §2.9)
@features/step-definitions/SessionWorld.ts (:161-166 AppHandle, :189-205 WorldLive, :218-232 appHandle)
@features/step-definitions/PasswordWorld.ts (:139-145 openApp, :154-215 buildApp, :226-276 World, configureApp, appHandle)
@features/step-definitions/DomainWorld.ts (:296, the addFinalizer idiom to copy)
</context>

<tasks>
<task type="auto">
  <name>Task 1: SessionWorld releases its app at scenario end</name>
  <files>features/step-definitions/SessionWorld.ts</files>
  <read_first>features/step-definitions/SessionWorld.ts:155-232, features/step-definitions/DomainWorld.ts:285-300</read_first>
  <action>Add `dispose: () => Promise<void>` to `AppHandle` and set it to `app.dispose` in `appHandle`. In `WorldLive`, bind the World to a const. After building it, `yield* Effect.addFinalizer(() => Effect.flatMap(Ref.get(world.app), (handle) => handle === undefined ? Effect.void : Effect.promise(() => handle.dispose())))` and return the World. Change nothing else.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/02-domain/07-sessions.steps.test.ts 2>&1 | grep '\[leak-guard\]'</automated></verify>
  <acceptance_criteria>The guard line reads apps=0 sqlClients=0 (baseline: ticket 01's table); the feature stays green.</acceptance_criteria>
  <done>07-sessions releases every app.</done>
</task>

<task type="auto">
  <name>Task 2: PasswordWorld releases replaced apps and the last one</name>
  <files>features/step-definitions/PasswordWorld.ts</files>
  <read_first>features/step-definitions/PasswordWorld.ts:120-276</read_first>
  <action>Give the handle `buildApp` returns a `dispose` (from the `TestAuth.app` it opened: make `openApp` return `dispose: app.dispose` beside `handler` and `inApp`). In `configureApp`, read the previous handle before `Ref.set` and, when it is defined, `yield* Effect.promise(() => previous.dispose())` before building the new one.

In `WorldLive`, add the same finalizer as in Task 1 over `world.app`. Do not change the merge semantics or the eager build; ticket 08 replaces both.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/05-authentication-methods/15-password.steps.test.ts features/01-contract-and-persistence/05-persistence-stratum.steps.test.ts 2>&1 | grep '\[leak-guard\]'</automated></verify>
  <acceptance_criteria>Both guard lines read apps=0 sqlClients=0; both features green.</acceptance_criteria>
  <done>PasswordWorld never leaves an app open after its scenario.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
The guard reports 0/0 for 07-sessions, 15-password and 05-persistence-stratum; `pnpm test:bdd` green.
</success_criteria>

## Comments

After: 07-sessions, 15-password and 05-persistence-stratum report 0/0. Deviation: PasswordWorld does not dispose in the slowMailer scenario (dispose waits for the mail drain timeout and the scenario times out), so that one app stays open.
