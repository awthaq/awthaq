---
plan: 35-test-mailbox
ticket: 05
title: "password domain suites read the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - packages/password/test/Password.test.ts
  - packages/password/test/PasswordRecovery.test.ts
  - packages/password/test/PasswordStoreOutage.test.ts
  - packages/password/test/PasswordRateLimitBehaviour.test.ts
  - packages/password/test/PasswordHooksBeforeCredentialReset.test.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: L}
must_haves:
  truths:
    - "No password domain suite yields a fixed number of turns to wait for mail"
    - "PasswordStoreOutage's memory and SQL halves wait for mail the same way, by subscription"
    - "The never-answering mailer of the TSS-001/TSS-002 tests is Layer.mock(Mailer.Mailer)({ send })"
  artifacts:
    - path: packages/password/test/Password.test.ts
      provides: "the suite without its own letForkedFibersRun"
  key_links:
    - from: packages/password/test/Password.test.ts
      to: TestMailbox.Mailbox
      via: "waitFor / refute"
      pattern: "TestMailbox\\.Mailbox"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Move the five domain suites of `@awthaq/password` off `mailer.sent`, `letForkedFibersRun` and `tokenOf` onto `TestMailbox`. They stop importing those two helpers from `./harness.ts` (ticket 06 deletes them there).

Purpose: the 44 fixed waits in this package are the largest copy of the latent race (PLAN.md §2.6 item 1); this ticket removes the domain half.
Output: five test files. `packages/password/src` is not touched.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@packages/password/test/harness.ts:50-62 (letForkedFibersRun, tokenOf: still exported until ticket 06)
@packages/password/test/Password.test.ts:30-90,105-120,470-495,560-615,650-700,1078-1090,1135-1140
@packages/password/test/PasswordRecovery.test.ts:12-30,130-136
@packages/password/test/PasswordStoreOutage.test.ts:10-20,50-60,140-170
@packages/password/src/Password.ts:850-904 (requestReset: the event is emitted inside the dispatched fiber, before the mail)
</context>

<tasks>
<task type="auto">
  <name>Task 1: Password.test.ts</name>
  <files>packages/password/test/Password.test.ts</files>
  <read_first>packages/password/src/Password.ts:850-904</read_first>
  <action>Delete the file's own `letForkedFibersRun` (`:61-63`). `HangingMailerLayer` (`:34-37`) becomes `Layer.mock(Mailer.Mailer)({ send: () => Effect.never })`; drop its `Layer.Layer<Mailer.Mailer>` annotation if the inferred type serves, and fix the comment at `:33` that names `Mailer.layerMemory` (say "the base `TestMailbox` recording"). `signUpAndVerify` (`:71-73`) loses its `mailer: Mailer.MailerShape` parameter and reads `yield* TestMailbox.Mailbox` itself; update its callers. Each "yields then `mailer.sent` then find/findLast" becomes `box.mail.waitFor({ to, template })` (or `{ template }` where the old code did not filter by address); where the same template was already sent to the same address earlier in the test, pass `nth` = matching messages before the trigger + 1. Each "yields then assert a count of N" becomes `waitFor(match, { nth: N })` (skip when N is 0) followed by `refute(match, { beyond: N })` (`:114-116`, `:565-590`, `:602-612`, `:1082-1084`, `:1137-1138`). `tokenOf(mail)` becomes `TestMailbox.secret(mail)`. The two audit waits at `:483` and `:490` are not mail: at `:483` (`requestReset` for an unknown address) nothing is dispatched (`Password.ts:866`), so drop the wait; at `:490` wait for the reset mail to `email` (the `resetRequested` event is emitted earlier in the same dispatched fiber, `Password.ts:876-878`) and then read the audit log. If the `:492` assertion then fails, the audit write is not inside that fiber: stop and record it in `## Comments` rather than reintroduce yields. Keep `Effect.yieldNow` at `:274` (it orders an event subscription, not mail). Keep every `Redacted.isRedacted` assertion on mailed data.</action>
  <verify><automated>npx vitest run packages/password/test/Password.test.ts</automated></verify>
  <acceptance_criteria>Same test count as at HEAD (41 `it.*(` cases); all pass. `git grep -nE 'letForkedFibersRun|\.sent([^A-Za-z]|$)|(^|[^A-Za-z])sent: |MailerShape|tokenOf' -- packages/password/test/Password.test.ts | wc -l` prints 0.</acceptance_criteria>
  <done>The suite has no fixed mail wait and no `sent` read.</done>
</task>

<task type="auto">
  <name>Task 2: the four smaller suites</name>
  <files>packages/password/test/PasswordRecovery.test.ts, packages/password/test/PasswordStoreOutage.test.ts, packages/password/test/PasswordRateLimitBehaviour.test.ts, packages/password/test/PasswordHooksBeforeCredentialReset.test.ts</files>
  <action>`PasswordRecovery.test.ts`: delete the local `mailedToken(mailer, template)` (`:22-28`); its call sites (`:39`, `:71`, `:179`) read `Redacted.make(TestMailbox.secret(yield* box.mail.waitFor({ template: "reset-password" }, { nth })))`, with `nth` counted as in task 1 (a test that requests twice wants the second). Name a helper, if one is still worth having, `resetTokenFor` (the gate counts `mailedToken`). `:133-134` becomes `waitFor`/`refute`. `PasswordStoreOutage.test.ts`: `registered` (`:51-59`) waits for its verify mail with `waitFor({ to, template: "verify-email" })` (the old code used `find`, the first: `nth` 1); delete the SQL half's 200 × `Effect.sleep(10 ms)` poller `mailedToken` (`:143-152`) and use the same `waitFor` (it already runs `it.live`; the mailbox's deadline is real time either way). Do not edit `scripts/test-pg.sh` (plan 37 owns it); the file stays listed there. `PasswordRateLimitBehaviour.test.ts:48-51` and `PasswordHooksBeforeCredentialReset.test.ts:52-58`: `waitFor` per template, `TestMailbox.secret`. In all four, remove `letForkedFibersRun` and `tokenOf` from the `./harness.ts` import and drop `Mailer` imports that become unused.</action>
  <verify><automated>npx vitest run packages/password/test/PasswordRecovery.test.ts packages/password/test/PasswordStoreOutage.test.ts packages/password/test/PasswordRateLimitBehaviour.test.ts packages/password/test/PasswordHooksBeforeCredentialReset.test.ts</automated></verify>
  <acceptance_criteria>All four pass with their HEAD test counts. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|letForkedFibersRun|tokenOf|mailedToken|MailerShape' -- packages/password/test/Password.test.ts packages/password/test/PasswordRecovery.test.ts packages/password/test/PasswordStoreOutage.test.ts packages/password/test/PasswordRateLimitBehaviour.test.ts packages/password/test/PasswordHooksBeforeCredentialReset.test.ts | wc -l` prints 0 (baseline at 04fa3526: 74).</acceptance_criteria>
  <done>The password domain half reads the mailbox; the SQL poller is gone.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
(`harness.ts` still exports `letForkedFibersRun`/`tokenOf` for ticket 06's files; knip stays green because those files import them.)
</verification>

<success_criteria>
Gate 74 → 0; one poller (`PasswordStoreOutage` SQL) and one `letForkedFibersRun` definition deleted; test counts unchanged.
</success_criteria>

## Comments
Result (uncommitted): five suites read the mailbox; `letForkedFibersRun`/`tokenOf`/`mailedToken`(local)/SQL poller gone; `HangingMailerLayer` is `Layer.mock`. Gate 74 -> 0, `npx vitest run` on the five files green, counts unchanged. The `:490` audit wait became a wait for the reset mail and the audit assertion held. Local `mailedToken` variable names in Password.test.ts renamed `resetToken` to satisfy the gate.
