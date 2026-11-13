---
plan: 35-test-mailbox
ticket: 13
title: "TwoFactor World and the notifier fixture"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - features/step-definitions/TwoFactorWorld.ts
  - features/step-definitions/TwoFactorResetSteps.ts
  - features/step-definitions/PluginFixtures.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "TwoFactor direct steps read verify and reset mail through TestMailbox.Mailbox"
    - "NotifierFixture still requires Mailer (BEH-EA-019's RIn check) but never reads sent"
  artifacts:
    - path: features/step-definitions/PluginFixtures.ts
      provides: "NotifierFixture.layer with ports: [Mailer.Mailer] and a notify that reads nothing"
  key_links:
    - from: features/step-definitions/TwoFactorWorld.ts
      to: TestMailbox.Mailbox
      via: "yield* TestMailbox.Mailbox inside direct(...)"
      pattern: "TestMailbox\\.Mailbox"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Move the two-factor BDD steps off `mailer.sent` plus the shared `awaitMail`, and make the one plugin-shaped reader of `sent` (`PluginFixtures.ts:240`, PLAN.md §2.3) stop reading it.

Purpose: 9 gate lines; after this ticket no plugin-shaped code reads `sent`.
Output: three files.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§2.3, §3.3)
@packages/test/src/TestMailbox.ts
@features/step-definitions/TwoFactorWorld.ts:45-55,160-180,322-340
@features/step-definitions/TwoFactorResetSteps.ts:10-30,40-60
@features/step-definitions/PluginFixtures.ts:228-250
@features/step-definitions/RegistriesSteps.ts:305-320,385-390 (callers of NotifierFixture: they assert only "silent" for the no-mail variant and that the layer builds)
</context>

<tasks>
<task type="auto">
  <name>Task 1: TwoFactor World and reset steps</name>
  <files>features/step-definitions/TwoFactorWorld.ts, features/step-definitions/TwoFactorResetSteps.ts</files>
  <action>Add `TestMailbox.Mailbox` to the services union `direct` accepts (`TwoFactorWorld.ts:160-180`, beside `Mailer.Mailer`); the composition is `TestAuth.layer` (`:116`), whose base provides it. `register` (`:322-340`): replace `const mailer = yield* Mailer.Mailer`, the `awaitMail` and the `findLast` with `const mail = yield* (yield* TestMailbox.Mailbox).mail.waitFor({ to: email, template: "verify-email" })`; drop the `undefined` check. `TwoFactorResetSteps.ts:46-58`: the same for `"reset-password"` to `person.email`. Remove `awaitMail` from both shared-harness imports (`TwoFactorWorld.ts:52`, `TwoFactorResetSteps.ts:28`) and `Mailer` from the union and imports if unused afterwards.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/14-mfa-passwordless</automated></verify>
  <acceptance_criteria>The MFA features pass.</acceptance_criteria>
  <done>Two-factor steps wait by subscription.</done>
</task>

<task type="auto">
  <name>Task 2: NotifierFixture</name>
  <files>features/step-definitions/PluginFixtures.ts</files>
  <action>`NotifierFixture.layer` (`:236-242`) must keep `Mailer` in its requirement (`ports: [Mailer.Mailer]`, BEH-EA-019's "variant drops a port" scenario compares the two layers' `RIn`). Keep `yield* Mailer.Mailer` in `make` without binding it, and return `{ notify: () => Effect.succeed("notified") }`. `git grep -n 'mailed:' -- features` shows nothing asserts the old `mailed:N` string. Update the comment to "The full layer requires the `Mailer` port."</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`pnpm test:bdd` passes. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|awaitMail' -- features/step-definitions/TwoFactorWorld.ts features/step-definitions/TwoFactorResetSteps.ts features/step-definitions/PluginFixtures.ts | wc -l` prints 0 (baseline at 04fa3526: 9).</acceptance_criteria>
  <done>No plugin-shaped code in the repository reads `sent`.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 9 → 0; BEH-EA-019's variant scenario still green.
</success_criteria>

## Comments

Result (done, uncommitted): TwoFactorWorld.register and the reset step wait on TestMailbox.Mailbox (secret via TestMailbox.secret); NotifierFixture keeps `yield* Mailer.Mailer` and returns "notified". Gate 9 -> 0. 31-two-factor.steps 86 pass, leak-guard apps=0 sqlClients=0.
