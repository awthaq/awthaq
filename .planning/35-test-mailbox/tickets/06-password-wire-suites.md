---
plan: 35-test-mailbox
ticket: 06
title: "password wire suites and the password harness"
type: execute
wave: 4
depends_on: [05]
files_modified:
  - packages/password/test/AuthHttp.test.ts
  - packages/password/test/PasswordChangeEmail.test.ts
  - packages/password/test/PasswordMail.test.ts
  - packages/password/test/harness.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 3, size: L}
must_haves:
  truths:
    - "The password HTTP suite reads mail through the app's own mailbox, not a capturing mailer built outside the graph"
    - "Failing and flaky mailers are Layer.mock(Mailer.Mailer)({ send }) with the test's own Refs"
    - "packages/password/test/harness.ts exports no mail helper"
  artifacts:
    - path: packages/password/test/harness.ts
      provides: "email, strongPassword, makeTestLayer/buildLayer; no letForkedFibersRun, no tokenOf"
  key_links:
    - from: packages/password/test/AuthHttp.test.ts
      to: TestMailbox.Mailbox
      via: "testApp.run(Effect.flatMap(TestMailbox.Mailbox, ...))"
      pattern: "TestMailbox\\.Mailbox"
---
Status: done (uncommitted)
Blocked by: 05

<objective>
Finish the password package: the HTTP suite, the change-email and mail-dispatch suites, then delete `letForkedFibersRun` and `tokenOf` from `harness.ts`.

Purpose: removes the second `letForkedFibersRun` definition (`AuthHttp.test.ts:85`), the harness's (`harness.ts:55`), the `capturingMailer` built outside the graph (`AuthHttp.test.ts:56-73`), and the 20-yield `settle` (`PasswordMail.test.ts:107-109`). After this ticket M2 and M3 are 0.
Output: four test files.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@packages/password/test/AuthHttp.test.ts:40-130,155-200,255-345,400-450,620-640,925-960
@packages/password/test/PasswordChangeEmail.test.ts:185-215
@packages/password/test/PasswordMail.test.ts:75-150
@packages/password/test/harness.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1: AuthHttp.test.ts</name>
  <files>packages/password/test/AuthHttp.test.ts</files>
  <action>Delete the local `letForkedFibersRun` (`:79-87`) and `capturingMailer` (`:52-73`, with its comment). `buildAppLayer(Mailer.layerMemory)` (`:50`, `:635`) and the `services: Layer.mergeAll(NoBreachHttpClient, Mailer.layerMemory)` members (`:158`, `:199`) stop passing a mailer: the `TestAuth.layer` base already provides `TestMailbox.layer` (ticket 02); drop the parameter from `buildAppLayer` if no caller needs another mailer. Every test that built `capturingMailer()` (`:262`, `:306`, `:367`, `:405`, `:442`, `:509`, `:609`, `:811`, `:840`, `:871`) reads mail with `testApp.run(Effect.flatMap(TestMailbox.Mailbox, (box) => box.mail.waitFor(match, { nth })))`; the verify helper at `:119-127` takes the app instead of a `{ sent }` record. The ordered-templates check at `:626-628` becomes `waitFor({ to }, { nth: 2 })` then `refute({ to }, { beyond: 2 })` then the template list of `messages` filtered by `to`. `tokenOf` becomes `TestMailbox.secret`. The `sessionsDown` outage (`:931-958`) stays (PLAN.md N1).</action>
  <verify><automated>npx vitest run packages/password/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>Same test count as at HEAD; all pass. `git grep -nE 'letForkedFibersRun|capturingMailer|Mailer\.layerMemory|\.sent([^A-Za-z]|$)' -- packages/password/test/AuthHttp.test.ts | wc -l` prints 0.</acceptance_criteria>
  <done>The wire suite reads the app's mailbox.</done>
</task>

<task type="auto">
  <name>Task 2: change-email and mail-dispatch suites</name>
  <files>packages/password/test/PasswordChangeEmail.test.ts, packages/password/test/PasswordMail.test.ts</files>
  <action>`PasswordChangeEmail.test.ts`: the failing mailer (`:192-210`) becomes `Layer.mock(Mailer.Mailer)({ send })` with the same failure; every `mailer.sent` read becomes `waitFor`/`refute` on `yield* TestMailbox.Mailbox` (when the failing mock replaces the base mailer, the mailbox records nothing; such a test asserts on its own `Ref` or on the outcome, not on the mailbox). `PasswordMail.test.ts`: `flakyMailer(failures, retryable)` (`:80-104`) becomes a function returning `{ layer, delivered }`: `delivered` a `SubscriptionRef` of delivered messages and an attempts `Ref`, both made with the unsafe constructors at test scope, and `layer = Layer.mock(Mailer.Mailer)({ send })` (no `sent`). The 20-yield `settle` (`:107-109`) has three uses with three different jobs. (a) `:148`, before `Fiber.join(failed)`: redundant, the join already waits for the `auth.mail.failed` event; delete it. (b) `:122`, after `TestClock.adjust`, before reading what was delivered: replace with `SubscriptionRef.changes(delivered)` filtered to two messages and `Stream.runHead`, then assert on that snapshot. (c) `:120`, before `TestClock.adjust`: it lets the failed first attempt reach its retry sleep so the adjust wakes it. That orders `TestClock`, not mail, and the mailbox cannot replace it: keep it as a local loop renamed `letRetryArm`, used once, with a one-line comment saying why (PLAN.md §2.5 correction).</action>
  <verify><automated>npx vitest run packages/password/test/PasswordChangeEmail.test.ts packages/password/test/PasswordMail.test.ts</automated></verify>
  <acceptance_criteria>Both pass with HEAD test counts. `git grep -nE 'settle|(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)' -- packages/password/test/PasswordChangeEmail.test.ts packages/password/test/PasswordMail.test.ts | wc -l` prints 0. `git grep -n 'letRetryArm' -- packages/password/test/PasswordMail.test.ts | wc -l` prints 2 (definition and one use; baseline 0, `settle` had 4 lines).</acceptance_criteria>
  <done>No hand-built two-member mailer remains in the package.</done>
</task>

<task type="auto">
  <name>Task 3: the harness</name>
  <files>packages/password/test/harness.ts</files>
  <action>Delete `letForkedFibersRun` (`:50-57`) and `tokenOf` (`:58-62`) with their comments and the imports only they used. Keep `email`, `strongPassword` and the layer builders. Run `git grep -n 'letForkedFibersRun\|tokenOf' -- packages/password` first: it must print nothing but `harness.ts` lines (ticket 05 and tasks 1–2 removed every importer).</action>
  <verify><automated>npx vitest run packages/password/test</automated></verify>
  <acceptance_criteria>Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|letForkedFibersRun|tokenOf|capturingMailer|settle|MailerShape' -- packages/password/test/AuthHttp.test.ts packages/password/test/PasswordChangeEmail.test.ts packages/password/test/PasswordMail.test.ts packages/password/test/harness.ts | wc -l` prints 0 (baseline at 04fa3526: 78). Package-wide M3: `git grep -n letForkedFibersRun -- packages | wc -l` prints 0 once tickets 03–05 are in (baseline 59).</acceptance_criteria>
  <done>The password package has no mail helper and no `sent` read.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Gate 78 → 0; M2 5 → 0 and M3 59 → 0 with tickets 03–05; the password package's tests pass with unchanged counts.
</success_criteria>

## Comments
Result (uncommitted): AuthHttp reads the app's mailbox through `app.run` (helper `mailed`); `capturingMailer`, both `letForkedFibersRun`, `settle` gone; `flakyMailer` returns `{ layer, delivered }` (Layer.mock + SubscriptionRef); `letRetryArm` kept once. harness.ts exports no mail helper. Gate 78 -> 0; `letForkedFibersRun` in packages: 0. Whole `packages/password/test` green (180 tests). Note: `SubscriptionRef` has no `makeUnsafe` in effect 4.1.2, so `Effect.runSync(SubscriptionRef.make(...))` is used.
