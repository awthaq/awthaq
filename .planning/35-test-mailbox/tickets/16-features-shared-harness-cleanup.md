---
plan: 35-test-mailbox
ticket: 16
title: "delete the shared mail helpers"
type: execute
wave: 4
depends_on: [10, 11, 12, 13, 20]
files_modified:
  - features/step-definitions/shared/Harness.ts
  - features/step-definitions/HooksSteps.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "features/step-definitions/shared/Harness.ts has no awaitMail and no makeCapturingMailer"
    - "letForkedFibersRun, awaitCondition and awaitStable stay for event waits (PLAN.md N2)"
    - "HooksSteps' failing send is a plain function, not a hand-built MailerShape"
  artifacts:
    - path: features/step-definitions/shared/Harness.ts
      provides: "event waits and registries; no mail helper"
  key_links:
    - from: features/step-definitions/HooksSteps.ts
      to: packages/ports/src/Mailer.ts
      via: "Mailer.MailDeliveryFailed"
      pattern: "MailDeliveryFailed"
---
Status: done (uncommitted)
Blocked by: 10, 11, 12, 13, 20

<objective>
Delete `awaitMail` and `makeCapturingMailer` from the shared features harness once no World uses them, and drop the last hand-built `MailerShape` in features.

Purpose: M4 reaches 0 outside `packages/ports` and `packages/test/src/TestMailbox.ts` at the end of wave 4 (PLAN.md §4.1).
Output: two files.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§2.4, N2)
@features/step-definitions/shared/Harness.ts:1-20,36-115
@features/step-definitions/HooksSteps.ts:80-108
</context>

<tasks>
<task type="auto">
  <name>Task 1: the shared harness</name>
  <files>features/step-definitions/shared/Harness.ts</files>
  <action>Run `git grep -nE 'awaitMail|makeCapturingMailer' -- features` first: it must list only `shared/Harness.ts` and `DomainSupport.ts`'s own `awaitMail` (a different function, kept by ticket 10). Delete `awaitMail` (`:69-74`) and `makeCapturingMailer` (`:98-112`) with their doc comments, and the imports only they used (`Mailer`, possibly `Ref`, `Layer`). Rewrite `awaitCondition`'s doc comment (`:52-57`) so it no longer offers "a mail dispatched by a detached fiber" as its example (mail goes through `TestMailbox`); keep the function. Keep `letForkedFibersRun`, `realTick`, `awaitCondition`, `awaitStable`.</action>
  <verify><automated>pnpm typecheck</automated></verify>
  <acceptance_criteria>Type-checks.</acceptance_criteria>
  <done>The shared harness holds only event waits and registries.</done>
</task>

<task type="auto">
  <name>Task 2: HooksSteps</name>
  <files>features/step-definitions/HooksSteps.ts</files>
  <action>`failingMailer: Mailer.MailerShape` (`:86-97`) is used only as `failingMailer.send(...)` (`:104`). Replace it with `const failingSend = (message: Mailer.MailMessage) => Effect.fail(new Mailer.MailDeliveryFailed({ … same fields … }))` and call `failingSend(...)`. No `sent`, no `MailerShape`.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`pnpm test:bdd` passes. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|awaitMail|makeCapturingMailer|MailerShape' -- features/step-definitions/shared/Harness.ts features/step-definitions/HooksSteps.ts | wc -l` prints 0 (baseline at 04fa3526: 7). Wave-4 exit (M4 without ports and the mailbox): `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|makeCapturingMailer' -- packages features | grep -vE 'webhooks|Webhooks|/web/|agent\.sent|browser\.sent|receiver\.sent|native\.sent|poster\.sent|ReactWorld|NextSsr|ReactSteps|SamlSlo|packages/ports/|packages/test/src/TestMailbox.ts' | wc -l` prints 0.</acceptance_criteria>
  <done>No features file reads `sent` or builds a capturing mailer.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 7 → 0; M4 outside ports and the mailbox is 0.
</success_criteria>

## Comments
- Result: HooksSteps failingSend is a plain function; awaitMail/makeCapturingMailer deleted from shared/Harness.ts. LeakGuard now waits up to 10 s for a release in flight (the slowMailer app's 5 s mail drain) before failing.
