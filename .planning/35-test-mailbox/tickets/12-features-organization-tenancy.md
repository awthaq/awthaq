---
plan: 35-test-mailbox
ticket: 12
title: "Organization World and Tenancy steps read the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - features/step-definitions/OrganizationWorld.ts
  - features/step-definitions/OrganizationSteps.ts
  - features/step-definitions/TenancySteps.ts
  - features/step-definitions/TenancyWorld.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "OrganizationWorld reads the app's mailbox; 'no mail was sent to X' is a refute"
    - "TenancySteps reads the invitation token through TestMailbox.Mailbox, not Mailer.sent"
  artifacts:
    - path: features/step-definitions/TenancyWorld.ts
      provides: "OrganizationServices includes TestMailbox.Mailbox"
  key_links:
    - from: features/step-definitions/TenancySteps.ts
      to: TestMailbox.Mailbox
      via: "waitFor({ to: email, template: \"organization-invite\" })"
      pattern: "TestMailbox\\.Mailbox"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Move the organization and tenancy BDD steps to the mailbox. `OrganizationSteps.ts`'s event waits (`letForkedFibersRun` at `:936` onward) stay: they wait for events, not mail (PLAN.md N2).

Purpose: 8 gate lines, including the one direct `(yield* Mailer.Mailer).sent` in a step (`TenancySteps.ts:1435`).
Output: four files.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@features/step-definitions/OrganizationWorld.ts:100-150,360-372
@features/step-definitions/OrganizationSteps.ts:60-75,600-650,805-830,925-940
@features/step-definitions/TenancySteps.ts:1418-1445
@features/step-definitions/TenancyWorld.ts:160-215,590-600
</context>

<tasks>
<task type="auto">
  <name>Task 1: OrganizationWorld and OrganizationSteps</name>
  <files>features/step-definitions/OrganizationWorld.ts, features/step-definitions/OrganizationSteps.ts</files>
  <action>`OrganizationWorld.ts`: `buildApp` (`:119-145`) stops calling `makeCapturingMailer` and stops passing a mailer to `buildAppLayer` (drop that parameter if nothing else passes one). `AppHandle.sentMail` (`:112`) becomes `mailbox: Effect.Effect<TestMailbox.MailboxShape>` built as `Effect.promise(() => app.run(TestMailbox.Mailbox))`. `mailTo(email)` (`:367-371`) reads `(yield* app.mailbox).mail.messages`, filtered and newest first as before (invitation mail is sent before `invite` returns, which is why the old read had no wait). `OrganizationSteps.ts`: the two direct `app.sentMail` reads (`:640`, `:821`) read `(yield* app.mailbox).mail.messages`; "no mail was sent to {string}" (`:930-933`) becomes `yield* (yield* app.mailbox).mail.refute({ to: email })` with no `letForkedFibersRun` before it. Leave every other `letForkedFibersRun` in the file.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/10-organization</automated></verify>
  <acceptance_criteria>The organization features pass.</acceptance_criteria>
  <done>The Organization World reads its app's mailbox.</done>
</task>

<task type="auto">
  <name>Task 2: Tenancy</name>
  <files>features/step-definitions/TenancySteps.ts, features/step-definitions/TenancyWorld.ts</files>
  <action>`TenancyWorld.ts:167-172`: add `TestMailbox.Mailbox` to `OrganizationServices` (the stack at `:198` is `TestAuth.layer`, whose base provides it after ticket 02); keep `Mailer.Mailer` in the union only if another step still needs it (`git grep -n 'Mailer.Mailer' -- features/step-definitions/Tenancy*` decides). `TenancySteps.ts:1435-1440`: replace the newest-string-token scan of `(yield* Mailer.Mailer).sent` with `const mail = yield* (yield* TestMailbox.Mailbox).mail.waitFor({ to: email, template: "organization-invite" })` and `token: TestMailbox.secret(mail)`; drop the now redundant `assert.ok`. Drop the `Mailer` import if unused.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`pnpm test:bdd` passes. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|makeCapturingMailer|sentMail' -- features/step-definitions/OrganizationWorld.ts features/step-definitions/OrganizationSteps.ts features/step-definitions/TenancySteps.ts features/step-definitions/TenancyWorld.ts | wc -l` prints 0 (baseline at 04fa3526: 8).</acceptance_criteria>
  <done>No organization or tenancy step reads `sent`.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 8 → 0; the event waits in `OrganizationSteps.ts` unchanged.
</success_criteria>

## Comments

Result (done, uncommitted): OrganizationWorld `AppHandle.mailbox` (app.run(TestMailbox.Mailbox)), buildAppLayer lost its mailer parameter, "no mail was sent to" is a refute. TenancyWorld OrganizationServices swaps Mailer.Mailer for TestMailbox.Mailbox; TenancySteps waits for organization-invite. Gate 8 -> 0. vitest 35-organization (84) and 28-tenancy (58 + 7 skipped) green.
