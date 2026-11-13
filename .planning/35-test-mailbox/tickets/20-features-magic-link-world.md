---
plan: 35-test-mailbox
ticket: 20
title: "MagicLink World reads the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - features/step-definitions/MagicLinkWorld.ts
  - features/step-definitions/MagicLinkSteps.ts
  - features/step-definitions/EmailOtpSteps.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "mailOf waits by subscription; the 200 x 5 ms poll is gone"
    - "A step asserting how many mails an address received waits for that count and refutes one more, instead of sleeping 40 ms"
    - "secretOf is TestMailbox.secret"
  artifacts:
    - path: features/step-definitions/MagicLinkWorld.ts
      provides: "mailOf, expectMailCount, secretOf over the app's mailbox"
  key_links:
    - from: features/step-definitions/MagicLinkWorld.ts
      to: TestMailbox.Mailbox
      via: "Context.get(ctx, TestMailbox.Mailbox)"
      pattern: "TestMailbox\\.Mailbox"
---
Status: ready-for-agent
Blocked by: 02

<objective>
The MagicLink World reads the mailbox of the app it starts. `mailOf` (a 200 × 5 ms poll) becomes a `waitFor`; `mailsOf` (a fixed 40 ms real sleep, then a read) is replaced by `expectMailCount`; `secretOf` becomes `TestMailbox.secret`.

Purpose: these two helpers are a sixth poller and a third mail settle that PLAN.md §2.4 missed (recorded in §2.5).
Output: three files. `MagicLinkSupport.ts` (uses `mailOf`/`secretOf` by name) is not touched.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@features/step-definitions/MagicLinkWorld.ts:95-160,240-285
@features/step-definitions/MagicLinkSteps.ts:205-245
@features/step-definitions/EmailOtpSteps.ts:240-290
</context>

<tasks>
<task type="auto">
  <name>Task 1: the World</name>
  <files>features/step-definitions/MagicLinkWorld.ts</files>
  <action>`buildApp` (`:99-133`) stops calling `makeCapturingMailer` and drops `mailer.layer` from `services`; it returns `{ appLayer, vetoed, sessionOutage }`. `startApp` (`:144-155`) reads `Context.get(ctx, TestMailbox.Mailbox)` from the context it already awaits and keeps it on `App` as `mailbox` (replacing `sentMail`, `:138`). `mailOf(template, to)` (`:246-260`): `waitFor((m) => m.template === template && m.to.toLowerCase() === to.toLowerCase())` (a predicate, because the old match was case-insensitive), then return the newest matching message in `messages` (the old helper returned `findLast`). Delete `mailsOf` (`:262-273`) and add `expectMailCount(template, to, count)`: when `count > 0`, `waitFor(predicate, { nth: count })`; then `refute(predicate, { beyond: count })`. `secretOf` (`:275-281`) becomes `export const secretOf = TestMailbox.secret`; the old helper required a non-token field to be `Redacted`, so keep that EOTS-010 check where a step asserts it (`EmailOtpSteps.ts:249` asserts the code's format, not its wrapping: add `assert.isTrue(Redacted.isRedacted(mail.data?.["code"]))` there if no other step covers it). Drop the `mailedToken` import if it becomes unused.</action>
  <verify><automated>pnpm typecheck</automated></verify>
  <acceptance_criteria>Type-checks except for the two step files' `mailsOf` calls (fixed in task 2).</acceptance_criteria>
  <done>The World has no poller and no sleep.</done>
</task>

<task type="auto">
  <name>Task 2: the steps</name>
  <files>features/step-definitions/MagicLinkSteps.ts, features/step-definitions/EmailOtpSteps.ts</files>
  <action>Replace each `assert.equal((yield* mailsOf(template, email)).length, n)` (`MagicLinkSteps.ts:214`, `:215`, `:242`; `EmailOtpSteps.ts:259`, `:260`, `:264`) with `yield* expectMailCount(template, email, n)`; update the imports. Leave every `mailOf`/`secretOf` call as is.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`pnpm test:bdd` passes. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|makeCapturingMailer|sentMail|setTimeout|mailsOf' -- features/step-definitions/MagicLinkWorld.ts features/step-definitions/MagicLinkSteps.ts features/step-definitions/EmailOtpSteps.ts | wc -l` prints 0 (baseline at 04fa3526: 21).</acceptance_criteria>
  <done>The magic-link and email-OTP features read the mailbox.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 21 → 0; one poller and one 40 ms sleep deleted.
</success_criteria>

## Comments

Result: World/steps migrated; features 32 (28 tests) and 33 (36 tests) pass, leak-guard apps=0 sqlClients=0; gate 21 -> 0; features tsc clean. MailedToken.ts untouched (other users).
