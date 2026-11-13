---
plan: 35-test-mailbox
ticket: 03
title: "magic-link suites read the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - packages/magic-link/test/support/harness.ts
  - packages/magic-link/test/MagicLink.test.ts
  - packages/magic-link/test/EmailOtp.test.ts
  - packages/magic-link/test/AuthHttp.test.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "Every magic-link and email-OTP test reads mail through TestMailbox.Mailbox"
    - "The magic-link harness keeps its composition and outage decorator and loses its mail helpers"
  artifacts:
    - path: packages/magic-link/test/support/harness.ts
      provides: "buildLayer, realLimiter, the Sessions.issue outage decorator; no mail helpers"
  key_links:
    - from: packages/magic-link/test/MagicLink.test.ts
      to: TestMailbox.Mailbox
      via: "yield* TestMailbox.Mailbox"
      pattern: "TestMailbox\\.Mailbox"
---
Status: ready-for-agent
Blocked by: 02

<objective>
Move the magic-link package's suites from `mailer.sent` plus `awaitMails`/fixed yields/`secretOf` to `TestMailbox`, and delete those three helpers from the harness.

Purpose: removes one of the five pollers (`awaitMails`, 5 s/2 ms) and one fixed-yield copy (PLAN.md §2.4).
Output: four files; the harness shrinks to its composition (≈60 lines, so plan 08 ticket 29's "delete if under 30 lines" stays unmet, PLAN.md §2.5).
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3 replacement table)
@packages/test/src/TestMailbox.ts
@packages/magic-link/test/support/harness.ts:63-95
@packages/magic-link/test/MagicLink.test.ts:20-120
@packages/magic-link/test/EmailOtp.test.ts:20-100
@packages/magic-link/test/AuthHttp.test.ts:15-30,60-165
</context>

<tasks>
<task type="auto">
  <name>Task 1: domain suites</name>
  <files>packages/magic-link/test/MagicLink.test.ts, packages/magic-link/test/EmailOtp.test.ts</files>
  <action>Replace each "length before, send, poll until before+1, findLast" sequence (`MagicLink.test.ts:41-43`, `EmailOtp.test.ts:28-38`) with one `box.mail.waitFor({ to, template: "magic-link" })` (or `"email-otp"`), where `box` is `yield* TestMailbox.Mailbox`; when a test sends the same template to the same address more than once, wait for the `nth` occurrence counted from the matches recorded before the send (`nth: before + 1`, with `before` the number of matching messages, not of all messages). Replace each "wait for N, then yields, then assert length is N" (`MagicLink.test.ts:61-64,110-117`, `EmailOtp.test.ts:62-65,82-83`) with `waitFor(match, { nth: N })` followed by `refute(match, { beyond: N })`. Replace `secretOf(mail, field)` with `TestMailbox.secret(mail, field)`. Keep every assertion that a mailed value is `Redacted` (EOTS-010 checks, e.g. `MagicLink.test.ts:98`, `EmailOtp.test.ts:57`). Remove the now-unused imports of `Mailer` and the harness helpers.</action>
  <verify><automated>npx vitest run packages/magic-link/test/MagicLink.test.ts packages/magic-link/test/EmailOtp.test.ts</automated></verify>
  <acceptance_criteria>Both suites pass with the same number of tests as before (record the count from the first run at HEAD).</acceptance_criteria>
  <done>No domain suite of this package reads the mailer's `sent`.</done>
</task>

<task type="auto">
  <name>Task 2: the wire suite and the harness</name>
  <files>packages/magic-link/test/AuthHttp.test.ts, packages/magic-link/test/support/harness.ts</files>
  <action>`AuthHttp.test.ts`: delete the `sentMail` delegate (`:25`) and the probe's `mails` delegate (`:67`); where the test needs a mail, run `testApp.run(Effect.flatMap(TestMailbox.Mailbox, (box) => box.mail.waitFor(match, { nth })))` (or `probe.run`), with `nth` counted as in task 1; `secretOf` becomes `TestMailbox.secret`. Then delete `letForkedFibersRun`, `awaitMails` and `secretOf` from `support/harness.ts` (`:63-95`) and the imports they alone used (`Mailer`, `Redacted`). Keep `buildLayer`, `realLimiter` and the `Sessions.issue` outage decorator unchanged (fault injection is out of scope, PLAN.md N1).</action>
  <verify><automated>npx vitest run packages/magic-link/test</automated></verify>
  <acceptance_criteria>`git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|letForkedFibersRun|awaitMails|secretOf' -- packages/magic-link/test | wc -l` prints 0 (baseline at 04fa3526: 43). `wc -l < packages/magic-link/test/support/harness.ts` is below 70 (baseline 95).</acceptance_criteria>
  <done>The package's tests pass; the harness has no mail helper.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
The package gate is 0 (from 43); test count unchanged; one poller and one fixed-yield copy deleted.
</success_criteria>

## Comments

Result: 4 files migrated; harness 95 -> 60 lines; vitest packages/magic-link/test 59 passed; gate 43 -> 0; tsc test project clean for magic-link.
