---
plan: 35-test-mailbox
ticket: 01
title: "TestMailbox: record, wait, refute, read a secret"
type: tdd
wave: 1
depends_on: []
files_modified:
  - packages/test/src/TestMailbox.ts
  - packages/test/src/index.ts
  - packages/test/test/TestMailbox.test.ts
autonomous: true
requirements: [REQ-EA-1560, REQ-EA-1561]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "A mail sent by a detached fiber after a real 20 ms delay is returned by Mailbox.mail.waitFor under TestClock, with no fixed yields and no clock adjustment"
    - "waitFor dies at a real-clock deadline under TestClock, and its defect text has no recipient address"
    - "refute dies when more than `beyond` matches are recorded already or within the window, and succeeds otherwise"
    - "TestMailbox.layer's Mailer and SmsSender set development: true and record into separate outboxes"
  artifacts:
    - path: packages/test/src/TestMailbox.ts
      provides: "Mailbox, layer, secret; types Match, Outbox, MailboxShape"
      exports: [Mailbox, layer, secret]
    - path: packages/test/test/TestMailbox.test.ts
      provides: "the seven interface cases of PLAN.md §5.1"
  key_links:
    - from: packages/test/src/index.ts
      to: packages/test/src/TestMailbox.ts
      via: "export * as TestMailbox"
      pattern: "export \\* as TestMailbox"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Build the deep module the whole plan rests on: `TestMailbox` in `@awthaq/test`. It provides `Mailer` and `SmsSender` over one recording, and a `Mailbox` tag whose interface waits for a matching message by subscription with a real-clock deadline, refutes one within a real-time window, and lists what was recorded. `secret` reads a mailed value.

Purpose: the tracer. If the detached-fiber wait cannot pass without fixed yields, the plan is NO-GO (PLAN.md §1.4) and only this test is kept.
Output: `packages/test/src/TestMailbox.ts`, its export, and `packages/test/test/TestMailbox.test.ts`.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.2 interface sketch and implementation notes, §5.1 test list)
@packages/ports/src/Mailer.ts
@packages/ports/src/SmsSender.ts
@packages/test/src/RedactionGuard.ts (how this package declares a Context.Service and a layer)
@packages/test/src/index.ts
@packages/test/node_modules/effect/src/SubscriptionRef.ts (make, update, get, changes)
@packages/test/node_modules/effect/src/testing/TestClock.ts:593-595,707-708 (why withLive is not usable here)
@packages/magic-link/test/support/harness.ts:63-95 (the copies this replaces)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: red, the interface tests</name>
  <files>packages/test/test/TestMailbox.test.ts</files>
  <read_first>packages/test/test/TestAuth.test.ts (style: `@effect/vitest`, `it.effect`), packages/ports/test/Mailer.test.ts</read_first>
  <behavior>
    - Case 1: under `it.effect` (TestClock), fork a detached fiber (`Effect.forkDetach`) that awaits a real 20 ms timer (`Effect.promise` over `setTimeout`) then sends `{ to: "ada@example.com", template: "verify-email", data: { token: Redacted.make("t") } }` through `Mailer.Mailer`; `(yield* TestMailbox.Mailbox).mail.waitFor({ template: "verify-email" })` returns that message. No `yieldNow`, no `TestClock.adjust`.
    - Case 2: send `a`/x, `b`/y, `c`/x; `waitFor({ template: "x" }, { nth: 2 })` returns the third message; `waitFor((m) => m.to === "b", {})` returns the second.
    - Case 3: under `it.effect`, `waitFor({ to: "ghost@example.com", template: "never" }, { timeout: "40 millis" })` exits with a defect; `Cause.pretty` of it contains `never` and the recorded count, and does not contain `ghost@example.com`.
    - Case 4: `refute({ template: "x" }, { window: "30 millis" })` succeeds when nothing is sent; dies when an `x` mail is already recorded; dies when a detached fiber sends `x` after 5 ms of real time. With `{ beyond: 1 }` it succeeds when exactly one `x` is recorded and dies when a detached fiber sends a second `x` after 5 ms.
    - Case 5: `TestMailbox.secret(mail)` returns the unwrapped `Redacted` token; `secret(mail, "code")` returns a plain string field as is; `secret` on a mail without the field throws an `Error` whose message names the field and the template.
    - Case 6: the layer's `Mailer` and `SmsSender` both have `development === true`; an SMS sent through `SmsSender.SmsSender` is returned by `sms.waitFor({ to: "+15550100" })` and `mail.messages` stays empty.
    - Case 7: 8 concurrent sends (`Effect.forEach(..., { concurrency: "unbounded" })`); `mail.messages` has length 8 and `waitFor({}, { nth: 8 })` resolves.
  </behavior>
  <action>Write the seven cases above against `TestMailbox` imported from `../src/TestMailbox.ts`, each providing `TestMailbox.layer`. The file does not compile yet, which is the red state; run it once to record the failure. Name each `it.effect` after the behaviour (for example "waitFor returns a mail a detached fiber sends after real async work"). Do not use `yieldNow` loops anywhere in the file.</action>
  <verify><automated>MISSING — this task creates packages/test/test/TestMailbox.test.ts; run: npx vitest run packages/test/test/TestMailbox.test.ts (expected red: module not found)</automated></verify>
  <acceptance_criteria>The test file exists with 7 `it.effect` cases; the run fails only because `src/TestMailbox.ts` is missing.</acceptance_criteria>
  <done>Red recorded.</done>
</task>

<task type="tdd">
  <name>Task 2: green, the module</name>
  <files>packages/test/src/TestMailbox.ts</files>
  <read_first>PLAN.md §3.2; packages/ports/src/Mailer.ts:42-81; packages/ports/src/SmsSender.ts:29-63</read_first>
  <action>Create `TestMailbox.ts` with a header comment citing BEH-EA-359 and ADR-EA-054. Export the type `Match<M>` (an object with optional `to` and `template`, or a predicate), the interface `Outbox<M>` with `messages`, `waitFor(match, { nth?, timeout? })` and `refute(match, { beyond?, window? })`, the interface `MailboxShape` with `mail` and `sms` outboxes, and `class Mailbox extends Context.Service<Mailbox, MailboxShape>()("awthaq/test/Mailbox")`. Build one private generic outbox maker over `SubscriptionRef.make<ReadonlyArray<M>>([])` that returns the `Outbox` and a `record` function (`SubscriptionRef.update` appending). `waitFor` streams `SubscriptionRef.changes`, maps each snapshot to its nth match (nth defaults to 1, counted over matching messages only), takes the first defined value, and races it with `Effect.raceFirst` against a real deadline built with `Effect.callback` over `setTimeout`, whose cleanup calls `clearTimeout`; the deadline dies with an `Error` whose text names the template the match asked for (or "a predicate"), whether a recipient was set (never its value), nth, and how many messages were recorded. Default timeout 5 seconds, default window 50 milliseconds; convert a `Duration.Input` to milliseconds with `Duration.toMillis` (in 4.1.2 it takes a `Duration.Input` directly, `effect/src/Duration.ts:891`). Stream helpers: `Stream.filterMap` (`effect/src/Stream.ts:6434`) and `Stream.runHead` (`:19675`). Do NOT use `Clock`, `Effect.sleep`, `Effect.timeout` or `TestClock.withLive`: suites run under `TestClock`, and `withLive` casts the ambient clock and breaks outside it. `refute` races the same stream (a snapshot holding more than `beyond` matches, default 0, dies naming the template and the count) against a real `window` timer that succeeds with void. `layer` is one `Layer.effectContext` that builds the two outboxes and returns a `Context` holding `Mailer.Mailer` (send records; `development: true`; and, until ticket 17, `sent` returning `messages`, because `MailerShape` still requires it), `SmsSender.SmsSender` (the same) and `Mailbox`. `secret(message, field = "token")` returns `String(Redacted.value(value))` for a `Redacted` value (narrowed with `Redacted.isRedacted`, as `features/step-definitions/MailedToken.ts` does), the value itself for a string, and otherwise throws an `Error` naming the field and `message.template`. No `as`, no return-type annotations on the Effect and Layer consts.</action>
  <verify><automated>npx vitest run packages/test/test/TestMailbox.test.ts</automated></verify>
  <acceptance_criteria>All 7 cases pass. `git grep -nE 'yieldNow|Clock\.|Effect\.sleep|Effect\.timeout|withLive' -- packages/test/src/TestMailbox.ts | wc -l` prints 0 (baseline: file absent). `git grep -n ' as ' -- packages/test/src/TestMailbox.ts | grep -v '^.*//' | wc -l` prints 0.</acceptance_criteria>
  <done>The mailbox passes its own suite under TestClock.</done>
</task>

<task type="auto">
  <name>Task 3: export and gates</name>
  <files>packages/test/src/index.ts</files>
  <action>Add `export * as TestMailbox from "./TestMailbox.ts";` beside the other exports and mention `TestMailbox` in the file's header comment. Run the package gates; if knip reports `Match`, `Outbox` or `MailboxShape` as unused exports, keep them exported only if a public signature names them, otherwise make them module-private.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/test/test/TestMailbox.test.ts && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>`git grep -n 'export \* as TestMailbox' -- packages/test/src/index.ts | wc -l` prints 1 (baseline 0).</acceptance_criteria>
  <done>`import { TestMailbox } from "@awthaq/test"` type-checks.</done>
</task>
</tasks>

<threat_model>
| Crossing | Description |
|---|---|
| test output | defect text from a failed wait lands in CI logs |

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-35-01 | I (information disclosure) | `waitFor`/`refute` defect text | low | mitigate | The text names template, nth and count only; case 3 asserts the recipient is absent (EOTS-010 discipline, also in tests) |
| T-35-02 | E (elevation) | `@awthaq/test` reached from library `src` | low | mitigate | Existing `pnpm check:contract-tests` fails a library `src` import of `@awthaq/test` (BEH-EA-336); the `Mailbox` key is `awthaq/test/...`, not a port |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
(`pnpm knip` noise limited to `.reports/` is pre-existing, `.planning/IMPLEMENTING.md`.)
</verification>

<success_criteria>
7/7 cases green; zero fixed-yield, Clock or sleep use in `TestMailbox.ts`; the GO/NO-GO tracer (case 1) passes.
</success_criteria>

## Comments
- Result: BEH-EA-354 (not 359: the catalog ended at 353). Waited by subscription (PubSub.subscribe then read), real-clock deadline; 7 cases pass.
