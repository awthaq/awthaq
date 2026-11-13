---
plan: 35-test-mailbox
ticket: 10
title: "Domain World reads the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - features/step-definitions/DomainWorld.ts
  - features/step-definitions/DomainSupport.ts
  - features/step-definitions/MailedToken.ts
  - features/step-definitions/UsersAccountsSteps.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "DomainWorld keeps the app's TestMailbox.Mailbox, read from app.context(), instead of a capturing mailer built outside the graph"
    - "DomainSupport.awaitMail keeps its signature and waits by subscription, over the SQL composition"
    - "mailedToken delegates to TestMailbox.secret"
  artifacts:
    - path: features/step-definitions/DomainWorld.ts
      provides: "WorldShape.mailbox: TestMailbox.MailboxShape"
  key_links:
    - from: features/step-definitions/DomainWorld.ts
      to: TestMailbox.Mailbox
      via: "Context.get(ctx, TestMailbox.Mailbox)"
      pattern: "TestMailbox\\.Mailbox"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
The Domain World (SQL composition through `TestAuth.layer({ records: "sql" })`) reads mail from the mailbox its own app built. `DomainSupport.awaitMail` stops polling (500 × 2 ms), `mailCount` (unused) is deleted, `mailedToken` becomes a one-line delegate, and the one step that reads `sentMail` directly waits instead.

Purpose: removes one of the five pollers (PLAN.md §2.4) and proves R1: a wait on a step's fiber wakes on a send made inside the app's runtime (PLAN.md §7).
Output: four files. `VerificationSteps.ts` (14 `awaitMail` calls) is not touched: the signature stays.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3 last row, §7 R1)
@packages/test/src/TestMailbox.ts
@features/step-definitions/DomainWorld.ts:195-310
@features/step-definitions/DomainSupport.ts:1-15,60-110
@features/step-definitions/MailedToken.ts
@features/step-definitions/UsersAccountsSteps.ts:333-348
</context>

<tasks>
<task type="auto">
  <name>Task 1: the World and its helpers</name>
  <files>features/step-definitions/DomainWorld.ts, features/step-definitions/DomainSupport.ts, features/step-definitions/MailedToken.ts</files>
  <action>`DomainWorld.ts`: `buildStack` (`:202-237`) stops calling `makeCapturingMailer` and drops `mailer.layer` from `services` (the base provides `TestMailbox.layer`); it returns `{ appLayer }`. In `WorldLive` (`:285-310`), after `const ctx = yield* Effect.promise(() => app.context())`, read `Context.get(ctx, TestMailbox.Mailbox)` and keep it on the World as `mailbox` (replacing `sentMail` in `WorldShape`, `:272`). If `ctx` is narrowed to `DomainServices` before the read, read from the unnarrowed context or add `TestMailbox.Mailbox` to `DomainServices`. Update the doc comment at `:195-201` ("the mailer … are this world's own `services`"). `DomainSupport.ts`: delete `mailCount` (`:63-73`; `git grep -n mailCount -- features` shows no caller). Rewrite `awaitMail(email, template, after = 0)` (`:79-95`) as: `waitFor({ to: email, template }, { nth: after + 1 })` on `(yield* World).mailbox.mail`, then return the newest matching message in `messages` (the old helper returned the newest once the count exceeded `after`). Keep its name, parameters and doc comment's meaning; drop "polled on the real clock". `MailedToken.ts`: `export const mailedToken = (mail: Mailer.MailMessage): string => TestMailbox.secret(mail)`; keep the EOTS-010 comment.</action>
  <verify><automated>pnpm --filter @awthaq/features typecheck && pnpm --filter @awthaq/features exec vitest run features/02-domain/08-verification-tokens.steps.test.ts</automated></verify>
  <acceptance_criteria>Type-checks (the `UsersAccountsSteps.ts` read of `sentMail` fails to compile until task 2; do task 2 before this verify if so); the verification-token features (the heaviest `awaitMail` users, `VerificationSteps.ts`) pass.</acceptance_criteria>
  <done>The World reads its app's mailbox.</done>
</task>

<task type="auto">
  <name>Task 2: the direct reader</name>
  <files>features/step-definitions/UsersAccountsSteps.ts</files>
  <action>`:338-341` reads `sentMail` and `findLast`s the verify mail with no wait. Replace with `const { mailbox } = yield* World; const mail = yield* mailbox.mail.waitFor({ to: person.email, template: "verify-email" })` and drop the `assert.ok(mail !== undefined, …)` that `waitFor` makes redundant.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`pnpm test:bdd` passes. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|makeCapturingMailer|sentMail|mailCount|setTimeout' -- features/step-definitions/DomainWorld.ts features/step-definitions/DomainSupport.ts features/step-definitions/MailedToken.ts features/step-definitions/UsersAccountsSteps.ts | wc -l` prints 0 (baseline at 04fa3526: 14).</acceptance_criteria>
  <done>No step of the Domain World reads a captured `sent`.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 14 → 0; one poller deleted; `VerificationSteps.ts` unchanged and green.
</success_criteria>

## Comments

Result (done, uncommitted): DomainWorld keeps `mailbox` (from app.context()); awaitMail waits via waitFor(nth: after+1), mailCount deleted, mailedToken delegates to TestMailbox.secret, UsersAccountsSteps waits. Gate 14 -> 0. vitest 06-users-accounts, 08-verification-tokens green (leak-guard 0/0).
