---
plan: 35-test-mailbox
ticket: 11
title: "Password and Session Worlds read the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - features/step-definitions/PasswordWorld.ts
  - features/step-definitions/PasswordSteps.ts
  - features/step-definitions/SessionWorld.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "PasswordWorld and SessionWorld keep the app's TestMailbox.Mailbox instead of a capturing mailer"
    - "verifyLatestSignUp, latestResetToken, signUp and mailedTo wait with waitFor; none imports the shared awaitMail"
    - "The slow-mailer option is Layer.mock(Mailer.Mailer)({ send: () => Effect.never })"
  artifacts:
    - path: features/step-definitions/PasswordWorld.ts
      provides: "mailbox accessor; settle over the mailbox and events"
  key_links:
    - from: features/step-definitions/SessionWorld.ts
      to: TestMailbox.Mailbox
      via: "app.run(TestMailbox.Mailbox) or app.context()"
      pattern: "TestMailbox\\.Mailbox"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Move the Password and Session Worlds (memory and SQLite compositions) off `makeCapturingMailer` and the shared `awaitMail`. Their exported helpers keep their names and signatures (`verifyLatestSignUp`, `latestResetToken`, `signUp`, `mailedTo`), so `SessionSteps.ts` and other step files are untouched.

Purpose: 34 gate lines (PLAN.md §2.3 "55 through delegates", the largest features share).
Output: three files.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@features/step-definitions/PasswordWorld.ts:1-20,84-96,150-218,388-430
@features/step-definitions/PasswordSteps.ts:14-50,150-168,238-250,876-890
@features/step-definitions/SessionWorld.ts:45-55,105-115,160-232,362-420
@features/step-definitions/shared/Harness.ts:55-100 (awaitMail, awaitStable: awaitMail is deleted in ticket 16, awaitStable stays)
</context>

<tasks>
<task type="auto">
  <name>Task 1: PasswordWorld and PasswordSteps</name>
  <files>features/step-definitions/PasswordWorld.ts, features/step-definitions/PasswordSteps.ts</files>
  <action>`PasswordWorld.ts`: `neverAnsweringMailer` (`:90-93`) becomes `Layer.mock(Mailer.Mailer)({ send: () => Effect.never })`. `buildApp` (`:154-216`) stops calling `makeCapturingMailer`; the `slowMailer` option alone puts a `Mailer` in `services`. Wherever `openApp` builds each storage variant, read the app's `TestMailbox.Mailbox` (`Context.get(await app.context(), TestMailbox.Mailbox)` through `Effect.promise`, or `app.run(TestMailbox.Mailbox)`) and keep it on the handle as `mailbox` instead of `sentMail` (`:122`, `:216`). Replace the exported `sentMail` (`:392-394`) with `export const mailbox = Effect.fn("features.password.mailbox")(function* () { return (yield* appHandle()).mailbox })`. `settle` (`:405-408`) keeps `awaitStable` (it also waits for events, PLAN.md N2) over `Effect.zip(mailbox.mail.messages, app.publishedEvents)`. `verifyLatestSignUp` (`:417-430`): `waitFor` the verify mail (`to` only when `email` is given), then `mailedToken`. Rewrite the header comment's `Mailer.layerMemory`-alike sentence (`:4`). `PasswordSteps.ts`: `latestResetToken` (`:155-167`), the step at `:242-248` and the step at `:880-889` use `(yield* mailbox()).mail.waitFor(...)`; remove `awaitMail` and `sentMail` from the imports (`:35`, `:50`). Where a step asserts only that a mail was dispatched (`:242-248`), the `waitFor` is the assertion.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/05-authentication-methods/15-password.steps.test.ts</automated></verify>
  <acceptance_criteria>The password feature passes with its HEAD scenario count.</acceptance_criteria>
  <done>The Password World reads its app's mailbox.</done>
</task>

<task type="auto">
  <name>Task 2: SessionWorld</name>
  <files>features/step-definitions/SessionWorld.ts</files>
  <action>`buildAppLayer` (`:110-111`) stops calling `makeCapturingMailer` and drops its layer from the composition; it returns `{ appLayer }`. The handle (`:220-232`, `AppHandle` `:167`) carries `mailbox` (read once through `app.run(TestMailbox.Mailbox)` when the handle is first built) instead of `sentMail`. `signUp` (`:367-400`) and `mailedTo` (`:403-415`) use `mailbox.mail.waitFor({ to, template })`; `mailedTo` returns the newest matching message after the wait, as before. Remove `awaitMail` from the shared-harness import (`:50`).</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`pnpm test:bdd` passes. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|makeCapturingMailer|sentMail|awaitMail' -- features/step-definitions/PasswordWorld.ts features/step-definitions/PasswordSteps.ts features/step-definitions/SessionWorld.ts | wc -l` prints 0 (baseline at 04fa3526: 34).</acceptance_criteria>
  <done>Neither World builds a capturing mailer or calls the shared `awaitMail`.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 34 → 0; `SessionSteps.ts` and every other caller of the kept helpers unchanged and green.
</success_criteria>

## Comments
Result (uncommitted): PasswordWorld/SessionWorld keep `mailbox` on the handle (read from `app.context()`); `sentMail` replaced by `mailbox`, new `latestMail(template, to?)` in PasswordWorld used by PasswordSteps; slow mailer is `Layer.mock`. Gate 34 -> 0. 07-sessions green (apps=0); 15-password: all scenarios of this ticket pass, leak-guard apps=1 (slowMailer, expected). One failing scenario, "A recovery code carries a reset exactly once", is in `TwoFactorResetSteps.ts` (another ticket's file): its `waitFor` has no `nth`, so the second "holds a live password-reset token" reads the first, consumed token.
