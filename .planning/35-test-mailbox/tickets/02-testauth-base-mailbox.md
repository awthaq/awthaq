---
plan: 35-test-mailbox
ticket: 02
title: "TestAuth's base provides the mailbox"
type: tdd
wave: 2
depends_on: [01]
files_modified:
  - packages/test/src/TestAuth.ts
  - packages/test/test/TestAuthApp.test.ts
  - packages/test/test/TestAuthServices.test.ts
  - packages/test/test/TestAuthHost.test.ts
  - packages/test/README.md
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "TestAuth.layer's output holds TestMailbox.Mailbox, Mailer and SmsSender from one recording"
    - "A mail the Password plugin sends while serving an HTTP request is returned by Mailbox.mail.waitFor run through app.run"
    - "A Mailer given in `services` still shadows the base for the plugins (BEH-EA-193), and its double is Layer.mock"
    - "TestAuthHost.test.ts still proves the harness's keys are the host's plus exactly the guard's"
  artifacts:
    - path: packages/test/src/TestAuth.ts
      provides: "testPorts composes TestMailbox.layer"
      contains: "TestMailbox.layer"
  key_links:
    - from: packages/test/src/TestAuth.ts
      to: packages/test/src/TestMailbox.ts
      via: "Layer.mergeAll in testPorts"
      pattern: "TestMailbox\\.layer"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Swap `Mailer.layerMemory` for `TestMailbox.layer` in `TestAuth`'s test ports, so every composition built with `TestAuth.layer` carries the mailbox, and move `@awthaq/test`'s own suites to it.

Purpose: one place provides the recording every plugin suite and World will read (PLAN.md G2). This edit is confined to `testPorts` so plan 34 (app lifetime, listening mode) and this plan land in either order.
Output: the base change, the package's own tests at the new interface, the README line.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3, §7 R1/R4, §8 plan 34 row)
@packages/test/src/TestAuth.ts:149-169 (testPorts), :355-366 (layer doc comment), :265-268 (TestProvided)
@packages/test/test/TestAuthApp.test.ts
@packages/test/test/TestAuthServices.test.ts:15-40
@packages/test/test/TestAuthHost.test.ts
@packages/test/src/TestMailbox.ts (ticket 01)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: red, the base serves the mailbox</name>
  <files>packages/test/test/TestAuthApp.test.ts</files>
  <behavior>
    - New case: `TestAuth.app(TestAuth.layer(Auth.make([Password.Password]), { services: TestAuth.httpClient.noBreach }))`; an anonymous agent posts a sign-up through `app.handler`; `await app.run(Effect.flatMap(TestMailbox.Mailbox, (box) => box.mail.waitFor({ to, template: "verify-email" })))` returns the verification mail, and `TestMailbox.secret(mail)` is non-empty. This waits on a fiber of `run` while the mail is sent from the handler's request fiber.
    - The file's existing `poster.sent`/`native.sent` reads are the user agent's request log (`@awthaq/web`), not mail: leave them alone.
  </behavior>
  <action>Write the new case first and run it: it fails because `TestMailbox.Mailbox` is not in the composition's output (at runtime a missing-service defect; `pnpm typecheck` also rejects `run`'s requirement), which is the red state. Do not touch the agents' `sent` request logs.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthApp.test.ts (expected red before task 2)</automated></verify>
  <acceptance_criteria>The new case exists and fails for the stated reason.</acceptance_criteria>
  <done>Red recorded.</done>
</task>

<task type="tdd">
  <name>Task 2: green, testPorts composes TestMailbox.layer</name>
  <files>packages/test/src/TestAuth.ts, packages/test/README.md</files>
  <action>In `testPorts` (`TestAuth.ts:156-169`) replace the `Mailer.layerMemory` member of `Layer.mergeAll` with `TestMailbox.layer` (import `* as TestMailbox from "./TestMailbox.ts"`; drop `Mailer` from the `@awthaq/ports` import if nothing else uses it). Rewrite the doc comment above `testPorts` (`:149-155`, "a capturing mailer") and the sentence in `layer`'s doc comment (`:360-363`) to say the base provides `TestMailbox.layer`: `Mailer` and `SmsSender` recording into `TestMailbox.Mailbox`. Touch nothing else in this file: `app`, `App`, `run`, `context`, `dispose` and `makeLayer` belong to plan 34. `TestProvided` follows automatically from `Layer.Success<ReturnType<typeof testPorts>>`. In `packages/test/README.md:5` replace "`Mailer.layerMemory`" with "`TestMailbox.layer` (a recording `Mailer` and `SmsSender`, read through `TestMailbox.Mailbox`)" and add one bullet describing `TestMailbox` (`waitFor`, `refute`, `messages`, `secret`).</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthApp.test.ts packages/test/test/TestMailbox.test.ts</automated></verify>
  <acceptance_criteria>`git grep -n 'Mailer.layerMemory' -- packages/test/src/TestAuth.ts packages/test/README.md | wc -l` prints 0 (baseline 3). `git grep -n 'TestMailbox.layer' -- packages/test/src/TestAuth.ts | wc -l` prints at least 1 (baseline 0).</acceptance_criteria>
  <done>The new case passes.</done>
</task>

<task type="auto">
  <name>Task 3: the remaining package suites</name>
  <files>packages/test/test/TestAuthServices.test.ts, packages/test/test/TestAuthHost.test.ts</files>
  <action>`TestAuthServices.test.ts:17-27`: the capturing `Mailer` "of the test's own" proves that a `services` `Mailer` is the instance the plugin sends through. Keep that meaning: build its `Ref` in the test, provide `Layer.mock(Mailer.Mailer)({ send: (message) => Ref.update(...) })`, and assert against the test's own `Ref` instead of reading the mailer's `sent` (BEH-EA-195). `TestAuthHost.test.ts` builds `AuthHost.layer` over a port set that includes `Mailer.layerMemory` and compares service keys with the harness: provide `TestMailbox.layer` in that port set instead, so both sides hold `Mailer`, `SmsSender` and `TestMailbox.Mailbox` and the key-parity assertion keeps meaning "host keys plus exactly the guard's". If the assertion lists keys explicitly, add the two new keys to both sides' expectation, never to only one.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthServices.test.ts packages/test/test/TestAuthHost.test.ts</automated></verify>
  <acceptance_criteria>Plan gate for this ticket's files: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|makeCapturingMailer' -- packages/test/src/TestAuth.ts packages/test/test/TestAuthServices.test.ts packages/test/test/TestAuthHost.test.ts packages/test/README.md | wc -l` prints 0 (baseline at 04fa3526: 6).</acceptance_criteria>
  <done>`@awthaq/test`'s suites read the mailbox or their own `Ref`.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Every `TestAuth.layer` composition holds `TestMailbox.Mailbox`; the package gate above is 0; `TestAuthHost.test.ts` green on memory and SQLite.
</success_criteria>

## Comments
- Result: testPorts composes TestMailbox.layer; TS2883 fixed by naming Mailer/SmsSender in TestProvided. Added a handler-fiber waitFor case to TestAuthApp.test.ts.
